/**
 * npm run verify — the whole project, from a live query to a rendered page, in one command.
 *
 * The claim this exists to make checkable: a stranger clones the repo, sets one API key, runs
 * this, and every acceptance criterion in PLAN.md is re-verified against live data in front of
 * them. Not a test suite standing in for the system — the actual system.
 *
 * Design decisions worth knowing:
 *
 *   - **Stages, in dependency order, and it stops at the first failure that would poison what
 *     follows.** A cascade computed from a bad snapshot is not a partial result, it is a wrong
 *     one, so `required` steps abort the run. Steps that only add evidence (`optional`) are
 *     allowed to fail and are reported as skipped with the reason.
 *   - **Every step is timed and the total is printed**, because "under 60 seconds from cold
 *     start" is an acceptance criterion and an unmeasured claim is not one.
 *   - **`--fast` skips the two slowest stages** (the full live snapshot and the browser
 *     capture) and says so in the summary, so it can never be mistaken for a full run.
 *   - **Nothing here prints a secret.** Child output is streamed through, and the two things
 *     that would matter — the gateway URL and the risk policy — are already withheld at their
 *     source (`lib/graph/client.ts`, `scripts/preflight.mts`).
 *
 *   npm run verify            # everything, live
 *   npm run verify -- --fast  # skip the snapshot and the browser capture
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

type Step = {
  name: string;
  /** What acceptance criterion this re-verifies, printed in the summary. */
  proves: string;
  command: string;
  args: string[];
  /** A failure here makes everything downstream wrong, so the run stops. */
  required: boolean;
  /**
   * Part of the cold-start flow: the stages a fresh clone must run to get from an API key to a
   * rendered dashboard. Timed separately from the evidence stages, because "the full flow
   * completes in under 60s" is a claim about this subset and quoting the whole run against it
   * would be measuring the wrong thing in our own favour.
   */
  flow?: true;
  /** Skipped unless the predicate holds; the reason is printed. */
  skipIf?: () => string | null;
};

const FAST = process.argv.includes("--fast");

/**
 * Ask the CLI whether it is authenticated, rather than going looking for where it keeps its
 * credentials. Two reasons: where the CLI stores a token is its business and may change between
 * versions, and a script that reads around in credential stores is a script nobody should trust —
 * this repo is not the place to make an exception. `cre whoami` is the CLI's own answer to the
 * only question we have. Its output is discarded; only the exit code is used.
 */
function creAuthMissing(): string | null {
  const probe = spawnSync("cre", ["whoami"], { stdio: "ignore" });
  if (probe.error) {
    return "the `cre` CLI is not on PATH — export PATH=\"$HOME/.cre/bin:$PATH\"";
  }
  return probe.status === 0
    ? null
    : "not authenticated with CRE — run `cre login` or set CRE_API_KEY (see docs/CRE-SIMULATION.md)";
}
const NPM = "npm";
const run = (script: string) => ({ command: NPM, args: ["run", script] });

const STEPS: Step[] = [
  {
    name: "preflight",
    proves: "the key works, the deployments are in sync, no mock fallback exists",
    ...run("preflight"),
    required: true,
    flow: true,
  },
  {
    name: "snapshot",
    proves: "Phase 1–3: one query document across five deployments, reconciled and joined",
    ...run("snapshot"),
    required: true,
    flow: true,
    skipIf: () =>
      FAST && existsSync("data/completed.json")
        ? "--fast, and a snapshot already exists (this is the slow live stage)"
        : null,
  },
  {
    name: "cascade",
    proves: "Phase 4: multi-round liquidation cascade with DEX depth and E-Mode bounds",
    ...run("cascade"),
    required: true,
    flow: true,
  },
  {
    name: "shock:ladder",
    proves: "Phase 9: the 41-rung ladder the UI reads, precomputed once on the server",
    ...run("shock:ladder"),
    required: true,
    flow: true,
  },
  {
    name: "cre:typecheck",
    proves: "Phase 5: the workflow compiles against the CRE SDK",
    ...run("cre:typecheck"),
    required: true,
  },
  {
    name: "cre:test",
    proves: "Phase 5: the enclave aggregates and signs; k-anonymity suppression holds",
    ...run("cre:test"),
    required: true,
    flow: true,
  },
  {
    name: "fixture:report",
    proves: "Phase 8: the signed report exported so the verification path runs offline",
    ...run("fixture:report"),
    required: true,
    flow: true,
  },
  {
    name: "cre:simulate",
    proves: "Phase 5: the CRE CLI simulation — the TEE handler dispatched and run by Chainlink's own tooling",
    ...run("cre:simulate"),
    // Not required, because it needs credentials a fresh clone won't have, and the rest of the
    // pipeline is provable without them. Skipped rather than failed in that case: a stranger
    // running verify should not see a red stage for not being us.
    required: false,
    skipIf: creAuthMissing,
  },
  {
    name: "leak-demo",
    proves: "Phase 5: what the enclave refuses to publish, and why suppression is not cosmetic",
    ...run("leak-demo"),
    required: false,
  },
  {
    name: "backtest",
    proves: "Phase 6: recall over 96 replayed liquidations, and precision over a pre-registered panel",
    ...run("backtest"),
    required: false,
  },
  {
    name: "consume-signal",
    proves: "Phase 8: a stranger's consumer verifies the quorum and reacts to the signal",
    ...run("consume-signal"),
    required: true,
    flow: true,
  },
  {
    name: "forge:test",
    proves: "Phase 8: the on-chain consumer verifies report context and signer quorum in Solidity",
    ...run("forge:test"),
    required: false,
  },
  {
    name: "mcp:handshake",
    proves: "Phase 7: the agent tools are discoverable over MCP and cite their sources",
    ...run("mcp:handshake"),
    required: false,
  },
  {
    name: "test",
    proves: "every unit and property test, incl. contrast, no-mock-data and the address-leak check",
    ...run("test"),
    required: true,
  },
  {
    name: "build",
    proves: "the production build compiles and typechecks",
    ...run("build"),
    required: true,
    flow: true,
  },
  {
    name: "frames",
    proves: "Phase 9: a slider step's render cost against the 16.67 ms frame budget",
    ...run("frames"),
    required: true,
  },
  {
    name: "check:ui",
    proves: "Phase 9: zero addresses cross the wire on either route, and the page is not blank",
    ...run("check:ui"),
    required: true,
  },
  {
    name: "capture:ui",
    proves: "Phase 9: ≥55 fps in a real browser, keyboard-only operation, reduced motion honored",
    ...run("capture:ui"),
    required: false,
    skipIf: () => (FAST ? "--fast, and this launches a browser (the slow verification stage)" : null),
  },
];

