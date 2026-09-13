/**
 * Precompute the cascade at every shock level the interface's slider can reach.
 *
 * Runs entirely off disk. `npm run cascade` already fetched the two things the
 * simulation cannot compute — DEX depth and a year of oracle history — and wrote them
 * into `data/cascade.json`, so this script reuses those measurements rather than
 * re-querying the gateway. The consequence worth stating: the ladder is only as fresh as
 * the cascade run it reads, and its `blocks` field carries that provenance through to
 * the UI, which shows it and refuses to imply the data is newer than it is.
 *
 *   npm run cascade        # first: fetch depth + history, write data/cascade.json
 *   npm run shock:ladder   # then: this, writing data/shock-ladder.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AssetLiquidity } from "../lib/graph/dex";
import type { AssetBeta } from "../lib/cascade/factors";
import { loadCascadeInputs } from "../lib/cascade/inputs";
import { buildShockLadder } from "../lib/ui/ladder";

if (!existsSync("data/cascade.json")) {
  console.error("data/cascade.json is missing. Run `npm run cascade` first.");
  process.exit(1);
}

const cascade = JSON.parse(readFileSync("data/cascade.json", "utf8")) as {
  betas: Record<string, AssetBeta>;
  liquidity: Record<string, AssetLiquidity>;
  provenance: { capturedAt: string; lendingBlocks: Record<string, number> };
};

const inputs = loadCascadeInputs();
const betas = new Map(Object.entries(cascade.betas));
const liquidity = new Map(Object.entries(cascade.liquidity));

console.log(
  `${inputs.positions.length} positions, ${betas.size} measured betas, ` +
    `${liquidity.size} assets with depth, from a cascade run at ${cascade.provenance.capturedAt}`,
);

const started = Date.now();
const ladder = buildShockLadder({
  inputs,
  betas,
  liquidity,
  onProgress: (m) => {
    // Every fifth rung, or the log is 41 near-identical lines.
    if (m.startsWith("0%") || /^(5|10|15|20|25|30|35|40)%/.test(m)) console.log(`  ${m}`);
  },
});
const elapsed = (Date.now() - started) / 1000;

mkdirSync("data", { recursive: true });
writeFileSync("data/shock-ladder.json", JSON.stringify(ladder));

const twenty = ladder.steps.find((s) => s.shockBps === 2000)!;
console.log(
  `\n${ladder.steps.length} rungs in ${elapsed.toFixed(1)}s ` +
    `(${((1000 * elapsed) / (2 * ladder.steps.length)).toFixed(0)}ms per simulation)`,
);
console.log(
  `at 20%: ${twenty.rounds.length} rounds, ` +
    `$${Math.round(twenty.totalLiquidatedDebtUsd).toLocaleString("en-US")} liquidated, ` +
    `$${Math.round(twenty.distressedDebtUsd).toLocaleString("en-US")} distressed, ` +
    `upper bound $${Math.round(twenty.upperBound.distressedDebtUsd).toLocaleString("en-US")}`,
);
console.log(
  `wrote data/shock-ladder.json ` +
    `(${(readFileSync("data/shock-ladder.json").length / 1024).toFixed(0)} KB)`,
);
