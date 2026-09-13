/**
 * The shock ladder: the cascade recomputed at every shock level the slider can reach.
 *
 * The slider could instead run the simulation in the browser on each drag. It would be
 * slower and it would be worse: the model needs a year of oracle history, DEX depth
 * across four deployments and every position in the sample, which is 29 MB of JSON that
 * would have to cross the wire and stay correct in a second implementation. Precomputing
 * the ladder server-side means the client interpolates between rungs that came out of the
 * *same* simulation the evidence documents were written from, and a dropped frame is a
 * rendering problem rather than a modelling one.
 *
 * Each rung carries both the point estimate (E-Mode inferred) and the upper bound
 * (E-Mode calibrated), because a single number here would be a claim the model cannot
 * support — see `docs/evidence/phase4-cascade.md`.
 */

import type { AssetLiquidity } from "../graph/dex";
import type { AssetBeta } from "../cascade/factors";
import type { CascadeInputs } from "../cascade/inputs";
import { simulateCascade, type CascadeResult } from "../cascade/simulate";

/** One shock level, in basis points of price decline applied to both ETH and BTC. */
export type ShockRung = {
  shockBps: number;
  converged: boolean;
  roundsToConvergence: number;
  /** Round 1: the direct consequence of the shock. */
  idiosyncraticDebtUsd: number;
  /** Rounds 2+: liquidations caused by other liquidations. */
  systemicDebtUsd: number;
  totalLiquidatedDebtUsd: number;
  amplification: number;
  distressedDebtUsd: number;
  unliquidatableDebtUsd: number;
  strandedCollateralUsd: number;
  badDebtUsd: number;
  rounds: {
    round: number;
    liquidatedDebtUsd: number;
    seizedCollateralUsd: number;
    accountsLiquidated: number;
    badDebtUsd: number;
    unmodellableSalesUsd: number;
    byProtocol: Record<string, number>;
  }[];
  /**
   * Rounds past `MAX_SHOWN_ROUNDS`, collapsed.
   *
   * A cascade can run for hundreds of rounds under the calibrated bound, each clearing a
   * few thousand dollars. Shipping all of them would triple the payload to draw bars a
   * pixel tall, so the tail is summarised — and shown as a summary, not dropped.
   */
  tail: { rounds: number; liquidatedDebtUsd: number; badDebtUsd: number } | null;
  /** The calibrated-E-Mode bracket: what the same shock does if every ambiguous book sits at its boundary. */
  upperBound: {
    distressedDebtUsd: number;
    totalLiquidatedDebtUsd: number;
    unliquidatableDebtUsd: number;
    strandedCollateralUsd: number;
    badDebtUsd: number;
    roundsToConvergence: number;
  };
  /** Debt on books the model refuses to simulate because they compute as already insolvent. */
  excludedContradictedDebtUsd: number;
  excludedContradictedBooks: number;
};

export type ShockLadder = {
  generatedAt: string;
  /** Block per lending deployment, from the snapshot the positions came from. */
  blocks: Record<string, number>;
  totalDebtUsd: number;
  protocols: string[];
  /** Share of cross-protocol collateral value covered by the modelled assets. */
  assetCoverage: number;
  steps: ShockRung[];
  /**
   * Shock levels where distress *falls* as the shock grows.
   *
   * Not a modelling error, and not smoothed away: 72% of the sample's debt is
   * WETH-denominated, so a book collateralized in something less ETH-correlated gets
   * safer as ETH falls — its debt shrinks in USD faster than its collateral does. The
   * interface shows these, because a chart that rose monotonically would be asserting
   * something about lending markets that is not true.
   */
  distressReversals: { shockBps: number; previousShockBps: number; fellByUsd: number }[];
};

/** 0% to 40% in one-point steps: past 40% the model's depth assumptions stop meaning much. */
export function defaultShockLadderBps(): number[] {
  return Array.from({ length: 41 }, (_, i) => i * 100);
}

/** Rounds shown individually in the timeline. Enough to see amplification take hold. */
export const MAX_SHOWN_ROUNDS = 20;

