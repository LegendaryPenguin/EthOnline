/**
 * npm run preflight — is this machine actually able to produce real numbers?
 *
 * Sentinel has no mock mode. That decision is only worth anything if a broken setup fails
 * *here*, loudly and specifically, instead of thirty seconds into a pipeline with a stack
 * trace about `undefined`. So this checks, in the order that things go wrong:
 *
 *   1. Node version, then the three toolchains this repo does not vendor (bun, forge, cre).
 *   2. `GRAPH_API_KEY` present, plausible, and *accepted by the live gateway* — a syntactically
 *      valid key that has been revoked is the failure a length check misses.
 *   3. `SENTINEL_RISK_POLICY` present and valid, reported without printing it. The policy is as
 *      sensitive as the key: publishing the leverage watch level makes the signal gameable.
 *   4. Every deployment's sync lag, so an analysis is never silently run against a subgraph
 *      that is 40,000 blocks behind head.
 *   5. Which build artifacts exist, and the exact command to produce each missing one.
 *
 * Exit code 1 on anything that would make a downstream number wrong. Warnings (a stale
 * deployment, a missing optional RPC) do not fail the run; they are printed and named.
 */

import { config } from "dotenv";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { DEPLOYMENTS } from "../lib/graph/deployments";
import { MAX_BLOCK_LAG, query, requireApiKey } from "../lib/graph/client";
import { parseRiskPolicy } from "../lib/signal/policy";

config({ path: ".env.local", quiet: true });

const problems: string[] = [];
const warnings: string[] = [];

const ok = (message: string) => console.log(`  ok    ${message}`);
const warn = (message: string) => {
  console.log(`  warn  ${message}`);
  warnings.push(message);
};
const bad = (message: string, fix: string) => {
  console.log(`  FAIL  ${message}\n        → ${fix}`);
  problems.push(message);
};

/** Artifacts, in the order the pipeline produces them. */
const ARTIFACTS: { path: string; produce: string; what: string }[] = [
  { path: "data/snapshot.json", produce: "npm run snapshot", what: "raw positions from every deployment" },
  { path: "data/completed.json", produce: "npm run snapshot", what: "the cross-protocol join" },
  { path: "data/cascade.json", produce: "npm run cascade", what: "the liquidation cascade at the report's shock" },
  { path: "data/shock-ladder.json", produce: "npm run shock:ladder", what: "the precomputed cascade ladder the UI reads" },
  // The signed report the UI verifies. Written by the enclave run and exported to a fixture
  // so the whole verification path — quorum, signatures, report context — runs offline too.
  {
    path: "contracts/test/fixtures/report.json",
    produce: "npm run cre:test && npm run fixture:report",
    what: "the signed signal report the dashboard verifies",
  },
];

function checkNode() {
  console.log("node");
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    bad(`node ${process.versions.node} is too old`, "install node 20 or newer (this repo is developed on 24)");
  } else {
    ok(`node ${process.versions.node}`);
  }
}

/**
 * The three toolchains this repo does not vendor. Found by a fresh-clone test: `npm install` does
 * not install the CRE workflow's dependencies, because that package is a bun package with its own
 * lockfile — so `cre:typecheck` failed thirty seconds in with
 * `./node_modules/.bin/tsc: No such file or directory`, which tells a stranger nothing.
 *
 * `bun` is blocking and the other two are not, and the split is the same one `verify` makes:
 * `cre:typecheck` and `cre:test` are required stages, while `cre:simulate` and `forge:test` are
 * skipped-with-a-reason when their tool is absent. A missing tool should fail where it can be
 * named, not where it happens to be dereferenced.
 */
function checkToolchain() {
  console.log("toolchain");
  const present = (bin: string, args: string[]) => spawnSync(bin, args, { stdio: "ignore" }).error === undefined;

  if (present("bun", ["--version"])) {
    ok("bun — the CRE workflow package's own toolchain (`cre:typecheck`, `cre:test`)");
  } else {
    bad(
      "bun is not on PATH — `npm install` does not install cre/sentinel-signal's dependencies, so " +
        "the two required CRE stages cannot run",
      "curl -fsSL https://bun.sh/install | bash   (then `npm run verify` installs that package itself)",
    );
  }

  if (present("forge", ["--version"])) {
    ok("forge — the Solidity consumer tests (`forge:test`)");
  } else {
    warn("forge not on PATH — `npm run forge:test` will fail and verify reports it as optional (curl -L https://foundry.paradigm.xyz | bash)");
  }

  if (present("cre", ["--version"])) {
    ok("cre — the CRE CLI (`cre:simulate`)");
  } else {
    warn('cre CLI not on PATH — the TEE simulation stage is skipped with that reason (export PATH="$HOME/.cre/bin:$PATH")');
  }
}

