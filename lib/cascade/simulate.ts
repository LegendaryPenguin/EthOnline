/**
 * The cascade.
 *
 * A shock knocks collateral prices down. Accounts cross their liquidation
 * boundary. Liquidators seize collateral and sell it. Selling moves the price of
 * that collateral, which is *the same collateral other accounts are posting*, so
 * more accounts cross the boundary, and round two begins. That feedback loop is
 * the thing no single lending protocol can see, because the accounts it pushes
 * over are on other protocols, secured by the same assets, sold into the same
 * pools.
 *
 * Everything here is a pure function of the data handed in. No network, no clock,
 * no randomness: the same snapshot and the same shock always produce the same
 * cascade, which is what makes the sensitivity table meaningful and the whole
 * thing testable.
 *
 * Where the model is conservative, stated once and then relied upon:
 *   - betas are fitted over a normal year, and real correlations rise in a crash
 *   - constant-product on total reserves understates impact for range-exhausting
 *     trades, which is the regime every figure here sits in (see impact.ts)
 *   - debt balances come from event-written positions, so accrued interest is
 *     missing and debt is understated (Phase 3, 22 of 23 accounts)
 * All three push the same way. The output is a floor.
 */

import type { Position } from "../exposure/types";
import type { AssetLiquidity } from "../graph/dex";
import type { AssetBeta, FactorId } from "./factors";
import { effectiveThresholds, type EmodeDecision, type EmodeMode } from "./emode";
import { saleProceedsUsd, spotPriceRatio } from "./impact";
import type { MarketParams } from "./inputs";

/**
 * Aave's close factor. Above this health factor a liquidator may take at most
 * half the debt; at or below it, all of it. Compound V2/V3 use a flat 50% and a
 * full-liquidation trigger respectively, so this is the common shape rather than
 * any one protocol's exact rule — a simplification, and the direction it errs in
 * is toward smaller forced sales.
 */
export const FULL_LIQUIDATION_HEALTH = 0.95;

/** Fallback penalty when a market publishes none. Aave's most common value. */
export const DEFAULT_LIQUIDATION_PENALTY = 0.05;

/**
 * Hard iteration cap.
 *
 * The loop terminates naturally when a round clears nothing, and it must: every
 * liquidation strictly reduces outstanding debt, so the process is monotone and
 * bounded. The cap exists so that a bug cannot hang a build, and hitting it is
 * reported as non-convergence rather than silently truncated.
 *
 * It is high because the slippage cap makes each round clear only the bonus
 * fraction of remaining depth, so a fully distressed system drains liquidity
 * geometrically rather than in a handful of waves. A round is a wave of
 * liquidations competing for the same pools, not a fixed interval of time.
 */
export const MAX_ROUNDS = 500;

/**
 * A round stops selling an asset once slippage has eaten the liquidation bonus.
 *
 * This is the correction for the single largest error the first version of this
 * model made. Constant product on $402M of wstETH against $3.8M of measured depth
 * says the price falls 99.99%, and reporting that would be nonsense: liquidation
 * is a *voluntary* act by a third party who is paid the liquidation bonus and who
 * stops the instant the trade stops being profitable. So the volume that clears
 * per round is capped at the amount that keeps realised slippage inside the bonus,
 * and the rest does not clear at all.
 *
 * Solving `sell / (reserve + sell) = tolerance` for the sale that exactly exhausts
 * the bonus gives `sell = tolerance * reserve / (1 - tolerance)`, so a round moves
 * roughly the bonus-fraction of remaining depth. Everything beyond that is
 * reported as stranded collateral against still-outstanding debt, which is a far
 * more consequential output than a made-up price: it is the debt the system cannot
 * liquidate at any profitable price.
 */
export const SLIPPAGE_TOLERANCE_FLOOR = 0.01;

/** A round clearing less than this is treated as having cleared nothing. */
export const CONVERGENCE_EPSILON_USD = 1_000;

/** Volume that can clear against `reserve` while staying inside `tolerance`. */
export function clearableVolume(reserve: number, tolerance: number): number {
  const t = Math.max(SLIPPAGE_TOLERANCE_FLOOR, Math.min(0.99, tolerance));
  return (t * reserve) / (1 - t);
}

export type ShockSpec = Partial<Record<FactorId, number>>;

export type SimulationOptions = {
  positions: Position[];
  prices: Map<string, number>;
  betas: Map<string, AssetBeta>;
  liquidity: Map<string, AssetLiquidity>;
  marketParams: Map<string, MarketParams>;
  /** Factor declines as positive fractions: { ETH: 0.2 } is a 20% fall. */
  shocks: ShockSpec;
  emode?: EmodeMode;
  /** Scales all measured depth, for sensitivity to the impact model. */
  depthMultiplier?: number;
  maxRounds?: number;
};

