/**
 * Speak MCP to Sentinel's server over a pipe, and record the wire log.
 *
 * The transcript in `docs/evidence/phase7-transcript.md` proves the tools answer. This
 * proves the *server* answers: a real client process, a real stdio transport, a real
 * `initialize` / `tools/list` / `tools/call` sequence, with the raw JSON-RPC frames kept.
 * Without it, "there is an MCP server" would rest on the file existing.
 *
 *   npm run mcp:handshake
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const LOG = "docs/evidence/phase7-mcp-handshake.log";
/** The tool exercised end to end. Chosen because it is the one with a policy behind it. */
const CALL = "sentinel_alert";
const TIMEOUT_MS = 180_000;

const log: string[] = [];
const record = (dir: "->" | "<-" | "##", text: string) => {
  log.push(`${dir} ${text}`);
  process.stdout.write(`${dir} ${text.slice(0, 200)}\n`);
};

const child = spawn("npx", ["tsx", "mcp/sentinel-server.mts"], {
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (d: Buffer) => {
  for (const line of d.toString().trimEnd().split("\n")) record("##", line);
});

const send = (frame: unknown) => {
  const text = JSON.stringify(frame);
  record("->", text);
  child.stdin.write(`${text}\n`);
};

const pending = new Map<number, (frame: Record<string, unknown>) => void>();
let buffer = "";
child.stdout.on("data", (d: Buffer) => {
  buffer += d.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    record("<-", line);
    const frame = JSON.parse(line) as Record<string, unknown>;
    const id = frame.id as number | undefined;
    if (typeof id === "number" && pending.has(id)) {
      pending.get(id)!(frame);
      pending.delete(id);
    }
  }
});

function request(id: number, method: string, params: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), TIMEOUT_MS);
    pending.set(id, (frame) => {
      clearTimeout(timer);
      resolve(frame);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

let failure: string | null = null;
try {
  const init = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sentinel-handshake", version: "0.1.0" },
  });
  const serverInfo = (init.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo;
  if (serverInfo?.name !== "sentinel") throw new Error("server did not identify as sentinel");

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await request(2, "tools/list", {});
  const tools = (list.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
  if (tools.length === 0) throw new Error("tools/list returned nothing");
  if (!tools.some((t) => t.name === CALL)) throw new Error(`tools/list omits ${CALL}`);

  const call = await request(3, "tools/call", { name: CALL, arguments: {} });
  const content = (call.result as { content?: { text?: string }[] } | undefined)?.content ?? [];
  const text = content.map((c) => c.text ?? "").join("\n");
  if (!text.includes("| number | value | subgraph | block |") && !text.includes("refuses")) {
    // Either it answered with citations, or it refused. Anything else is a bare assertion.
    throw new Error("tool result carried neither a citation table nor a refusal");
  }

  record("##", `handshake ok: ${tools.length} tools, ${CALL} answered ${text.length} chars`);
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
  record("##", `handshake FAILED: ${failure}`);
} finally {
  child.kill();
}

mkdirSync("docs/evidence", { recursive: true });
writeFileSync(
  LOG,
  [
    `# Sentinel MCP server handshake — ${new Date().toISOString()}`,
    `# Written by scripts/mcp-handshake.mts. '->' is client to server, '<-' server to`,
    `# client, '##' the server's own stderr. Raw frames, unedited.`,
    "",
    ...log,
    "",
  ].join("\n"),
);
console.log(`\nwrote ${LOG}`);
process.exit(failure ? 1 : 0);
