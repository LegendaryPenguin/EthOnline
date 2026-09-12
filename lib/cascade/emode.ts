/**
 * Reconstructing Aave V3 E-Mode from the factor model.
 *
 * E-Mode is the largest single error in Sentinel's risk engine and it is not a
 * bug: the Messari lending schema has no field for it. When a borrower's
 * collateral and debt are correlated assets, Aave raises the liquidation
 * threshold well above the per-asset default — the hand-verified account
 * 0x9600a48ed0f931d0c422d574e3275a90d8b22745 runs at an on-chain 0.9500 where the
 * schema publishes 0.80. Phase 3 measured the consequence: 11 of 23 sampled Aave
 * V3 accounts are in E-Mode, and the entire health-factor gap on the largest
 * cross-protocol borrower is this one number.
 *
 * Left uncorrected it breaks the cascade simulation at round zero. An account
 * whose computed health factor is below 1 while it sits un-liquidated on a live
 * chain would be reported as liquidating under a 0% shock, which is false, and
 * that false liquidation then seeds a cascade that never happens.
 *
 * The reconstruction reuses the thing E-Mode is *defined* by. Aave grants it for
 * correlated pairs; `lib/cascade/factors.ts` already measures correlation from a
 * year of the protocol's own oracle prices. So: where an account's collateral and
 * debt inside one protocol load on the same factor, the account is eligible, and
 * the threshold rises to the observed ceiling.
 *
 * This is inference, not observation, so it is never the only answer given. Every
 * simulation runs under both `emode: "off"` and `emode: "inferred"`, and the
 * spread between them is published as the uncertainty the schema gap creates.
 * `npm run verify:emode` tests the inference against Aave's own contract.
 */

import type { Position } from "../exposure/types";
import type { AssetBeta, FactorId } from "./factors";

/**
 * The threshold an E-Mode position is assumed to carry.
 *
 * Aave's ETH-correlated category publishes 93% LTV and a 95% liquidation
 * threshold, and 0.9500 is exactly what `getUserAccountData` returned for the
 * largest cross-protocol borrower. It is a ceiling, not an average, so the
 * inference is applied only where it is needed to resolve a contradiction.
 */
export const EMODE_THRESHOLD = 0.95;

/**
 * How dominant a factor must be, by value, on both sides of a position for the
 * pair to count as correlated.
 *
 * Aave applies E-Mode to a whole position, not per asset, and a borrower with a
 * meaningful uncorrelated leg would not be granted it — so this is deliberately
 * high rather than a simple majority.
 */
export const FACTOR_DOMINANCE = 0.9;

/** Minimum R2 before a beta is strong enough to claim two assets are the same bet. */
export const MIN_FACTOR_R2 = 0.7;

/**
 * Daily volatility below which an asset is a dollar, and the loading it must not
 * have on either risk factor for that to count.
 *
 * Aave's third E-Mode category is stablecoin-against-stablecoin, and a two-factor
 * ETH/BTC model cannot express it: both legs correctly regress to a beta of zero,
 * so neither loads on anything and `dominantFactor` finds nothing. That cost real
 * recall — the account holding sUSDe against USDe is in E-Mode on chain and was
 * missed for exactly this reason.
 *
 * The category is still *measured* rather than labelled, which is the rule
 * everywhere else in this model. Across the live collateral set the separation is
 * not marginal: USDC and sUSDe sit at 0.00011 and 0.00031 daily volatility, and the
 * next asset up is XAUt at 0.01582 — a factor of fifty. This threshold sits in that
 * gap. Tokenised gold has near-zero betas too, so the volatility test is what keeps
 * it out of the dollar category, and the same asset defeating a price-band
 * heuristic is why `factors.ts` measures instead of banding.
 */
export const USD_MAX_VOLATILITY = 0.003;
export const USD_MAX_BETA = 0.1;

/**
 * An E-Mode category, which is not the same thing as a risk factor.
 *
 * `USD` is a category with no shock attached: there is no dollar anchor in the
 * regression and Sentinel never shocks stablecoins. It exists only to recognise
 * that two dollar-pegged assets are the same bet as each other.
 */
export type EmodeCategory = FactorId | "USD";

/**
 * `off`        published thresholds only. Contradicted accounts stay contradicted.
 * `inferred`   raise factor-aligned positions to the E-Mode ceiling.
 * `calibrated` upper bound: give every still-contradicted account exactly the
 *              threshold that makes it marginally solvent at the snapshot. This
 *              assumes the whole error is a missing threshold, which puts those
 *              accounts on the knife edge, so it overstates fragility as
 *              deliberately as `off` understates the thresholds.
 */
export type EmodeMode = "off" | "inferred" | "calibrated";

