/**
 * Natural language to a tool call, deterministically.
 *
 * There are two ways to drive these tools. In a session, Claude Code reads the MCP tool
 * descriptions and chooses; that is the interactive product and it is what `SKILL.md`
 * documents. This router is the other way, and it exists for one reason: the committed
 * transcript in `docs/evidence/phase7-transcript.md` has to be reproducible. A transcript
 * whose routing came from a model is a record of one sampling run, and re-running it a
 * week later would produce different prose and possibly different tools, so it could not
 * be tested and it could not be checked by a reviewer.
 *
 * So routing here is keyword scoring over an ordered rule set. It is not the clever part
 * and it is not pretending to be: the reasoning that matters lives in the tools, which
 * compute over live subgraph reads, and in the alert policy, which was calibrated against
 * replayed history in Phase 6. What this file guarantees is that a question maps to the
 * same tool every time, so the evidence file means something.
 *
 * Out-of-scope questions route nowhere and are refused. That is deliberate: "will ETH go
 * up tomorrow" has an answer shape a language model can produce fluently and Sentinel has
 * no data for, and the failure mode of this whole category of product is answering it.
 */

import { toolByName, type Tool, type ToolResult } from "./tools";
import type { SentinelContext } from "./context";

export type Route = {
  tool: Tool;
  args: Record<string, unknown>;
  /** The words that selected it, so a transcript shows why this tool and not another. */
  matched: string[];
};

type Rule = {
  tool: string;
  /** Any of these phrases scores a point. Lowercase; matched as substrings. */
  keywords: string[];
  /** Required for the rule to apply at all, e.g. a shock question needs a percentage. */
  requires?: RegExp;
  args?: (question: string) => Record<string, unknown>;
};

/**
 * Ordered by specificity, not by preference. Ties break toward the earlier rule, so the
 * narrow rules (a raw subgraph query, a calibration question) sit above the broad ones.
 */
const RULES: Rule[] = [
  {
    tool: "sentinel_alert_calibration",
    keywords: [
      "threshold",
      "calibrat",
      "false alarm",
      "false positive",
      "how did you choose",
      "where does the alert",
      "lead time",
      "backtest",
    ],
  },
  {
    tool: "sentinel_query_subgraph",
    keywords: [
      "raw",
      "graphql",
      "subgraph directly",
      "query the subgraph",
      "total borrow",
      "reports for itself",
      "addresses",
      "which accounts",
      "who is levered",
      "list the borrowers",
      "per-address",
      "wallet",
    ],
    args: (question) => ({
      deployment: /compound\s*v?3/i.test(question)
        ? "compound-v3-eth"
        : /compound/i.test(question)
          ? "compound-v2-eth"
          : /morpho/i.test(question)
            ? "morpho-aave-v2-eth"
            : /aave\s*v?2/i.test(question)
              ? "aave-v2-eth"
              : "aave-v3-eth",
      // Per-address phrasings deliberately produce the document that gets refused, rather
      // than being quietly rewritten into an aggregate. The refusal is the answer.
      document: /address|account|borrower|who is levered|wallet|per-address/i.test(question)
        ? "{ positions(first: 10, orderBy: balance, orderDirection: desc) { account { id } balance } }"
        : "{ lendingProtocols { name totalBorrowBalanceUSD totalValueLockedUSD } _meta { block { number } } }",
    }),
  },
  {
    tool: "sentinel_shock_ladder",
    keywords: ["shock", "drops", "falls", "distress", "what happens if", "stress", "scenario"],
  },
  {
    tool: "sentinel_coupling",
    keywords: ["pair", "coupling", "shared", "both protocols", "which protocols share", "overlap"],
  },
  {
    tool: "sentinel_coverage",
    keywords: [
      "coverage",
      "how much can you see",
      "how much of the book",
      "sample",
      "blind",
      "miss",
      "e-mode",
      "emode",
      "rejected",
      "trust",
    ],
  },
  {
    tool: "sentinel_compare_protocols",
    keywords: [
      "which protocols",
      "which deployments",
      "compare",
      "per protocol",
      "what blocks",
      "which block",
      "excluded",
      "read",
    ],
  },
  {
    tool: "sentinel_alert",
    keywords: ["alert", "should i", "warn", "wake", "severity", "act now", "right now worth"],
  },
  {
    tool: "sentinel_signal",
    keywords: [
      "systemic",
      "score",
      "how much",
      "multi-protocol",
      "multi protocol",
      "cross-protocol",
      "levered across",
      "signal",
      "current risk",
    ],
  },
];

export type RoutingRefusal = {
  kind: "out-of-scope";
  reason: string;
};

/** The tool a question selects, or a refusal when nothing scores. */
export function route(question: string): Route | RoutingRefusal {
  const q = question.toLowerCase();

  let best: { rule: Rule; matched: string[] } | null = null;
  for (const rule of RULES) {
    if (rule.requires && !rule.requires.test(question)) continue;
    const matched = rule.keywords.filter((k) => q.includes(k));
    if (matched.length === 0) continue;
    if (!best || matched.length > best.matched.length) best = { rule, matched };
  }

  if (!best) {
    return {
      kind: "out-of-scope",
      reason:
        "Sentinel measures cross-protocol leverage in DeFi lending from indexed subgraph " +
        "state. It has no data bearing on this question, and answering it from a language " +
        "model's prior rather than from a read would be the failure this whole design is " +
        "built to prevent.",
    };
  }

  const tool = toolByName(best.rule.tool);
  if (!tool) throw new Error(`router names a tool that does not exist: ${best.rule.tool}`);
  return {
    tool,
    args: best.rule.args?.(question) ?? {},
    matched: best.matched,
  };
}

export type Answer = {
  question: string;
  /** Null when the question was refused before any tool ran. */
  tool: string | null;
  args: Record<string, unknown>;
  matched: string[];
  result: ToolResult;
};

export async function answer(ctx: SentinelContext, question: string): Promise<Answer> {
  const r = route(question);
  if ("kind" in r) {
    return {
      question,
      tool: null,
      args: {},
      matched: [],
      result: {
        answer: r.reason,
        cited: [],
        refusal: { gate: r.kind, reason: r.reason },
      },
    };
  }
  return {
    question,
    tool: r.tool.name,
    args: r.args,
    matched: r.matched,
    result: await r.tool.run(ctx, r.args),
  };
}