export type RoundResult = {
  round: number;
  liquidatedDebtUsd: number;
  seizedCollateralUsd: number;
  accountsLiquidated: number;
  byProtocol: Record<string, number>;
  /** Forced sales of assets with no measurable depth, so no impact was applied. */
  unmodellableSalesUsd: number;
  /**
   * Debt the seized collateral could not cover once slippage is charged.
   *
   * A liquidation is only self-financing while the liquidation bonus exceeds the
   * price impact of selling the collateral. Past that point the protocol eats the
   * difference, and this is the number that decides whether a cascade is a bad day
   * for borrowers or an insolvency for lenders.
   */
  badDebtUsd: number;
};

export type CascadeResult = {
  shocks: ShockSpec;
  emode: EmodeMode;
  depthMultiplier: number;
  rounds: RoundResult[];
  converged: boolean;
  roundsToConvergence: number;
  /** Round 1: the direct consequence of the shock. */
  idiosyncraticDebtUsd: number;
  /** Rounds 2+: caused by other liquidations, not by the shock. */
  systemicDebtUsd: number;
  totalLiquidatedDebtUsd: number;
  /** systemicDebtUsd / idiosyncraticDebtUsd. The contagion multiplier. */
  amplification: number;
  /** Final price as a fraction of the pre-shock price, per asset. */
  finalPriceRatio: Record<string, number>;
  /** Extra decline caused purely by forced selling, per asset. */
  impactOnlyRatio: Record<string, number>;
  totalDebtUsd: number;
  /** Debt that was never at risk because its collateral had no measured beta. */
  unmeasuredCollateralUsd: number;
  emodeDecisions: EmodeDecision[];
  unmodellableSalesUsd: number;
  /** Total shortfall across all rounds: seized collateral minus what it fetched. */
  badDebtUsd: number;
  /**
   * Debt on books that compute as insolvent at the snapshot, before any shock.
   *
   * These are excluded from the simulation entirely. A book with a health factor
   * below 1 that is sitting un-liquidated on a live chain is telling us our
   * parameters are wrong, not that it is about to be liquidated — E-Mode is one
   * known cause and is corrected for, and whatever remains is measurement error we
   * cannot attribute. Liquidating them anyway would report a cascade at a 0% shock.
   */
  excludedContradictedDebtUsd: number;
  excludedContradictedBooks: number;
  /**
   * Debt left on books that are insolvent at the end but whose collateral could
   * not be sold at a price a liquidator would accept. The headline risk number.
   */
  unliquidatableDebtUsd: number;
  /** Collateral backing that debt, still held because selling it was unprofitable. */
  strandedCollateralUsd: number;
  /**
   * Every book that was liquidated or ended underwater, valued at *snapshot*
   * prices.
   *
   * The headline series, and denominated pre-shock on purpose. Liquidated volume
   * measured in post-shock dollars is not comparable across shocks: a 30% shock
   * shrinks the dollar value of the very collateral being seized, so a bigger
   * shock can seize fewer dollars while doing strictly more damage. That artefact
   * made the first sensitivity table appear to run backwards. This figure is
   * monotone in the shock, and `scripts/cascade.mts` asserts that it is.
   */
  distressedDebtUsd: number;
};

type Holding = { assetId: string; amount: number; threshold: number };

type Book = {
  account: string;
  protocol: string;
  collateral: Holding[];
  debt: Holding[];
  penalty: number;
};

/** Group positions into per-account, per-protocol books. Liquidation is per-protocol. */
function buildBooks(
  positions: Position[],
  marketParams: Map<string, MarketParams>,
  thresholds: Map<string, number>,
): Book[] {
  const groups = new Map<string, Book>();

  for (const p of positions) {
    const key = `${p.account}|${p.protocol}`;
    let book = groups.get(key);
    if (!book) {
      book = { account: p.account, protocol: p.protocol, collateral: [], debt: [], penalty: 0 };
      groups.set(key, book);
    }
    const holding: Holding = {
      assetId: p.assetId.toLowerCase(),
      amount: p.amount,
      threshold: thresholds.get(p.id) ?? p.liquidationThreshold,
    };
    if (p.side === "BORROWER") book.debt.push(holding);
    else book.collateral.push(holding);

    const penalty = marketParams.get(p.marketId.toLowerCase())?.liquidationPenalty ?? 0;
    if (penalty > 0) book.penalty = Math.max(book.penalty, penalty / 100);
  }

  for (const book of groups.values()) {
    if (book.penalty <= 0) book.penalty = DEFAULT_LIQUIDATION_PENALTY;
  }

  return [...groups.values()];
}