function checkPolicy() {
  console.log("SENTINEL_RISK_POLICY");
  const raw = process.env.SENTINEL_RISK_POLICY;
  if (!raw) {
    bad(
      "SENTINEL_RISK_POLICY is not set — the signal has no weights and no leverage watch level",
      "see .env.example for the shape; there are deliberately no defaults, because a signal " +
        "published under weights nobody chose is worse than no signal",
    );
    return;
  }
  try {
    const policy = parseRiskPolicy(raw);
    // Shapes only. The values are the confidential part and are never printed, here or in
    // any log this project writes.
    ok(
      `valid: ${policy.shocks.length} shock rungs, ${Object.keys(policy.assetBeta).length} calibrated ` +
        `assets, k-anonymity ${policy.kAnonymity}, ${Object.keys(policy.weights).length} score weights`,
    );
    ok("leverage watch level present (not printed — it is what makes the signal hard to game)");
  } catch (error) {
    bad(`SENTINEL_RISK_POLICY is invalid: ${(error as Error).message}`, "fix the JSON in .env.local; .env.example documents every field");
  }
}

async function checkKeyAndSync() {
  console.log("GRAPH_API_KEY");
  // Read through the one chokepoint rather than the environment, because
  // `lib/__tests__/no-mock-data.test.ts` enforces exactly that — and it caught this script
  // doing it the other way, which is the test doing its job.
  let key: string;
  try {
    key = requireApiKey();
  } catch {
    bad(
      "GRAPH_API_KEY is not set — there is no mock mode to fall back to",
      "create a free key at https://thegraph.com/studio/apikeys/ and put it in .env.local",
    );
    return;
  }
  if (!/^[0-9a-f]{32}$/i.test(key)) {
    warn(`does not look like a gateway key (${key.length} chars, expected 32 hex) — trying it anyway`);
  } else {
    ok("present, 32 hex chars");
  }

  console.log("the decentralized network");
  let reachable = 0;
  let head = 0;
  const lags: { label: string; lag: number }[] = [];

  for (const deployment of DEPLOYMENTS) {
    try {
      const result = await query<{ _meta: { block: { number: number } } }>(
        deployment,
        "{ _meta { block { number } } }",
        {},
      );
      reachable++;
      head = Math.max(head, result.block);
      lags.push({ label: deployment.label, lag: result.block });
      ok(`${deployment.label.padEnd(16)} block ${result.block}  ${result.elapsedMs} ms`);
    } catch (error) {
      // Never interpolate the gateway URL into output: the key is a path segment of it.
      const message = (error as Error).message.replace(/https:\/\/\S+/g, "<gateway url withheld>");
      if (/auth|401|403|payment|deprecated key/i.test(message)) {
        bad(
          `${deployment.label}: the gateway rejected the key — ${message}`,
          "the key is set but not usable: check it is not revoked and has query volume left",
        );
        return;
      }
      warn(`${deployment.label}: unreachable — ${message}`);
    }
  }

  if (reachable === 0) {
    bad("no deployment answered", "check network access to the gateway, then the key itself");
    return;
  }

  for (const { label, lag } of lags) {
    const behind = head - lag;
    if (behind > MAX_BLOCK_LAG) {
      warn(
        `${label} is ${behind} blocks behind head — the snapshot will exclude it loudly rather ` +
          `than mix stale data in (MAX_BLOCK_LAG is ${MAX_BLOCK_LAG})`,
      );
    }
  }
  ok(`${reachable} of ${DEPLOYMENTS.length} deployments answering, head ${head}`);
}

function checkOptional() {
  console.log("optional");
  if (process.env.RPC_URL) {
    ok("RPC_URL set — the on-chain health reconciliation can run");
  } else {
    warn("RPC_URL not set — `npm run verify:health` and `npm run verify:emode` will be skipped");
  }
}

function checkArtifacts() {
  console.log("build artifacts");
  for (const artifact of ARTIFACTS) {
    if (!existsSync(artifact.path)) {
      // Absent artifacts are not a failure: a fresh clone has none of them, and the point of
      // this check is to say what to run rather than to refuse to continue.
      warn(`${artifact.path} missing (${artifact.what}) → ${artifact.produce}`);
      continue;
    }
    const age = Date.now() - statSync(artifact.path).mtimeMs;
    const hours = age / 3_600_000;
    const label = hours < 1 ? `${Math.round(age / 60_000)} min old` : `${hours.toFixed(1)} h old`;
    if (hours > 24) {
      warn(`${artifact.path} is ${label} — the UI will say so; re-run ${artifact.produce} for a fresh reading`);
    } else {
      ok(`${artifact.path.padEnd(24)} ${label}`);
    }
  }
}

async function main() {
  console.log("Sentinel preflight — no mock mode, so this fails before the pipeline does\n");
  checkNode();
  checkToolchain();
  checkPolicy();
  await checkKeyAndSync();
  checkOptional();
  checkArtifacts();

  console.log();
  if (problems.length > 0) {
    console.error(`${problems.length} blocking problem${problems.length === 1 ? "" : "s"}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("\nNothing was run. Fix the above and try again.");
    process.exit(1);
  }
  console.log(
    warnings.length === 0
      ? "preflight OK — everything needed for a live reading is in place."
      : `preflight OK with ${warnings.length} warning${warnings.length === 1 ? "" : "s"} (listed above). ` +
          "None of them would make a published number wrong.",
  );
}

await main();
