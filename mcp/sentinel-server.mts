#!/usr/bin/env -S npx tsx
/**
 * Sentinel as an MCP server: the confidential aggregate, interrogable in natural language.
 *
 * This is the interactive half of Phase 7. `scripts/agent-ask.mts` routes questions
 * deterministically so the committed transcript is reproducible; here the model does the
 * routing, from the tool descriptions in `lib/agent/tools.ts`, and the same tool code
 * answers. Both paths share every line that touches data, which is the only way the
 * transcript is evidence about this server rather than about a script that resembles it.
 *
 * Two design decisions worth stating, because they are the ones a reviewer should push on:
 *
 *   **The session pins a block.** The first tool call opens a context — the enclave's
 *   three-pass query plan at one block, plus the same plan a week earlier for the alert
 *   policy's control — and later calls reuse it until it ages past `CONTEXT_TTL_MS`. So
 *   two answers in a conversation cannot describe two different worlds, and the Graph
 *   query budget is spent once rather than per question.
 *
 *   **The model never gets raw per-address rows.** Every tool returns aggregates with
 *   citations, and `sentinel_query_subgraph` refuses documents that select positions or
 *   accounts. A language model with a per-address leverage map in its context has that map
 *   in whatever it writes next, and that map is precisely the harm Sentinel exists to
 *   avoid publishing — a hunting list for liquidation bots and a deanonymisation aid. The
 *   aggregation happens in the TEE; the agent consumes what the TEE published.
 *
 * Register it with Claude Code (no API cost — it runs against an existing subscription):
 *
 *   claude mcp add sentinel -- npx tsx /absolute/path/to/mcp/sentinel-server.mts
 *
 * It needs `GRAPH_API_KEY` and `SENTINEL_RISK_POLICY` in `.env.local`, both gitignored.
 */

import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolved from this file rather than the cwd: an MCP client starts the server from
// wherever it happens to be, and a policy that silently failed to load would produce a
// server that answers with no data.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(ROOT, ".env.local"), quiet: true });

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { DEPLOYMENTS, type Deployment } from "../lib/graph/deployments";
import type { SamplingConfig } from "../lib/backtest/replay-signal";
import { openContext, type SentinelContext } from "../lib/agent/context";
import { renderCitations } from "../lib/agent/provenance";
import { TOOLS, toolByName } from "../lib/agent/tools";

/**
 * How long a pinned context is reused.
 *
 * Five minutes, against a staleness gate of about an hour: well inside it, so a cached
 * context can never be the reason an alert is refused, while still cheap enough that a
 * long conversation does not re-run the query plan on every question.
 */
const CONTEXT_TTL_MS = 5 * 60 * 1000;

const enclaveConfig = JSON.parse(
  readFileSync(resolve(ROOT, "cre/sentinel-signal/config.staging.json"), "utf8"),
) as SamplingConfig & { deployments: { key: string }[] };

const deployments: Deployment[] = enclaveConfig.deployments
  .map((d) => DEPLOYMENTS.find((k) => k.key === d.key))
  .filter((d): d is Deployment => d !== undefined);

const alertPolicyJson = readFileSync(
  resolve(ROOT, "docs/evidence/phase6-alert-policy.json"),
  "utf8",
);

let cached: { ctx: SentinelContext; at: number } | null = null;
let inFlight: Promise<SentinelContext> | null = null;

async function context(): Promise<SentinelContext> {
  if (cached && Date.now() - cached.at < CONTEXT_TTL_MS) return cached.ctx;
  // Concurrent tool calls must not each open their own context: that would spend the
  // query budget several times over and, worse, answer two questions at two blocks.
  if (inFlight) return inFlight;

  const policyJson = process.env.SENTINEL_RISK_POLICY;
  if (!policyJson) {
    throw new Error(
      "SENTINEL_RISK_POLICY is not set. The risk policy is a Vault DON secret in " +
        "production and a gitignored local value in development; there is no default, " +
        "because a default would publish a signal under weights nobody chose.",
    );
  }

  inFlight = openContext({
    sampling: enclaveConfig,
    riskPolicyJson: policyJson,
    alertPolicyJson,
    deployments,
    withControl: true,
    // stderr, never stdout: stdout is the JSON-RPC channel and a stray log corrupts it.
    onProgress: (m) => process.stderr.write(`[sentinel] ${m}\n`),
  })
    .then((ctx) => {
      cached = { ctx, at: Date.now() };
      return ctx;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

const server = new Server(
  { name: "sentinel", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = toolByName(request.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: `no such tool: ${request.params.name}` }],
    };
  }

  try {
    const ctx = await context();
    const result = await tool.run(ctx, request.params.arguments ?? {});

    // The citation table is part of the tool result, not a nicety: the model is expected
    // to relay it, and `docs/evidence/phase7-transcript.md` is the record of it doing so.
    const parts = [result.answer];
    for (const v of result.verbatim ?? []) parts.push("```\n" + v + "\n```");
    if (result.cited.length > 0) parts.push(renderCitations(result.cited));
    parts.push(
      `_Session pinned at block ${ctx.block} (head ${ctx.head} when opened). Every figure ` +
        `above is a subgraph read at a stated block; nothing is estimated._`,
    );

    return {
      content: [{ type: "text" as const, text: parts.join("\n\n") }],
      // A refusal is a legitimate result and must not be reported as a transport error,
      // or a client would retry it.
      isError: false,
    };
  } catch (err) {
    // Deliberately not the gateway URL, ever: it embeds the API key as a path segment.
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text:
            `${message}\n\nSentinel answers only from live subgraph reads. It has no cached ` +
            `or synthetic fallback, so a failed read is reported rather than answered around.`,
        },
      ],
    };
  }
});

await server.connect(new StdioServerTransport());
process.stderr.write(
  `[sentinel] MCP server ready: ${TOOLS.length} tools, ${deployments.length} deployments\n`,
);