/**
 * The factor a single asset belongs to, if any does.
 *
 * Extracted so that the offline group derivation (`npm run emode:groups`, which
 * writes the enclave's risk policy) and the in-process inference cannot drift
 * apart. Both must call this: two definitions of "correlated" would mean the
 * enclave applying a threshold the app would not.
 *
 * Requires the beta to be both large and well-fitted: a 0.8 beta at an R2 of 0.1
 * is a number with no information in it, and E-Mode granted on that basis would
 * be an invented safety margin.
 */
export function classifyAsset(beta: AssetBeta | undefined): EmodeCategory | null {
  if (!beta || beta.confidence !== "measured") return null;

  // A dollar is recognised by not moving, which needs no goodness of fit: an R2
  // gate here would reject it, since there is no variance for the factors to
  // explain. That is why this test comes before the R2 one rather than after.
  if (
    beta.volatility < USD_MAX_VOLATILITY &&
    Math.abs(beta.betaEth) < USD_MAX_BETA &&
    Math.abs(beta.betaBtc) < USD_MAX_BETA
  ) {
    return "USD";
  }

  if (beta.r2 < MIN_FACTOR_R2) return null;
  if (Math.abs(beta.betaEth) >= 0.7) return "ETH";
  if (Math.abs(beta.betaBtc) >= 0.7) return "BTC";
  return null;
}

/**
 * How far an asset's loading on its own category's anchor may sit from 1, and how
 * much loading it may carry on the *other* anchor, to count as a wrapper of the
 * anchor rather than merely something with exposure to it.
 *
 * Measured on the live collateral set, the separation is clean and not fitted. The
 * four real ETH wrappers load 0.937-0.979 on ETH and at most 0.116 on BTC. LINK
 * loads 0.807 on ETH — which passes `classifyAsset` — but also 0.298 on BTC, and an
 * asset with independent BTC exposure is not a wrapper of ETH; it is a token with
 * broad market beta. The BTC wrappers behave the same way in mirror: 0.883-1.000 on
 * BTC and at most 0.028 on ETH.
 */
export const WRAPPER_BETA_TOLERANCE = 0.15;
export const WRAPPER_OFF_FACTOR_MAX = 0.2;

/**
 * Whether an asset tracks its category's anchor closely enough to share a
 * liquidation threshold with it.
 *
 * This is a stricter question than `classifyAsset` answers, and the difference is
 * deliberate. `classifyAsset` decides which factor's *shock* an asset receives, and
 * there a partial beta is not merely acceptable but correct: LINK really does fall
 * when ETH falls, by about 0.8 of the move, and shocking it that way is the honest
 * answer. Granting E-Mode is a different claim — that a protocol treats the two
 * assets as the same risk and will let a book run to 95% — and being wrong about it
 * inflates a borrower's solvency instead of merely mis-scaling a shock. LINK against
 * WETH is not an Aave E-Mode pair, and a rule that admitted it would be
 * manufacturing safety margin for a book that does not have it.
 *
 * So: same classifier, one additional requirement, applied only where an elevated
 * threshold is at stake. `USD` needs nothing extra — the volatility test in
 * `classifyAsset` is already the tight one, and a dollar has no anchor to track.
 */
export function tracksAnchor(beta: AssetBeta | undefined): boolean {
  const category = classifyAsset(beta);
  if (!beta || !category) return false;
  if (category === "USD") return true;

  const own = category === "ETH" ? beta.betaEth : beta.betaBtc;
  const other = category === "ETH" ? beta.betaBtc : beta.betaEth;
  return (
    Math.abs(Math.abs(own) - 1) <= WRAPPER_BETA_TOLERANCE &&
    Math.abs(other) <= WRAPPER_OFF_FACTOR_MAX
  );
}

/**
 * Which factor dominates a set of positions by value, if any does.
 */
export function dominantFactor(
  positions: Position[],
  betas: Map<string, AssetBeta>,
  prices: Map<string, number>,
): EmodeCategory | null {
  let total = 0;
  const byFactor: Record<EmodeCategory, number> = { ETH: 0, BTC: 0, USD: 0 };

  for (const p of positions) {
    const value = p.valueUsd;
    if (value <= 0) continue;
    total += value;
    const category = classifyAsset(betas.get(p.assetId.toLowerCase()));
    if (category) byFactor[category] += value;
  }

  if (total <= 0) return null;
  for (const factor of ["ETH", "BTC", "USD"] as const) {
    if (byFactor[factor] / total >= FACTOR_DOMINANCE) return factor;
  }
  return null;
}

export type EmodeDecision = {
  account: string;
  protocol: string;
  eligible: boolean;
  factor: EmodeCategory | null;
  /** Threshold before and after, weighted by collateral value. */
  thresholdBefore: number;
  thresholdAfter: number;
  healthBefore: number;
  healthAfter: number;
  reason: string;
};

/**
 * Decide E-Mode for one account inside one protocol.
 *
 * Applied only where the schema's own thresholds produce a contradiction — a
 * health factor below 1 on an account that is demonstrably still alive. Where the
 * account is already solvent under published parameters there is nothing to
 * resolve, and raising its threshold on a guess would invent safety margin that
 * suppresses liquidations the simulation should be finding.
 */
