/**
 * Risk factors, measured rather than assumed.
 *
 * Why this module has to exist. Shocking each collateral asset independently
 * would make the cross-protocol book look diversified, and it is not. Across the
 * addresses levered on two or more lending protocols, 39.8% of collateral is
 * weETH, 20.5% WETH, 18.1% wstETH and 8.8% rsETH — the same bet on the same
 * asset wearing four wrappers. A 20% ETH move hits all four at once, so shocking
 * them one at a time understates the cascade by roughly fourfold, which is the
 * difference between "notable" and "the book liquidates".
 *
 * How membership is decided, and the two approaches that were tried and rejected
 * first, because the rejected ones are the obvious ones:
 *
 *   Rejected — price bands. "Within 0.85x-1.75x of the ETH oracle price" puts
 *   XAUt in the ETH factor, because tokenised gold happened to trade at 1.73x
 *   ETH at this block. Gold is not ETH. Any band wide enough to hold wstETH at
 *   1.24x, which drifts upward forever as staking rewards accrue, is wide enough
 *   to catch unrelated assets, and narrowing it to fit the data is fitting.
 *
 *   Rejected — corroboration from the DEX schema. The plan was that a real
 *   wrapper's deepest pool pairs it with the anchor. Measured: LINK is 94.3% and
 *   AAVE 97.2% paired with WETH by depth. On Ethereum everything trades against
 *   WETH, so pool composition carries almost no information about correlation. It
 *   would have been a satisfying two-schema story and it is not a true one.
 *
 *   Used — a two-factor regression of daily returns on ETH and BTC returns, from
 *   `MarketDailySnapshot.inputTokenPriceUSD` over the last year. This needs no
 *   bands, no token classes and no anchors beyond naming the two factor proxies:
 *   an asset's exposure is a number that comes out of its own price history.
 *   Stablecoins get a beta near zero without being labelled stablecoins, and
 *   assets like LINK get the partial beta they actually have instead of being
 *   forced into or out of a bucket.
 *
 * ETH and BTC returns are themselves strongly correlated, so the regression is
 * multivariate. Two univariate betas would each absorb the shared component and
 * double-count it under a joint shock.
 *
 * The prices regressed are the ones the protocols' own oracles published, so
 * these are correlations between the exact numbers that trigger liquidations.
 */

import type { PriceSeries } from "../graph/history";

/**
 * The two factor proxies.
 *
 * Naming two reference assets is not a per-token adapter: these define what the
 * factors are, and every other asset's exposure to them is then measured. A USD
 * factor needs no proxy — it is the unit the oracles already quote in, and an
 * asset pinned to it simply regresses to a beta of zero on both proxies.
 */
export const ANCHORS = {
  ETH: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  BTC: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
} as const;

export type FactorId = "ETH" | "BTC";

/**
 * `measured`   enough overlapping history to regress; beta is used as-is.
 * `unmeasured` too little overlapping history. Beta is not invented — the asset
 *              is excluded from factor shocks and its collateral is reported
 *              separately, because assuming either zero or one would be a guess
 *              dressed as a result.
 */
export type BetaConfidence = "measured" | "unmeasured";

export type AssetBeta = {
  assetId: string;
  symbol: string;
  betaEth: number;
  betaBtc: number;
  /** Fraction of the asset's return variance the two factors explain. */
  r2: number;
  /** Daily return observations the regression used. */
  observations: number;
  /** Standard deviation of the asset's own daily returns. */
  volatility: number;
  confidence: BetaConfidence;
  reason: string;
};

/**
 * Minimum overlapping daily returns before a beta is trusted.
 *
 * Sixty is enough for a two-parameter fit to be more than noise while still
 * admitting assets listed only a few months ago — and newly listed LRTs being
 * admitted matters, since they are where the leverage is.
 */
export const MIN_OBSERVATIONS = 60;

/**
 * Log returns from a day-indexed price series, restricted to consecutive days.
 *
 * Consecutive-only because a return spanning a gap is a multi-day return, and
 * mixing horizons biases the regression. Log returns because they compose
 * additively, so a beta fitted on them is the same beta at any horizon.
 */
