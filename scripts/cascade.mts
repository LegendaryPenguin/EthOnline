/**
 * Run the cascade model over the live snapshot and write the evidence.
 *
 * Fetches the two things the simulation cannot compute — DEX depth and a year of
 * oracle price history — then runs the simulation many times over that one
 * dataset. Every figure in docs/evidence/phase4-cascade.md comes from this run.
 *
 *   npm run cascade
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdirSync, writeFileSync } from "node:fs";
import { DEPLOYMENTS } from "../lib/graph/deployments";
import { fetchPriceHistory } from "../lib/graph/history";
import { DEX_DEPLOYMENTS } from "../lib/graph/dex";
import { loadCascadeInputs, measureLiquidity } from "../lib/cascade/inputs";
import { ANCHORS, measureBetas, resolveReceiptBetas } from "../lib/cascade/factors";
import { assertSymmetric, buildCouplingMatrix } from "../lib/cascade/coupling";
import { simulateCascade, type CascadeResult } from "../lib/cascade/simulate";
import type { EmodeMode } from "../lib/cascade/emode";

const SHOCKS = [0.05, 0.1, 0.15, 0.2, 0.3];
const DEPTH_MULTIPLIERS = [0.5, 1, 2];

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pct = (n: number) => `${(100 * n).toFixed(2)}%`;

const inputs = loadCascadeInputs();
console.log(
  `snapshot: ${inputs.positions.length} positions, ` +
    `${inputs.assets.length} collateral assets covering ${pct(inputs.assetCoverage)} of value`,
);

// The factor proxies must have history even if they are not top collateral.
const assets = [...inputs.assets];
for (const [factor, id] of Object.entries(ANCHORS)) {
  if (!assets.some((a) => a.id === id)) {
    assets.push({ id, symbol: `${factor}-proxy`, collateralUsd: 0 });
  }
}

const started = Date.now();
const [liquidity, history] = await Promise.all([
  measureLiquidity(inputs, (m) => console.log(`  ${m}`)),
  fetchPriceHistory({
    assets,
    marketsByProtocol: JSON.parse(
      // Markets are already on disk from the snapshot; re-reading here keeps the
      // history fetch independent of the cascade input shape.
      (await import("node:fs")).readFileSync("data/snapshot.json", "utf8"),
    ).markets,
    deployments: DEPLOYMENTS,
    onProgress: (m) => console.log(`  ${m}`),
  }),
]);
console.log(
  `fetched in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
    `(${liquidity.queryCount} DEX queries across ${DEX_DEPLOYMENTS.length} deployments, ` +
    `${liquidity.failures.length} failures)`,
);

if (liquidity.failures.length > 0) {
  console.log("  DEX query failures:");
  for (const f of liquidity.failures.slice(0, 5)) console.log(`    ${f.deployment}: ${f.detail}`);
}
if (Object.keys(liquidity.rejectedUsdByAsset).length > 0) {
  const rejected = Object.entries(liquidity.rejectedUsdByAsset)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sym, v]) => `${sym} ${usd(v)}`)
    .join(", ");
  console.log(`  implied-price gate rejected: ${rejected}`);
}

// Receipt tokens have no price history of their own, so they resolve to the beta of
// the asset they are a receipt for rather than being left unmeasured — which would
// model ETH-denominated aToken collateral as taking no ETH shock.
const betas = resolveReceiptBetas(measureBetas(assets, history.byAsset), inputs.positions);

console.log("\n=== factor exposures, regressed on the protocols' own oracle prices ===");
console.log("asset        collateral        DEX depth   col/depth   bETH   bBTC     R2   obs");
for (const a of inputs.assets) {
  const b = betas.get(a.id)!;
  const depth = liquidity.byAsset.get(a.id)?.reserveUsd ?? 0;
  const ratio = depth > 0 ? `${(a.collateralUsd / depth).toFixed(1)}x` : "no depth";
  console.log(
    `${b.symbol.padEnd(11)} ${usd(a.collateralUsd).padStart(15)} ${usd(depth).padStart(15)} ` +
      `${ratio.padStart(11)} ${b.betaEth.toFixed(2).padStart(6)} ${b.betaBtc.toFixed(2).padStart(6)} ` +
      `${b.r2.toFixed(2).padStart(6)} ${String(b.observations).padStart(5)}`,
  );
}

const coupling = buildCouplingMatrix(inputs.positions);
assertSymmetric(coupling.borrowerOverlap);
console.log("\n=== protocol coupling ===");
console.log("shared-borrower overlap (symmetric, debt-weighted Jaccard)");
console.log(`${"".padEnd(20)}${coupling.protocols.map((p) => p.slice(0, 9).padStart(11)).join("")}`);
for (const a of coupling.protocols) {
  const row = coupling.protocols.map((b) => pct(coupling.borrowerOverlap[a][b]).padStart(11)).join("");
  console.log(`${a.padEnd(20)}${row}`);
}
console.log("\nshared-collateral exposure (asymmetric: row's collateral also lent against by column)");
console.log(`${"".padEnd(20)}${coupling.protocols.map((p) => p.slice(0, 9).padStart(11)).join("")}`);
for (const a of coupling.protocols) {
  const row = coupling.protocols
    .map((b) => pct(coupling.collateralExposure[a][b]).padStart(11))
    .join("");
  console.log(`${a.padEnd(20)}${row}`);
}
console.log("\ntop shared collateral assets");
for (const s of coupling.sharedAssets.slice(0, 5)) {
  console.log(`  ${s.symbol.padEnd(10)} ${usd(s.totalUsd).padStart(15)}  ${s.protocols.join(", ")}`);
}

const run = (shock: number, emode: EmodeMode, depthMultiplier = 1): CascadeResult =>
  simulateCascade({
    positions: inputs.positions,
    prices: inputs.prices,
    betas,
    liquidity: liquidity.byAsset,
    marketParams: inputs.marketParams,
    shocks: { ETH: shock, BTC: shock },
    emode,
    depthMultiplier,
  });

console.log("\n=== zero-shock sanity check ===");
for (const emode of ["off", "inferred", "calibrated"] as EmodeMode[]) {
  const b = run(0, emode);
  const applied = b.emodeDecisions.filter((d) => d.eligible).length;
  console.log(
    `${emode.padEnd(11)} ${usd(b.totalLiquidatedDebtUsd).padStart(6)} liquidated in ` +
      `${b.rounds.length} rounds; E-Mode resolved ${applied}, ` +
      `${b.excludedContradictedBooks} books excluded carrying ${usd(b.excludedContradictedDebtUsd)}`,
  );
  // A shock of zero must liquidate nothing. Any other result means the model is
  // reporting liquidations that the live chain disproves by the fact that the
  // accounts are still open, and every downstream figure would inherit it.
  if (b.totalLiquidatedDebtUsd > 0) {
    throw new Error(
      `zero-shock invariant violated under emode=${emode}: ` +
        `${usd(b.totalLiquidatedDebtUsd)} liquidated at a 0% shock`,
    );
  }
}

console.log("\n=== sensitivity: shock magnitude x E-Mode treatment ===");
console.log(
  "shock  emode        rounds conv  idiosyncratic       systemic          total   amp" +
    "   unliquidatable      distressed",
);
const table: CascadeResult[] = [];
for (const shock of SHOCKS) {
  for (const emode of ["off", "inferred", "calibrated"] as EmodeMode[]) {
    const r = run(shock, emode);
    table.push(r);
    console.log(
      `${pct(shock).padStart(6)} ${emode.padEnd(12)} ${String(r.roundsToConvergence).padStart(5)} ` +
        `${(r.converged ? "yes" : "NO").padStart(4)} ${usd(r.idiosyncraticDebtUsd).padStart(14)} ` +
        `${usd(r.systemicDebtUsd).padStart(14)} ${usd(r.totalLiquidatedDebtUsd).padStart(14)} ` +
        `${r.amplification.toFixed(2).padStart(5)} ${usd(r.unliquidatableDebtUsd).padStart(16)} ` +
        `${usd(r.distressedDebtUsd).padStart(15)}`,
    );
  }
}

// Liquidation volume must not fall as the shock grows. It did in the first
// version, which was the visible symptom of contradicted books flooding round 1.
for (const emode of ["off", "inferred", "calibrated"] as EmodeMode[]) {
  const series = table.filter((r) => r.emode === emode);
  for (let i = 1; i < series.length; i++) {
    const drop = series[i - 1].distressedDebtUsd - series[i].distressedDebtUsd;
    if (drop > 1) {
      throw new Error(
        `monotonicity violated for emode=${emode}: a ${pct(series[i].shocks.ETH!)} shock ` +
          `distresses ${usd(drop)} less debt than ${pct(series[i - 1].shocks.ETH!)}`,
      );
    }
  }
}

console.log("\n=== sensitivity: how much rests on the price-impact model ===");
// Run against the calibrated upper bound. Under the other two modes the surviving
// books are so far inside their thresholds that no depth constraint ever binds, so
// the table would show a flat line and prove nothing about the impact model.
console.log("shock  depth   rounds  total liquidated   unliquidatable   distressed    amp");
const depthTable: CascadeResult[] = [];
for (const shock of [0.1, 0.2]) {
  for (const dm of DEPTH_MULTIPLIERS) {
    const r = run(shock, "calibrated", dm);
    depthTable.push(r);
    console.log(
      `${pct(shock).padStart(6)} ${`${dm}x`.padStart(6)} ${String(r.roundsToConvergence).padStart(7)} ` +
        `${usd(r.totalLiquidatedDebtUsd).padStart(17)} ${usd(r.unliquidatableDebtUsd).padStart(16)} ` +
        `${usd(r.distressedDebtUsd).padStart(12)} ${r.amplification.toFixed(2).padStart(6)}`,
    );
  }
}

const headline = table.find((r) => r.shocks.ETH === 0.2 && r.emode === "inferred")!;
const upper = table.find((r) => r.shocks.ETH === 0.2 && r.emode === "calibrated")!;
console.log(
  `\nat a 20% shock the risk is bracketed, not point-estimated:\n` +
    `  modellable books only  ${usd(headline.totalLiquidatedDebtUsd)} liquidated, ` +
    `${usd(headline.unliquidatableDebtUsd)} left unliquidatable\n` +
    `  ${usd(headline.excludedContradictedDebtUsd)} of debt on ` +
    `${headline.excludedContradictedBooks} books is excluded outright: those books compute as ` +
    `insolvent at the snapshot while sitting open on chain, so their parameters are wrong and\n` +
    `  the calibrated upper bound puts them at the boundary instead: ` +
    `${usd(upper.distressedDebtUsd)} of debt distressed, ${usd(upper.unliquidatableDebtUsd)} of it ` +
    `unliquidatable against ${usd(upper.strandedCollateralUsd)} of collateral no liquidator can sell ` +
    `inside the bonus`,
);
console.log("\n=== round-by-round at a 20% ETH/BTC shock, E-Mode inferred ===");
console.log("round  accounts   liquidated debt   bad debt   per protocol");
for (const r of headline.rounds) {
  const byProtocol = Object.entries(r.byProtocol)
    .sort((a, b) => b[1] - a[1])
    .map(([p, v]) => `${p} ${usd(v)}`)
    .join("  ");
  console.log(
    `${String(r.round).padStart(5)} ${String(r.accountsLiquidated).padStart(9)} ` +
      `${usd(r.liquidatedDebtUsd).padStart(17)} ${usd(r.badDebtUsd).padStart(10)}   ${byProtocol}`,
  );
}
console.log(
  `\nforced selling alone moved prices: ` +
    Object.entries(headline.impactOnlyRatio)
      .filter(([, r]) => r < 0.999)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 6)
      .map(([id, r]) => `${betas.get(id)?.symbol ?? id.slice(0, 8)} ${pct(1 - r)}`)
      .join(", "),
);
if (headline.unmodellableSalesUsd > 0) {
  console.log(
    `unmodellable forced sales (no measurable depth): ${usd(headline.unmodellableSalesUsd)}: ` +
      `no price impact applied, so the cascade is understated by this much selling`,
  );
}
if (headline.unmeasuredCollateralUsd > 0) {
  console.log(
    `collateral with no measured beta, excluded from the shock: ${usd(headline.unmeasuredCollateralUsd)}`,
  );
}

mkdirSync("data", { recursive: true });
writeFileSync(
  "data/cascade.json",
  JSON.stringify(
    {
      provenance: {
        lendingBlocks: inputs.blocks,
        dexBlocks: liquidity.blocks,
        capturedAt: new Date().toISOString(),
        dexQueries: liquidity.queryCount,
        dexRejected: liquidity.rejected,
        dexRejectedUsdByAsset: liquidity.rejectedUsdByAsset,
        historySources: Object.fromEntries(history.sources),
        assetCoverage: inputs.assetCoverage,
      },
      betas: Object.fromEntries(betas),
      liquidity: Object.fromEntries(
        [...liquidity.byAsset].map(([k, v]) => [
          k,
          { symbol: v.symbol, reserveUsd: v.reserveUsd, reserveTokens: v.reserveTokens, pools: v.pools.length },
        ]),
      ),
      coupling,
      sensitivity: table.map(summarise),
      depthSensitivity: depthTable.map(summarise),
      headline: { ...summarise(headline), rounds: headline.rounds },
    },
    null,
    2,
  ),
);
console.log("\nwrote data/cascade.json");

function summarise(r: CascadeResult) {
  return {
    shocks: r.shocks,
    emode: r.emode,
    depthMultiplier: r.depthMultiplier,
    converged: r.converged,
    roundsToConvergence: r.roundsToConvergence,
    idiosyncraticDebtUsd: r.idiosyncraticDebtUsd,
    systemicDebtUsd: r.systemicDebtUsd,
    totalLiquidatedDebtUsd: r.totalLiquidatedDebtUsd,
    amplification: r.amplification,
    badDebtUsd: r.badDebtUsd,
    totalDebtUsd: r.totalDebtUsd,
    unmodellableSalesUsd: r.unmodellableSalesUsd,
    unliquidatableDebtUsd: r.unliquidatableDebtUsd,
    distressedDebtUsd: r.distressedDebtUsd,
    strandedCollateralUsd: r.strandedCollateralUsd,
    excludedContradictedDebtUsd: r.excludedContradictedDebtUsd,
    excludedContradictedBooks: r.excludedContradictedBooks,
  };
}
