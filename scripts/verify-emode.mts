/**
 * npm run verify:emode — test the E-Mode inference against Aave's own contract.
 *
 * `lib/cascade/emode.ts` reconstructs a parameter the standardized schema does not
 * publish, by inferring it from measured factor correlations. That is the single
 * largest guess in Sentinel, so it is checked against ground truth rather than
 * asserted: `getUserAccountData` returns `currentLiquidationThreshold`, which
 * *does* reflect E-Mode, so the contract can be asked directly whether each
 * inference was right.
 *
 * Requires `npm run snapshot` and `npm run cascade` first — betas are read from
 * data/cascade.json rather than refitted, so this script verifies exactly the
 * numbers the published cascade ran on.
 *
 * Writes docs/verification/emode-inference.md.
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadCascadeInputs } from "../lib/cascade/inputs";
import { decideEmode, type EmodeDecision } from "../lib/cascade/emode";
import { groupByAccountProtocol } from "../lib/cascade/simulate";
import type { AssetBeta } from "../lib/cascade/factors";
import { getUserAccountData, rpcUrl } from "../lib/verify/onchain";

const PROTOCOL = "aave-v3-eth";
const SAMPLE = Number(process.env.VERIFY_SAMPLE ?? 40);

/**
 * How far above the schema's own weighted threshold the contract has to sit
 * before the account is treated as being in E-Mode.
 *
 * A direct comparison rather than an absolute cutoff, because an absolute one
 * cannot work: Aave's USDC threshold is 0.87 by default, so any fixed line high
 * enough to exclude it would also exclude real E-Mode categories. Two percentage
 * points is comfortably outside oracle and rounding noise, which the Phase 3
 * reconciliation measured at a 0.04% median on collateral.
 */
const EMODE_GAP = 0.02;

const inputs = loadCascadeInputs();

let betas: Map<string, AssetBeta>;
try {
  const cascade = JSON.parse(await readFile("data/cascade.json", "utf8"));
  betas = new Map(Object.entries(cascade.betas)) as Map<string, AssetBeta>;
} catch {
  throw new Error("data/cascade.json is missing — run `npm run cascade` first");
}

const grouped = groupByAccountProtocol(
  inputs.positions.filter((p) => p.protocol === PROTOCOL),
);

type Row = {
  account: string;
  decision: EmodeDecision;
  ourThreshold: number;
  theirThreshold: number;
  ourHealth: number;
  theirHealth: number;
  /** The contract says this account is in E-Mode. */
  actual: boolean;
  /** Sentinel inferred it. */
  predicted: boolean;
};

// Largest borrowers first: the accounts whose E-Mode status moves the cascade.
const candidates = [...grouped]
  .map(([key, g]) => ({
    key,
    account: key.split("|")[0],
    g,
    debtUsd: g.debt.reduce((s, p) => s + p.valueUsd, 0),
  }))
  .filter((c) => c.debtUsd > 0 && c.g.collateral.length > 0)
  .sort((a, b) => b.debtUsd - a.debtUsd)
  .slice(0, SAMPLE);

console.log(`verifying ${candidates.length} Aave V3 accounts against ${rpcUrl()}`);

const rows: Row[] = [];
const failures: { account: string; detail: string }[] = [];

for (const c of candidates) {
  const decision = decideEmode(c.account, PROTOCOL, c.g.collateral, c.g.debt, betas, inputs.prices);
  let onchain;
  try {
    onchain = await getUserAccountData(c.account);
  } catch (err) {
    failures.push({ account: c.account, detail: (err as Error).message });
    continue;
  }

  // An account the contract reports as closed cannot be compared: the subgraph's
  // position is stale, which is a different defect (Phase 3 calls it `phantom`).
  if (onchain.totalDebtUsd === 0 && onchain.totalCollateralUsd === 0) {
    failures.push({ account: c.account, detail: "contract reports no position" });
    continue;
  }

  rows.push({
    account: c.account,
    decision,
    ourThreshold: decision.thresholdBefore,
    theirThreshold: onchain.currentLiquidationThreshold,
    ourHealth: decision.healthBefore,
    theirHealth: onchain.healthFactor,
    actual: onchain.currentLiquidationThreshold - decision.thresholdBefore > EMODE_GAP,
    predicted: decision.eligible,
  });
  process.stdout.write(".");
}
console.log();

const tp = rows.filter((r) => r.actual && r.predicted).length;
const fp = rows.filter((r) => !r.actual && r.predicted).length;
const fn = rows.filter((r) => r.actual && !r.predicted).length;
const tn = rows.filter((r) => !r.actual && !r.predicted).length;
const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
const recall = tp + fn > 0 ? tp / (tp + fn) : 1;

