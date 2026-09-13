/**
 * npm run cre:simulate — the CRE CLI simulation, with the log redacted as part of the run.
 *
 * Why this wrapper exists instead of a documented `cre workflow simulate | sed` incantation:
 *
 *   **With `-g`, the CRE engine logs full outbound request URLs, and the Graph gateway embeds the
 *   API key as a path segment.** The first raw log we produced contained the live key 28 times. A
 *   redaction step that a human has to remember is a redaction step that eventually doesn't
 *   happen, and the failure mode is a committed secret — which is a poor look for a project whose
 *   entire thesis is that some values must not be published.
 *
 * So the redaction is not advice, it is the only path. The raw stream is never written to disk;
 * it is redacted in memory and only the redacted form reaches `docs/evidence/cre-simulation.log`
 * and this process's stdout.
 *
 * Redaction is by pattern, not by comparison against the known key, because the point is to
 * survive a key we have never seen — a fresh clone with someone else's credentials must be just
 * as safe as ours. The patterns live in `scripts/lib/redact.mts`, shared with the video recorder,
 * which has exactly the same problem for exactly the same reason.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { countSecretSurvivors, redact } from "./lib/redact.mts";

const OUT = resolve("docs/evidence/cre-simulation.log");

/**
 * Guard against redacting into a false sense of safety: if a 32-hex token survives anywhere in
 * the output, the file is not written at all. Failing loudly beats shipping a log we believe is
 * clean. (Binary and config hashes in the CLI banner are 64-hex, so they are unaffected.)
 */
function assertClean(text: string): void {
  const survivors = countSecretSurvivors(text);
  if (survivors > 0) {
    console.error(
      `\nrefusing to write ${OUT}: ${survivors} 32-hex token(s) survived redaction.\n` +
        `The log is discarded rather than written, because a log we wrongly believe is clean is\n` +
        `worse than no log. Widen redact() in scripts/lib/redact.mts and re-run.`,
    );
    process.exit(1);
  }
}

const args = ["workflow", "simulate", "./sentinel-signal", "--target", "staging-settings", "-g"];

console.log(`$ cre ${args.join(" ")}\n  (output redacted in-flight; raw stream never touches disk)\n`);

const child = spawn("cre", args, {
  cwd: resolve("cre"),
  stdio: ["inherit", "pipe", "pipe"],
});

let captured = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk: Buffer) => {
    const text = redact(chunk.toString());
    captured += text;
    process.stdout.write(text);
  });
}

child.on("error", (err) => {
  console.error(
    `\ncould not run \`cre\`: ${err.message}\n` +
      `  the CLI lives in ~/.cre/bin — export PATH="$HOME/.cre/bin:$PATH"`,
  );
  process.exit(1);
});

child.on("close", (code) => {
  assertClean(captured);
  writeFileSync(OUT, captured);
  console.log(`\n${"═".repeat(78)}`);
  console.log(`transcript written to ${OUT} (redacted, verified free of 32-hex tokens)`);
  if (code !== 0) {
    console.error(
      `\ncre workflow simulate exited ${code}. If this is an auth failure, run \`cre login\` — ` +
        `see docs/CRE-SIMULATION.md.`,
    );
  }
  process.exit(code ?? 1);
});