function rungFrom(point: CascadeResult, upper: CascadeResult, shockBps: number): ShockRung {
  const shown = point.rounds.slice(0, MAX_SHOWN_ROUNDS);
  const rest = point.rounds.slice(MAX_SHOWN_ROUNDS);
  return {
    shockBps,
    converged: point.converged,
    roundsToConvergence: point.roundsToConvergence,
    idiosyncraticDebtUsd: point.idiosyncraticDebtUsd,
    systemicDebtUsd: point.systemicDebtUsd,
    totalLiquidatedDebtUsd: point.totalLiquidatedDebtUsd,
    amplification: point.amplification,
    distressedDebtUsd: point.distressedDebtUsd,
    unliquidatableDebtUsd: point.unliquidatableDebtUsd,
    strandedCollateralUsd: point.strandedCollateralUsd,
    badDebtUsd: point.badDebtUsd,
    rounds: shown.map((r) => ({
      round: r.round,
      liquidatedDebtUsd: r.liquidatedDebtUsd,
      seizedCollateralUsd: r.seizedCollateralUsd,
      accountsLiquidated: r.accountsLiquidated,
      badDebtUsd: r.badDebtUsd,
      unmodellableSalesUsd: r.unmodellableSalesUsd,
      byProtocol: r.byProtocol,
    })),
    tail:
      rest.length === 0
        ? null
        : {
            rounds: rest.length,
            liquidatedDebtUsd: rest.reduce((s, r) => s + r.liquidatedDebtUsd, 0),
            badDebtUsd: rest.reduce((s, r) => s + r.badDebtUsd, 0),
          },
    upperBound: {
      distressedDebtUsd: upper.distressedDebtUsd,
      totalLiquidatedDebtUsd: upper.totalLiquidatedDebtUsd,
      unliquidatableDebtUsd: upper.unliquidatableDebtUsd,
      strandedCollateralUsd: upper.strandedCollateralUsd,
      badDebtUsd: upper.badDebtUsd,
      roundsToConvergence: upper.roundsToConvergence,
    },
    excludedContradictedDebtUsd: point.excludedContradictedDebtUsd,
    excludedContradictedBooks: point.excludedContradictedBooks,
  };
}

export function buildShockLadder(options: {
  inputs: CascadeInputs;
  betas: Map<string, AssetBeta>;
  liquidity: Map<string, AssetLiquidity>;
  shocksBps?: number[];
  onProgress?: (message: string) => void;
}): ShockLadder {
  const { inputs, betas, liquidity, onProgress } = options;
  const shocksBps = options.shocksBps ?? defaultShockLadderBps();

  const protocols = [...new Set(inputs.positions.map((p) => p.protocol))].sort();
  const steps: ShockRung[] = [];
  let totalDebtUsd = 0;

  for (const shockBps of shocksBps) {
    const shocks = { ETH: shockBps / 10_000, BTC: shockBps / 10_000 };
    const base = { positions: inputs.positions, prices: inputs.prices, betas, liquidity, marketParams: inputs.marketParams, shocks };
    const point = simulateCascade({ ...base, emode: "inferred" });
    const upper = simulateCascade({ ...base, emode: "calibrated" });
    steps.push(rungFrom(point, upper, shockBps));
    totalDebtUsd = point.totalDebtUsd;
    onProgress?.(
      `${(shockBps / 100).toFixed(0)}% shock: ${point.rounds.length} rounds, ` +
        `$${Math.round(point.totalLiquidatedDebtUsd).toLocaleString("en-US")} liquidated`,
    );
  }

  // The zero rung is the model's own sanity check, kept in the ladder so the UI can
  // show it: a shock of nothing must liquidate nothing, or every rung above it is
  // reporting liquidations the live chain disproves by the positions still being open.
  const zero = steps.find((s) => s.shockBps === 0);
  if (zero && zero.totalLiquidatedDebtUsd > 0) {
    throw new Error(
      `zero-shock invariant violated: $${Math.round(zero.totalLiquidatedDebtUsd)} liquidated at a 0% shock`,
    );
  }

  // Distress at the five-point grid must still rise with the shock. That coarse claim is
  // what `docs/evidence/phase4-cascade.md` reports and what caught the original bug —
  // contradicted books flooding round 1 — so it stays a hard gate. On the one-point grid
  // the same comparison is not an invariant at all, for the reason recorded on
  // `distressReversals`, so reversals there are collected rather than thrown.
  const coarse = steps.filter((s) => s.shockBps % 500 === 0);
  for (let i = 1; i < coarse.length; i++) {
    const drop = coarse[i - 1].distressedDebtUsd - coarse[i].distressedDebtUsd;
    if (drop > 1) {
      throw new Error(
        `monotonicity violated on the five-point grid: a ${coarse[i].shockBps / 100}% shock ` +
          `distresses $${Math.round(drop)} less debt than ${coarse[i - 1].shockBps / 100}%`,
      );
    }
  }

  const distressReversals: ShockLadder["distressReversals"] = [];
  for (let i = 1; i < steps.length; i++) {
    const fellByUsd = steps[i - 1].distressedDebtUsd - steps[i].distressedDebtUsd;
    if (fellByUsd > 1) {
      distressReversals.push({
        shockBps: steps[i].shockBps,
        previousShockBps: steps[i - 1].shockBps,
        fellByUsd,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    blocks: inputs.blocks,
    totalDebtUsd,
    protocols,
    assetCoverage: inputs.assetCoverage,
    steps,
    distressReversals,
  };
}