// The inference only ever fires on a contradicted account, by design: there is
// nothing to resolve on a book that is already solvent. So recall over every
// E-Mode account understates it, and recall over the population it is actually
// applied to is the number that describes the model. Both are reported.
const contradicted = rows.filter((r) => r.ourHealth < 1);
const cTp = contradicted.filter((r) => r.actual && r.predicted).length;
const cFn = contradicted.filter((r) => r.actual && !r.predicted).length;
const cRecall = cTp + cFn > 0 ? cTp / (cTp + cFn) : 1;

console.log(`precision ${(100 * precision).toFixed(1)}%  recall ${(100 * recall).toFixed(1)}%`);
console.log(`recall on contradicted accounts only: ${(100 * cRecall).toFixed(1)}%`);
console.log(`TP ${tp}  FP ${fp}  FN ${fn}  TN ${tn}  (${failures.length} not comparable)`);

// A false positive is the failure that matters. It raises a threshold on an
// account that does not have E-Mode, inventing safety margin and suppressing a
// liquidation the cascade should have found.
if (fp > 0) {
  console.log("\nfalse positives — E-Mode inferred where the contract disagrees:");
  for (const r of rows.filter((x) => !x.actual && x.predicted)) {
    console.log(
      `  ${r.account} ours ${r.ourThreshold.toFixed(4)} theirs ${r.theirThreshold.toFixed(4)}`,
    );
  }
}

const pct = (n: number) => `${(100 * n).toFixed(1)}%`;
const f4 = (n: number) => (Number.isFinite(n) ? n.toFixed(4) : "∞");

const missed = rows.filter((r) => r.actual && !r.predicted);

await mkdir("docs/verification", { recursive: true });
await writeFile(
  "docs/verification/emode-inference.md",
  `# E-Mode inference, verified against the Aave V3 Pool contract

Generated by \`npm run verify:emode\`. Ground truth is
\`getUserAccountData(address).currentLiquidationThreshold\`, which reflects E-Mode;
the standardized schema publishes only per-asset defaults and has no E-Mode field
at all. An account counts as being in E-Mode when the contract's threshold exceeds
the schema-implied weighted threshold by more than ${EMODE_GAP} — a relative test,
because Aave's default USDC threshold of 0.87 is higher than some E-Mode
categories and no absolute cutoff can separate them.

Sample: the ${candidates.length} largest Aave V3 borrowers in the cross-protocol
set. ${rows.length} comparable, ${failures.length} not.

## Result

| | inferred E-Mode | did not |
|---|---|---|
| **contract says E-Mode** | ${tp} | ${fn} |
| **contract says no** | ${fp} | ${tn} |

- precision **${pct(precision)}** — of the accounts Sentinel raises, this share really are in E-Mode
- recall **${pct(recall)}** over every E-Mode account in the sample
- recall **${pct(cRecall)}** over contradicted accounts, which is the population the inference is actually applied to

Precision is the number that matters. A false positive raises a threshold on an
account that does not have E-Mode, which invents safety margin and suppresses a
liquidation the cascade should have found. A false negative leaves the account
contradicted, and a contradicted account is *excluded* from the simulation and its
debt reported — conservative, and visible in the output rather than silent.

Low recall over the full sample is by construction, not a defect: the inference
fires only where the schema's thresholds produce a contradiction. On a book that is
already solvent there is nothing to resolve, and raising its threshold on a guess
would be exactly the failure precision measures.

## Every account compared

| account | our LT | contract LT | our HF | contract HF | contract E-Mode | inferred | verdict |
|---|---|---|---|---|---|---|---|
${rows
  .map(
    (r) =>
      `| \`${r.account}\` | ${f4(r.ourThreshold)} | ${f4(r.theirThreshold)} | ${f4(r.ourHealth)} | ${f4(r.theirHealth)} | ${r.actual ? "yes" : "no"} | ${r.predicted ? "yes" : "no"} | ${
        r.actual === r.predicted ? "agree" : r.predicted ? "**false positive**" : "false negative"
      } |`,
  )
  .join("\n")}

## The misses, in full

${
  missed.length === 0
    ? "None: every E-Mode account in the sample was inferred."
    : missed
        .map((r) => `- \`${r.account}\` — ${r.decision.reason}`)
        .join("\n")
}

${
  failures.length === 0
    ? ""
    : `## Not comparable\n\n${failures.map((f) => `- \`${f.account}\` — ${f.detail}`).join("\n")}\n`
}
`,
);
console.log("\nwrote docs/verification/emode-inference.md");