export function decideEmode(
  account: string,
  protocol: string,
  collateral: Position[],
  debt: Position[],
  betas: Map<string, AssetBeta>,
  prices: Map<string, number>,
): EmodeDecision {
  const collateralUsd = collateral.reduce((s, p) => s + p.valueUsd, 0);
  const debtUsd = debt.reduce((s, p) => s + p.valueUsd, 0);
  const weighted = collateral.reduce((s, p) => s + p.valueUsd * p.liquidationThreshold, 0);
  const thresholdBefore = collateralUsd > 0 ? weighted / collateralUsd : 0;
  const healthBefore = debtUsd > 0 ? weighted / debtUsd : Infinity;

  const base = {
    account,
    protocol,
    factor: null as EmodeCategory | null,
    thresholdBefore,
    thresholdAfter: thresholdBefore,
    healthBefore,
    healthAfter: healthBefore,
  };

  if (debtUsd <= 0 || healthBefore >= 1) {
    return { ...base, eligible: false, reason: "no contradiction to resolve" };
  }

  const collateralFactor = dominantFactor(collateral, betas, prices);
  const debtFactor = dominantFactor(debt, betas, prices);

  if (!collateralFactor || collateralFactor !== debtFactor) {
    return {
      ...base,
      eligible: false,
      reason:
        `health factor ${healthBefore.toFixed(3)} < 1 but collateral loads on ` +
        `${collateralFactor ?? "no single factor"} and debt on ${debtFactor ?? "no single factor"}, ` +
        `so E-Mode cannot explain it`,
    };
  }

  // Never lower a threshold: a market already publishing above the E-Mode
  // ceiling is telling us something we have no grounds to override.
  const thresholdAfter = Math.max(thresholdBefore, EMODE_THRESHOLD);
  const healthAfter = (collateralUsd * thresholdAfter) / debtUsd;

  return {
    ...base,
    eligible: true,
    factor: collateralFactor,
    thresholdAfter,
    healthAfter,
    reason:
      `collateral and debt both load on ${collateralFactor}, so the ${collateralFactor}-correlated ` +
      `E-Mode category applies: threshold ${thresholdBefore.toFixed(4)} -> ${thresholdAfter.toFixed(4)}, ` +
      `health ${healthBefore.toFixed(3)} -> ${healthAfter.toFixed(3)}`,
  };
}

/**
 * Effective liquidation threshold per collateral position, after E-Mode.
 *
 * Returned as a map rather than by mutating positions so that the same position
 * set can be simulated under both modes without being reloaded.
 */
export function effectiveThresholds(
  byAccountProtocol: Map<string, { collateral: Position[]; debt: Position[] }>,
  betas: Map<string, AssetBeta>,
  prices: Map<string, number>,
  mode: EmodeMode,
): {
  thresholds: Map<string, number>;
  decisions: EmodeDecision[];
  /** Books whose health factor is still below 1 at the snapshot, after treatment. */
  contradicted: Set<string>;
} {
  const thresholds = new Map<string, number>();
  const decisions: EmodeDecision[] = [];
  const contradicted = new Set<string>();

  for (const [key, group] of byAccountProtocol) {
    const [account, protocol] = key.split("|");
    for (const p of group.collateral) thresholds.set(p.id, p.liquidationThreshold);

    const decision = decideEmode(account, protocol, group.collateral, group.debt, betas, prices);
    if (mode !== "off") decisions.push(decision);

    if (mode === "inferred" && decision.eligible) {
      for (const p of group.collateral) {
        thresholds.set(p.id, Math.max(p.liquidationThreshold, EMODE_THRESHOLD));
      }
    }

    const collateralUsd = group.collateral.reduce((s, p) => s + p.valueUsd, 0);
    const debtUsd = group.debt.reduce((s, p) => s + p.valueUsd, 0);
    const weighted = group.collateral.reduce(
      (s, p) => s + p.valueUsd * (thresholds.get(p.id) ?? p.liquidationThreshold),
      0,
    );
    if (debtUsd <= 0 || weighted / debtUsd >= 1) continue;

    if (mode === "calibrated" && collateralUsd > 0) {
      // The threshold that makes this book exactly solvent, capped at 1: a
      // threshold above 1 would mean lending more than the collateral is worth,
      // which no protocol does, and reaching for it would mean the error is
      // something other than a threshold.
      const needed = Math.min(1, debtUsd / collateralUsd);
      for (const p of group.collateral) {
        thresholds.set(p.id, Math.max(thresholds.get(p.id) ?? 0, needed));
      }
      const recomputed = group.collateral.reduce(
        (s, p) => s + p.valueUsd * (thresholds.get(p.id) ?? 0),
        0,
      );
      if (recomputed / debtUsd >= 1) continue;
    }

    contradicted.add(key);
  }

  return { thresholds, decisions, contradicted };
}