export function logReturns(series: PriceSeries): Map<number, number> {
  const out = new Map<number, number>();
  for (const [day, price] of series) {
    const prev = series.get(day - 1);
    if (!prev || prev <= 0 || price <= 0) continue;
    out.set(day, Math.log(price / prev));
  }
  return out;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Two-regressor OLS with an intercept, solved in closed form.
 *
 * y = a + b1*x1 + b2*x2. Small enough to be exact and to have no dependency, and
 * the determinant guard is the case that actually happens: if the two factors are
 * perfectly collinear over the window there is no unique solution, and returning
 * nothing is correct where returning an arbitrary split is not.
 */
export function ols2(
  y: number[],
  x1: number[],
  x2: number[],
): { b1: number; b2: number; r2: number } | null {
  const n = y.length;
  if (n < 3) return null;

  const my = mean(y);
  const m1 = mean(x1);
  const m2 = mean(x2);

  let s11 = 0;
  let s22 = 0;
  let s12 = 0;
  let s1y = 0;
  let s2y = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const d1 = x1[i] - m1;
    const d2 = x2[i] - m2;
    const dy = y[i] - my;
    s11 += d1 * d1;
    s22 += d2 * d2;
    s12 += d1 * d2;
    s1y += d1 * dy;
    s2y += d2 * dy;
    syy += dy * dy;
  }

  const det = s11 * s22 - s12 * s12;
  if (det === 0 || !Number.isFinite(det)) return null;

  const b1 = (s22 * s1y - s12 * s2y) / det;
  const b2 = (s11 * s2y - s12 * s1y) / det;

  let ssr = 0;
  for (let i = 0; i < n; i++) {
    const fit = my + b1 * (x1[i] - m1) + b2 * (x2[i] - m2);
    ssr += (y[i] - fit) ** 2;
  }
  const r2 = syy > 0 ? 1 - ssr / syy : 0;

  return { b1, b2, r2 };
}

/**
 * Measure every asset's exposure to the two factors.
 *
 * The proxies are given a beta of exactly 1 on themselves rather than a regressed
 * one. Regressing WETH on WETH would return 1 anyway, but stating it makes the
 * definition of the shock unambiguous: a "20% ETH shock" means WETH falls 20%.
 */
export function measureBetas(
  assets: { id: string; symbol: string }[],
  history: Map<string, PriceSeries>,
): Map<string, AssetBeta> {
  const out = new Map<string, AssetBeta>();

  const ethReturns = history.has(ANCHORS.ETH) ? logReturns(history.get(ANCHORS.ETH)!) : new Map();
  const btcReturns = history.has(ANCHORS.BTC) ? logReturns(history.get(ANCHORS.BTC)!) : new Map();

  if (ethReturns.size === 0 || btcReturns.size === 0) {
    throw new Error(
      "Cannot measure factor exposures: no daily price history for the ETH or BTC proxy. " +
        "Sentinel does not fall back to assumed correlations.",
    );
  }

  for (const asset of assets) {
    const id = asset.id.toLowerCase();

    if (id === ANCHORS.ETH || id === ANCHORS.BTC) {
      const isEth = id === ANCHORS.ETH;
      const own = logReturns(history.get(id)!);
      out.set(id, {
        assetId: id,
        symbol: asset.symbol,
        betaEth: isEth ? 1 : 0,
        betaBtc: isEth ? 0 : 1,
        r2: 1,
        observations: own.size,
        volatility: stdev([...own.values()]),
        confidence: "measured",
        reason: `factor proxy: defines the ${isEth ? "ETH" : "BTC"} shock`,
      });
      continue;
    }

    const series = history.get(id);
    if (!series) {
      out.set(id, {
        assetId: id,
        symbol: asset.symbol,
        betaEth: 0,
        betaBtc: 0,
        r2: 0,
        observations: 0,
        volatility: 0,
        confidence: "unmeasured",
        reason: "no daily price history available",
      });
      continue;
    }

    const own = logReturns(series);
    const days = [...own.keys()].filter((d) => ethReturns.has(d) && btcReturns.has(d)).sort();
    const y = days.map((d) => own.get(d)!);
    const x1 = days.map((d) => ethReturns.get(d)!);
    const x2 = days.map((d) => btcReturns.get(d)!);

    const fit = days.length >= MIN_OBSERVATIONS ? ols2(y, x1, x2) : null;
    if (!fit) {
      out.set(id, {
        assetId: id,
        symbol: asset.symbol,
        betaEth: 0,
        betaBtc: 0,
        r2: 0,
        observations: days.length,
        volatility: stdev(y),
        confidence: "unmeasured",
        reason:
          `only ${days.length} overlapping daily returns, below the ${MIN_OBSERVATIONS} needed; ` +
          `no beta is assumed`,
      });
      continue;
    }

    out.set(id, {
      assetId: id,
      symbol: asset.symbol,
      betaEth: fit.b1,
      betaBtc: fit.b2,
      r2: fit.r2,
      observations: days.length,
      volatility: stdev(y),
      confidence: "measured",
      reason:
        `regressed ${days.length} daily oracle returns: beta ETH ${fit.b1.toFixed(3)}, ` +
        `beta BTC ${fit.b2.toFixed(3)}, R2 ${fit.r2.toFixed(3)}`,
    });
  }

  return out;
}

/**
 * The return an asset takes under a given factor shock.
 *
 * Linear in the factor returns by construction, which is the model's main
 * limitation and worth stating plainly: real correlations rise in a crash, so a
 * beta fitted across a normal year understates co-movement in exactly the
 * scenario being simulated. The bias understates the cascade.
 */
export function shockForAsset(
  beta: AssetBeta | undefined,
  shocks: Partial<Record<FactorId, number>>,
): number {
  if (!beta || beta.confidence === "unmeasured") return 0;
  return beta.betaEth * (shocks.ETH ?? 0) + beta.betaBtc * (shocks.BTC ?? 0);
}
