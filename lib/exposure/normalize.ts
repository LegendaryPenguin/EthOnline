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
 * Convert a risk parameter to a fraction, inferring its units.
 *
 * The Messari spec says these are percentages, and Aave V3 and Compound V2 do
 * emit `83` and `82.5`. Morpho Aave V2 emits `0.86` for the same field — a
 * fraction. Both are live right now, so the unit is not something the schema
 * guarantees and has to be inferred from the value:
 *
 *   0 < v <= 1    already a fraction
 *   1 < v <= 100  a percentage
 *
 * Exactly 1 is ambiguous: it could be a 100% threshold or a 1% one. It resolves
 * to 100%, because a 1% liquidation threshold does not exist in any real market
 * while a 100% one is at least coherent. Anything above 100 is not a ratio at
 * all and is rejected.
 *
 * A missing or zero value returns 0 rather than a guessed default. Callers must
 * treat 0 as "unknown" and refuse to compute, because an invented threshold
 * would silently corrupt every health factor downstream.
 */
export function toFraction(value: string | null | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return 0;
}

/**
 * Input tokens per unit of the position's asset, when that asset is the market's
 * receipt token. `null` when it is not, so the caller falls through to the index.
 *
 * This exists because of a measured wrong answer, not a hypothetical one. Aave V3
 * reports supply positions in the aToken — `Position.asset` is `aEthweETH`, not
 * `weETH` — and an aToken has no price in the Messari lending schema, because
 * `Market.inputTokenPriceUSD` prices the underlying and `Token` carries no price at
 * all. So the position was unpriceable, dropped, and the account then read as
 * $1.03B of debt against $0 of collateral: the largest borrower on Aave V3 published
 * as insolvent under a 5% shock while sitting untouched on a live chain. A dropped
 * position is not a conservative position.
 *
 * `Market.outputToken` names the receipt token exactly, so this is identification
 * rather than a guess about symbols. The rate is the residual assumption:
 *
 *   - `exchangeRate` reported  use it. Exact, and the only correct answer for a
 *                             rebasing receipt such as a cToken.
 *   - not reported            assume 1:1, but only when decimals match. Aave's
 *                             aTokens are 1:1 with the underlying by protocol
 *                             invariant and report no rate; matching decimals is
 *                             the cheapest available check that we are looking at
 *                             that kind of receipt and not a rebasing one.
 *
 * The residual risk is a non-1:1 receipt that reports no exchange rate and shares
 * the underlying's decimals. None of the five registered deployments is that, and
 * the alternative — silently deleting collateral — is not a safer error, only a
 * quieter one.
 */
function receiptExchangeRate(
  market: RawPosition["market"],
  assetId: string,
  assetDecimals: number,
): number | null {
  const outputId = market.outputToken?.id.toLowerCase();
  if (!outputId || outputId !== assetId) return null;

  const rate = Number(market.exchangeRate);
  if (Number.isFinite(rate) && rate > 0) return rate;
  return assetDecimals === market.inputToken.decimals ? 1 : null;
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
  // multi-collateral markets); and resolve receipt tokens, which are in neither.
  const marketPrice = Number(raw.market.inputTokenPriceUSD);
  const usableMarketPrice = Number.isFinite(marketPrice) && marketPrice > 0;
  const sameAsset = raw.market.inputToken.id.toLowerCase() === assetId;
  const receiptRate = receiptExchangeRate(raw.market, assetId, asset.decimals);
  const price = sameAsset && usableMarketPrice
    ? marketPrice
    : receiptRate !== null && usableMarketPrice
      ? marketPrice * receiptRate
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
