/**
 * Version-skew normalization and USD valuation.
 *
 * The five registered deployments span Messari schema 3.1.0, 3.0.1 and 2.0.1.
 * A standard is a floor, not a guarantee of uniformity, so every difference
 * between versions is absorbed here and nowhere else.
 */

import type { Position, RawMarket, RawPosition, Side } from "./types";

/**
 * Schema 2.x emits LENDER for what 3.x calls COLLATERAL. Compound V2 is live on
 * 2.0.1 today, so this is load-bearing rather than defensive.
 */
export function normalizeSide(raw: string): Side {
  const s = raw.toUpperCase();
  if (s === "BORROWER") return "BORROWER";
  if (s === "COLLATERAL" || s === "LENDER" || s === "SUPPLIER") return "COLLATERAL";
  throw new Error(`Unrecognized PositionSide: ${raw}`);
}

/**
 * Build assetId -> USD price from market rows.
 *
 * Token has no price field in the Messari lending schema, so markets are the
 * only price source. Where several markets quote the same asset, the deepest
 * one wins — its oracle read is the best supported.
 */
export function buildPriceIndex(markets: RawMarket[]): Map<string, number> {
  const best = new Map<string, { price: number; tvl: number }>();

  for (const m of markets) {
    const price = Number(m.inputTokenPriceUSD);
    const tvl = Number(m.totalValueLockedUSD);
    if (!Number.isFinite(price) || price <= 0) continue;

    const id = m.inputToken.id.toLowerCase();
    const incumbent = best.get(id);
    if (!incumbent || tvl > incumbent.tvl) best.set(id, { price, tvl });
  }

  return new Map([...best].map(([id, v]) => [id, v.price]));
}

/** Convert a BigInt token balance string to a float in token units. */
export function toTokenUnits(balance: string, decimals: number): number {
  // Positions can exceed Number.MAX_SAFE_INTEGER in wei, so scale via BigInt
  // first and only then cross into float.
  const bi = BigInt(balance);
  const negative = bi < 0n;
  const abs = negative ? -bi : bi;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const value = Number(whole) + Number(frac) / Number(divisor);
  return negative ? -value : value;
}

/**
 * Percentages arrive as BigDecimal strings where 70.5 means 70.5%. Convert to a
 * fraction, and treat a missing or zero threshold as zero rather than guessing
 * a default — an invented threshold would silently corrupt every health factor.
 */
export function toFraction(pct: string | null | undefined): number {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / 100;
}

export function normalizePosition(
  raw: RawPosition,
  protocol: string,
  prices: Map<string, number>,
): Position | null {
  // Schema 2.x has no Position.asset; there, the market's input token *is* the
  // position's asset. Resolving it here keeps the version difference from
  // reaching anything downstream.
  const asset = raw.asset ?? raw.market.inputToken;
  const assetId = asset.id.toLowerCase();
  const amount = toTokenUnits(raw.balance, asset.decimals);
  if (amount === 0) return null;

  // Prefer the market's own quote; fall back to the cross-market index when the
  // position's asset differs from the market's input token (Compound V3 style
  // multi-collateral markets).
  const marketPrice = Number(raw.market.inputTokenPriceUSD);
  const sameAsset = raw.market.inputToken.id.toLowerCase() === assetId;
  const price =
    sameAsset && Number.isFinite(marketPrice) && marketPrice > 0
      ? marketPrice
      : (prices.get(assetId) ?? 0);

  // No price means no defensible USD figure. Drop it and let the coverage
  // report account for it rather than valuing it at zero inside a total.
  if (price <= 0) return null;

  return {
    id: raw.id,
    protocol,
    account: raw.account.id.toLowerCase(),
    side: normalizeSide(raw.side),
    assetId,
    assetSymbol: asset.symbol,
    amount,
    valueUsd: amount * price,
    liquidationThreshold: toFraction(raw.market.liquidationThreshold),
    maximumLtv: toFraction(raw.market.maximumLTV),
    marketId: raw.market.id,
  };
}