export function groupByAccountProtocol(
  positions: Position[],
): Map<string, { collateral: Position[]; debt: Position[] }> {
  const out = new Map<string, { collateral: Position[]; debt: Position[] }>();
  for (const p of positions) {
    const key = `${p.account}|${p.protocol}`;
    const g = out.get(key) ?? { collateral: [], debt: [] };
    if (p.side === "BORROWER") g.debt.push(p);
    else g.collateral.push(p);
    out.set(key, g);
  }
  return out;
}

export function simulateCascade({
  positions,
  prices,
  betas,
  liquidity,
  marketParams,
  shocks,
  emode = "inferred",
  depthMultiplier = 1,
  maxRounds = MAX_ROUNDS,
}: SimulationOptions): CascadeResult {
  const grouped = groupByAccountProtocol(positions);
  const { thresholds, decisions, contradicted } = effectiveThresholds(
    grouped,
    betas,
    prices,
    emode,
  );
  const allBooks = buildBooks(positions, marketParams, thresholds);
  const books = allBooks.filter((b) => !contradicted.has(`${b.account}|${b.protocol}`));

  let excludedContradictedDebtUsd = 0;
  for (const key of contradicted) {
    const g = grouped.get(key);
    if (g) excludedContradictedDebtUsd += g.debt.reduce((s, p) => s + p.valueUsd, 0);
  }

  // The exogenous shock, applied through each asset's measured betas. Betas are
  // fitted on log returns, so they compose in log space — using them on simple
  // returns would misprice large shocks, which is the only size that matters.
  const shockRatio = new Map<string, number>();
  for (const assetId of collectAssets(books)) {
    const beta = betas.get(assetId);
    const logShock =
      Math.log(1 - Math.min(0.999, shocks.ETH ?? 0)) * (beta?.betaEth ?? 0) +
      Math.log(1 - Math.min(0.999, shocks.BTC ?? 0)) * (beta?.betaBtc ?? 0);
    // shockForAsset returns 0 for unmeasured assets; keeping them at ratio 1 is
    // the deliberate choice not to invent an exposure. Their collateral is
    // reported as `unmeasuredCollateralUsd` so the omission is visible.
    const applied = beta && beta.confidence === "measured" ? Math.exp(logShock) : 1;
    shockRatio.set(assetId, applied);
  }

  /** Reserve in token units available to absorb forced selling. */
  const reserve = new Map<string, number>();
  for (const assetId of collectAssets(books)) {
    reserve.set(assetId, (liquidity.get(assetId)?.reserveTokens ?? 0) * depthMultiplier);
  }

  const soldTokens = new Map<string, number>();
  const priceOf = (assetId: string) => {
    const base = prices.get(assetId) ?? 0;
    const shock = shockRatio.get(assetId) ?? 1;
    const r = reserve.get(assetId) ?? 0;
    const sold = soldTokens.get(assetId) ?? 0;
    // No measurable depth means no modellable impact. Zero is the honest value:
    // assuming a collapse would manufacture the cascade this project exists to
    // measure. The volume that took this path is reported instead.
    const impact = r > 0 ? spotPriceRatio(sold, r) : 1;
    return base * shock * impact;
  };

  /** Books touched by the cascade, for the shock-invariant distress measure. */
  const distressed = new Set<string>();
  const snapshotDebt = new Map<string, number>();
  for (const [key, g] of grouped) {
    snapshotDebt.set(key, g.debt.reduce((s, p) => s + p.valueUsd, 0));
  }

  const rounds: RoundResult[] = [];
  let unmodellableSalesUsd = 0;
  let badDebtUsd = 0;
  let converged = false;

  for (let round = 1; round <= maxRounds; round++) {
    const result: RoundResult = {
      round,
      liquidatedDebtUsd: 0,
      seizedCollateralUsd: 0,
      accountsLiquidated: 0,
      byProtocol: {},
      unmodellableSalesUsd: 0,
      badDebtUsd: 0,
    };
    const pending = new Map<string, number>();

    // Prices are frozen for the duration of a round and the sales of the whole
    // round are applied at the end. Liquidations inside one round are concurrent
    // in reality — they land in the same blocks — and sequencing them would make
    // the result depend on account ordering, which is not a real quantity.
    //
    // Two passes, because the sale cap is a property of the asset and not of any
    // one liquidator: pass one works out what every liquidator wants to do, then
    // the asset's clearable volume is shared out, then pass two executes the part
    // that clears. Doing it in one pass would give whichever book happened to be
    // first in the array the whole of the depth.
    type Intent = { book: Book; repayUsd: number; seize: Map<string, number> };
    const intents: Intent[] = [];
    const desired = new Map<string, number>();
    const penaltyWeight = new Map<string, number>();

    for (const book of books) {
      const debtUsd = book.debt.reduce((s, h) => s + h.amount * priceOf(h.assetId), 0);
      if (debtUsd <= 0) continue;
      const collateralUsd = book.collateral.reduce((s, h) => s + h.amount * priceOf(h.assetId), 0);
      const weighted = book.collateral.reduce(
        (s, h) => s + h.amount * priceOf(h.assetId) * h.threshold,
        0,
      );
      const health = weighted / debtUsd;
      if (health >= 1) continue;

      const closeFactor = health <= FULL_LIQUIDATION_HEALTH ? 1 : 0.5;
      const repayUsd = Math.min(debtUsd * closeFactor, collateralUsd / (1 + book.penalty));
      if (repayUsd <= 0) continue;
      const seizeUsd = Math.min(repayUsd * (1 + book.penalty), collateralUsd);

      // Seized pro-rata across the account's collateral in this protocol.
      // Liquidators in fact choose, but their preference is unobservable, and any
      // guess at it would be a free parameter no data constrains.
      const seize = new Map<string, number>();
      for (const h of book.collateral) {
        const price = priceOf(h.assetId);
        if (price <= 0 || h.amount <= 0) continue;
        const share = (h.amount * price) / collateralUsd;
        const tokens = Math.min(h.amount, (seizeUsd * share) / price);
        if (tokens <= 0) continue;
        seize.set(h.assetId, (seize.get(h.assetId) ?? 0) + tokens);
        desired.set(h.assetId, (desired.get(h.assetId) ?? 0) + tokens);
        penaltyWeight.set(
          h.assetId,
          (penaltyWeight.get(h.assetId) ?? 0) + tokens * book.penalty,
        );
      }
      if (seize.size === 0) continue;
      intents.push({ book, repayUsd, seize });
    }

    // How much of each asset a liquidator would actually sell this round. The
    // tolerance is the bonus they are paid, averaged over the sales competing for
    // the same pool and weighted by size, since that is the profit the slippage
    // has to come out of.
    const clearable = new Map<string, number>();
    for (const [assetId, tokens] of desired) {
      const r = reserve.get(assetId) ?? 0;
      if (r <= 0) {
        // No measured depth: nothing is provably clearable, so nothing clears.
        // The first version sold these at book value with no impact, which quietly
        // financed the cascade out of liquidity that was never shown to exist.
        clearable.set(assetId, 0);
        continue;
      }
      const remaining = Math.max(0, r - (soldTokens.get(assetId) ?? 0));
      const tolerance = tokens > 0 ? (penaltyWeight.get(assetId) ?? 0) / tokens : 0;
      clearable.set(assetId, Math.min(tokens, clearableVolume(remaining, tolerance)));
    }

    // A book executes at the worst scale across the assets it must sell: a
    // liquidator cannot repay the debt without disposing of all of the collateral
    // they seize for it.
    for (const intent of intents) {
      let scale = 1;
      for (const [assetId, tokens] of intent.seize) {
        const allowed = clearable.get(assetId) ?? 0;
        const share = (desired.get(assetId) ?? 0) > 0 ? tokens / desired.get(assetId)! : 0;
        scale = Math.min(scale, tokens > 0 ? (allowed * share) / tokens : 0);
      }
      if (!(scale > 0)) continue;

      for (const [assetId, tokens] of intent.seize) {
        const take = tokens * scale;
        const holding = intent.book.collateral.find((h) => h.assetId === assetId);
        if (!holding) continue;
        holding.amount = Math.max(0, holding.amount - take);
        pending.set(assetId, (pending.get(assetId) ?? 0) + take);
      }

      const debtUsd = intent.book.debt.reduce((s, h) => s + h.amount * priceOf(h.assetId), 0);
      const repayUsd = intent.repayUsd * scale;
      if (debtUsd > 0) {
        const repayShare = Math.min(1, repayUsd / debtUsd);
        for (const h of intent.book.debt) h.amount -= h.amount * repayShare;
      }

      result.liquidatedDebtUsd += repayUsd;
      result.seizedCollateralUsd += repayUsd * (1 + intent.book.penalty);
      result.accountsLiquidated += 1;
      result.byProtocol[intent.book.protocol] =
        (result.byProtocol[intent.book.protocol] ?? 0) + repayUsd;
      distressed.add(`${intent.book.account}|${intent.book.protocol}`);
    }

    // Convergence is "no more debt clears", not "no more accounts are insolvent".
    // Under the slippage cap those are different states, and the difference is the
    // finding: a cascade can end with accounts still deeply underwater because
    // nobody can profitably liquidate them.
    if (result.liquidatedDebtUsd < CONVERGENCE_EPSILON_USD) {
      converged = true;
      break;
    }

    // Proceeds are charged slippage against the depth remaining after everything
    // already sold in earlier rounds, which is why the marginal round of a cascade
    // is so much more damaging than the first.
    let proceedsUsd = 0;
    for (const [assetId, tokens] of pending) {
      const r = reserve.get(assetId) ?? 0;
      const price = priceOf(assetId);
      if (r <= 0) continue; // never selected: clearable volume is 0 without depth
      // Slippage is charged against the depth remaining after everything already
      // sold in earlier rounds, which is why the marginal round of a cascade is
      // more damaging than the first.
      const remaining = Math.max(0, r - (soldTokens.get(assetId) ?? 0));
      proceedsUsd += saleProceedsUsd(tokens, price, remaining);
      soldTokens.set(assetId, (soldTokens.get(assetId) ?? 0) + tokens);
    }
    result.badDebtUsd = Math.max(0, result.liquidatedDebtUsd - proceedsUsd);
    badDebtUsd += result.badDebtUsd;

    rounds.push(result);
  }

  const idiosyncraticDebtUsd = rounds[0]?.liquidatedDebtUsd ?? 0;
  const systemicDebtUsd = rounds.slice(1).reduce((s, r) => s + r.liquidatedDebtUsd, 0);
  const totalDebtUsd = positions
    .filter((p) => p.side === "BORROWER")
    .reduce((s, p) => s + p.valueUsd, 0);
  const unmeasuredCollateralUsd = positions
    .filter(
      (p) =>
        p.side === "COLLATERAL" &&
        betas.get(p.assetId.toLowerCase())?.confidence !== "measured",
    )
    .reduce((s, p) => s + p.valueUsd, 0);

  // What is left underwater when the cascade stops: debt nobody could profitably
  // liquidate, and the collateral still sitting against it.
  let unliquidatableDebtUsd = 0;
  let strandedCollateralUsd = 0;
  for (const book of books) {
    const debtUsd = book.debt.reduce((s, h) => s + h.amount * priceOf(h.assetId), 0);
    if (debtUsd <= 0) continue;
    const weighted = book.collateral.reduce(
      (s, h) => s + h.amount * priceOf(h.assetId) * h.threshold,
      0,
    );
    if (weighted / debtUsd >= 1) continue;
    unliquidatableDebtUsd += debtUsd;
    distressed.add(`${book.account}|${book.protocol}`);
    strandedCollateralUsd += book.collateral.reduce(
      (s, h) => s + h.amount * priceOf(h.assetId),
      0,
    );
  }

  const finalPriceRatio: Record<string, number> = {};
  const impactOnlyRatio: Record<string, number> = {};
  for (const assetId of collectAssets(books)) {
    const base = prices.get(assetId) ?? 0;
    if (base <= 0) continue;
    const r = reserve.get(assetId) ?? 0;
    const sold = soldTokens.get(assetId) ?? 0;
    const impact = r > 0 ? spotPriceRatio(sold, r) : 1;
    finalPriceRatio[assetId] = (shockRatio.get(assetId) ?? 1) * impact;
    impactOnlyRatio[assetId] = impact;
  }

  return {
    shocks,
    emode,
    depthMultiplier,
    rounds,
    converged,
    roundsToConvergence: rounds.length,
    idiosyncraticDebtUsd,
    systemicDebtUsd,
    totalLiquidatedDebtUsd: idiosyncraticDebtUsd + systemicDebtUsd,
    amplification: idiosyncraticDebtUsd > 0 ? systemicDebtUsd / idiosyncraticDebtUsd : 0,
    finalPriceRatio,
    impactOnlyRatio,
    totalDebtUsd,
    unmeasuredCollateralUsd,
    emodeDecisions: decisions,
    unmodellableSalesUsd,
    badDebtUsd,
    excludedContradictedDebtUsd,
    excludedContradictedBooks: contradicted.size,
    unliquidatableDebtUsd,
    strandedCollateralUsd,
    distressedDebtUsd: [...distressed].reduce((s, k) => s + (snapshotDebt.get(k) ?? 0), 0),
  };
}

function collectAssets(books: Book[]): Set<string> {
  const out = new Set<string>();
  for (const b of books) {
    for (const h of b.collateral) out.add(h.assetId);
    for (const h of b.debt) out.add(h.assetId);
  }
  return out;
}
