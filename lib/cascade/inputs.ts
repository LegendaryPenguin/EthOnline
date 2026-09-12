/**
 * Assembling the cascade's inputs from the two snapshots on disk.
 *
 * Kept separate from the simulation so that the simulation is a pure function of
 * data it does not have to fetch. That is what makes it testable, and what lets
 * the sensitivity table re-run it fifteen times without touching the network.
 */

import { readFileSync } from "node:fs";
import { addReceiptPrices, buildPriceIndex } from "../exposure/normalize";
import { captureLiquidity, type LiquidityIndex } from "../graph/dex";
import type { Position, RawMarket } from "../exposure/types";

export type MarketParams = {
  liquidationThreshold: number;
  liquidationPenalty: number;
};

export type CascadeInputs = {
  positions: Position[];
  prices: Map<string, number>;
  /** Liquidation penalty per market id, which `Position` does not carry. */
  marketParams: Map<string, MarketParams>;
  /** Collateral assets worth modelling, largest first. */
  assets: { id: string; symbol: string; collateralUsd: number }[];
  /** Assets used as the other leg of a pair when measuring depth. */
  quotes: { id: string; symbol: string }[];
  /** Share of cross-protocol collateral covered by `assets`. */
  assetCoverage: number;
  blocks: Record<string, number>;
};

/**
 * Assets below this share of cross-protocol collateral are not worth a query
 * budget: the tail is 40+ assets holding well under 1% between them, and each
 * one costs a pair query against every quote on every DEX deployment. The share
 * excluded is reported as `assetCoverage` rather than left implicit.
 */
export const MIN_ASSET_SHARE = 0.001;

/** How many lending assets to use as pair counterparties. */
export const QUOTE_COUNT = 12;

export function loadCascadeInputs(
  completedPath = "data/completed.json",
  snapshotPath = "data/snapshot.json",
): CascadeInputs {
  const completed = JSON.parse(readFileSync(completedPath, "utf8")) as {
    positions: Position[];
    provenance?: { blocks?: Record<string, number> };
  };
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
    markets: Record<string, RawMarket[]>;
    provenance: { blocks: Record<string, number> };
  };

  const allMarkets = Object.values(snapshot.markets).flat();
  // Reconciled with the positions, or receipt-token collateral would be priced at
  // zero here while carrying a real `valueUsd` — see `addReceiptPrices`.
  const prices = addReceiptPrices(buildPriceIndex(allMarkets), completed.positions);

  const marketParams = new Map<string, MarketParams>();
  for (const m of allMarkets) {
    marketParams.set(m.id.toLowerCase(), {
      liquidationThreshold: Number(m.liquidationThreshold) || 0,
      liquidationPenalty: Number(m.liquidationPenalty) || 0,
    });
  }

  const collateral = new Map<string, { symbol: string; usd: number }>();
  let totalCollateral = 0;
  for (const p of completed.positions) {
    if (p.side !== "COLLATERAL") continue;
    const id = p.assetId.toLowerCase();
    const e = collateral.get(id) ?? { symbol: p.assetSymbol, usd: 0 };
    e.usd += p.valueUsd;
    collateral.set(id, e);
    totalCollateral += p.valueUsd;
  }

  const ranked = [...collateral.entries()].sort((a, b) => b[1].usd - a[1].usd);
  const assets = ranked
    .filter(([, e]) => e.usd / totalCollateral >= MIN_ASSET_SHARE)
    .map(([id, e]) => ({ id, symbol: e.symbol, collateralUsd: e.usd }));
  const assetCoverage = assets.reduce((s, a) => s + a.collateralUsd, 0) / totalCollateral;

  // Quotes come from lending depth rather than a hand-written major-pairs list:
  // the deepest lending markets are where the liquid assets are, and this keeps
  // the whole pipeline free of curated token lists.
  const byLendingTvl = new Map<string, { symbol: string; tvl: number }>();
  for (const m of allMarkets) {
    const id = m.inputToken.id.toLowerCase();
    if (!prices.has(id)) continue;
    const e = byLendingTvl.get(id) ?? { symbol: m.inputToken.symbol, tvl: 0 };
    e.tvl += Number(m.totalValueLockedUSD) || 0;
    byLendingTvl.set(id, e);
  }
  const quotes = [...byLendingTvl.entries()]
    .sort((a, b) => b[1].tvl - a[1].tvl)
    .slice(0, QUOTE_COUNT)
    .map(([id, e]) => ({ id, symbol: e.symbol }));

  return {
    positions: completed.positions,
    prices,
    marketParams,
    assets,
    quotes,
    assetCoverage,
    blocks: snapshot.provenance.blocks,
  };
}

export async function measureLiquidity(
  inputs: CascadeInputs,
  onProgress: (m: string) => void = () => {},
): Promise<LiquidityIndex> {
  return captureLiquidity({
    assets: inputs.assets,
    quotes: inputs.quotes,
    prices: inputs.prices,
    onProgress,
  });
}