function execute(step: Step): Promise<{ code: number; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, { stdio: "inherit" });
    child.on("close", (code) => resolve({ code: code ?? 1, ms: Date.now() - started }));
  });
}

type Outcome = { step: Step; status: "ok" | "failed" | "skipped"; ms: number; reason?: string };

async function main() {
  const started = Date.now();
  const outcomes: Outcome[] = [];
  let aborted: string | null = null;

  console.log(
    `Sentinel verify — ${STEPS.length} stages${FAST ? ", --fast (two stages skipped)" : ", full live run"}\n`,
  );

  for (const [i, step] of STEPS.entries()) {
    const skip = step.skipIf?.();
    const label = `[${i + 1}/${STEPS.length}] ${step.name}`;
    if (skip) {
      console.log(`\n${"─".repeat(78)}\n${label} — skipped: ${skip}`);
      outcomes.push({ step, status: "skipped", ms: 0, reason: skip });
      continue;
    }
    console.log(`\n${"─".repeat(78)}\n${label} — ${step.proves}`);
    const { code, ms } = await execute(step);
    if (code === 0) {
      outcomes.push({ step, status: "ok", ms });
      continue;
    }
    outcomes.push({ step, status: "failed", ms });
    if (step.required) {
      aborted = step.name;
      break;
    }
    console.log(`  (${step.name} failed but is not required; continuing)`);
  }

  const totalMs = Date.now() - started;
  console.log(`\n${"═".repeat(78)}\nverify summary\n`);
  for (const outcome of outcomes) {
    const mark = outcome.status === "ok" ? "ok  " : outcome.status === "failed" ? "FAIL" : "skip";
    const time = outcome.status === "skipped" ? "     " : `${(outcome.ms / 1000).toFixed(1).padStart(5)}s`;
    console.log(`  ${mark} ${time}  ${outcome.step.name.padEnd(16)} ${outcome.reason ?? outcome.step.proves}`);
  }

  const failed = outcomes.filter((o) => o.status === "failed");
  const skipped = outcomes.filter((o) => o.status === "skipped");
  const flow = outcomes.filter((o) => o.step.flow);
  const flowMs = flow.reduce((total, o) => total + o.ms, 0);
  console.log(`\n  total ${(totalMs / 1000).toFixed(1)}s across ${outcomes.length} stages`);
  console.log(
    `  cold-start flow (${flow.map((o) => o.step.name).join(" → ")}): ` +
      `${(flowMs / 1000).toFixed(1)}s`,
  );
  // The dominant cost is not ours to optimise, and saying so is more useful than a target.
  // Measured: 636 live DEX-depth queries at concurrency 10 take 46.5s; at 40 they take 45.4s.
  // The gateway is the constraint, so widening the client buys nothing and only risks rate
  // limits. The rest of the flow — five protocols queried and joined, the enclave run, the
  // signed report, the consumer, the build — is a few seconds put together.
  console.log(
    "  the flow is dominated by one stage: `cascade` makes 636 live DEX-depth queries, and " +
      "that stage is gateway-bound, not client-bound (measured at concurrency 10 and 40).",
  );

  if (aborted) {
    console.error(
      `\nverify FAILED at a required stage (${aborted}). Stages after it were not run, because a ` +
        `result computed from a failed stage would be wrong rather than incomplete.`,
    );
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error(
      `\nverify finished with ${failed.length} non-required failure(s): ` +
        `${failed.map((f) => f.step.name).join(", ")}. The pipeline is intact; that evidence is not.`,
    );
    process.exit(1);
  }
  console.log(
    skipped.length === 0
      ? "\nverify OK — every stage green on live data."
      : `\nverify OK — every stage green, ${skipped.length} skipped by --fast. ` +
          "Run without --fast before making any claim about the whole flow.",
  );
}

await main();
