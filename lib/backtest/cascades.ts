/**
 * Cascade episodes, and how to score a warning against one.
 *
 * Phase 3's backtest (`docs/BACKTEST.md`) asks a per-account question: was *this*
 * borrower liquidatable the block before it was liquidated. This module asks the
 * question Sentinel's signal actually answers, which is a different one — was the
 * *system* abnormal before many borrowers were liquidated at once — and it is the
 * only question a single published number can be scored on.
 *
 * The distinction is not pedantic. A $1.3M liquidation of one account happened in
 * this window and is not a cascade; a $225k liquidation of thirty accounts across
 * three protocols in one hour is. A systemic-risk oracle that fired on the first
 * would be measuring whale activity. So an episode is defined by **breadth** —
 * distinct accounts, across distinct protocols — with volume as a tiebreak, not as
 * the definition.
 *
 * Everything here is pure. The network work lives in `replay-signal.ts` and the
 * orchestration in `scripts/backtest-cascades.mts`, so the labelling rules and the
 * AUC arithmetic can be tested against constructed cases with no gateway.
 */

import type { LiquidationEvent } from "./replay";

/** Aggregation grain. One hour: fine enough to time an event, coarse enough that a
 * multi-transaction cascade lands in one or two buckets rather than scattering. */
export const BUCKET_SECONDS = 3600;

export type Bucket = {
  /** `floor(timestamp / BUCKET_SECONDS)`. */
  hour: number;
  /** Lowest block seen in the bucket, which is where the episode starts. */
  firstBlock: number;
  lastBlock: number;
  usd: number;
  rows: number;
  accounts: Set<string>;
  protocols: Set<string>;
};

export function bucketLiquidations(events: LiquidationEvent[]): Map<number, Bucket> {
  const out = new Map<number, Bucket>();
  for (const e of events) {
    const hour = Math.floor(e.timestamp / BUCKET_SECONDS);
    let b = out.get(hour);
    if (!b) {
      b = {
        hour,
        firstBlock: e.blockNumber,
        lastBlock: e.blockNumber,
        usd: 0,
        rows: 0,
        accounts: new Set(),
        protocols: new Set(),
      };
      out.set(hour, b);
    }
    b.firstBlock = Math.min(b.firstBlock, e.blockNumber);
    b.lastBlock = Math.max(b.lastBlock, e.blockNumber);
    b.usd += e.amountUsd;
    b.rows += 1;
    b.accounts.add(e.liquidatee);
    b.protocols.add(e.protocol);
  }
  return out;
}

export type CascadeEpisode = {
  /** Stable, sortable, and readable in a table: the ISO hour it began. */
  id: string;
  startHour: number;
  endHour: number;
  /** The block the episode begins at. Every replay must read strictly before this. */
  startBlock: number;
  endBlock: number;
  usd: number;
  rows: number;
  accounts: number;
  protocols: string[];
};

export type CascadeRules = {
  /** Distinct accounts liquidated across the run. Breadth, not size. */
  minAccounts: number;
  /** Distinct protocols the run touches. 1 would admit a single protocol's bad day. */
  minProtocols: number;
  /**
   * Empty hours tolerated inside one episode before it is split. A cascade is a
   * wave: liquidation bots clear what is profitable, prices settle, and the next
   * tranche crosses an hour later. Zero would shatter one event into three.
   */
  maxGapHours: number;
  /**
   * A floor on liquidated value, which breadth alone does not imply.
   *
   * Added after the first run measured what breadth alone admits: 253 "episodes" in a
   * year, with sizes down to **$4 across 8 accounts on 2 protocols**. Those are bots
   * sweeping dust — a routine background process that happens to be wide — and they
   * arrive mostly on the two deployments whose indexing the reconciliation gate
   * already rejects. Scoring a systemic-risk signal against them is scoring it against
   * noise, and it will correctly fail.
   *
   * So breadth is necessary and not sufficient. The pair of conditions is the
   * definition: many borrowers, several protocols, and enough value that a risk desk
   * would have wanted to know.
   */
  minUsd: number;
};

/**
 * Contiguous runs of liquidation activity that clear the breadth rules.
 *
 * Returned newest-last, in time order, with every qualifying run — the caller
 * decides how many to replay and publishes the ones it dropped. Ranking here would
 * hide the shape of the distribution, and the shape is the finding: in the window
 * this was measured on, the qualifying episodes are a handful and everything else
 * is a single account being liquidated alone.
 */
export function detectCascades(
  buckets: Map<number, Bucket>,
  rules: CascadeRules,
): CascadeEpisode[] {
  const hours = [...buckets.keys()].sort((a, b) => a - b);
  if (hours.length === 0) return [];

  const runs: Bucket[][] = [];
  let current: Bucket[] = [buckets.get(hours[0])!];
  for (let i = 1; i < hours.length; i++) {
    const gap = hours[i] - hours[i - 1] - 1;
    if (gap > rules.maxGapHours) {
      runs.push(current);
      current = [];
    }
    current.push(buckets.get(hours[i])!);
  }
  runs.push(current);

  const out: CascadeEpisode[] = [];
  for (const run of runs) {
    const accounts = new Set<string>();
    const protocols = new Set<string>();
    let usd = 0;
    let rows = 0;
    for (const b of run) {
      for (const a of b.accounts) accounts.add(a);
      for (const p of b.protocols) protocols.add(p);
      usd += b.usd;
      rows += b.rows;
    }
    if (accounts.size < rules.minAccounts) continue;
    if (protocols.size < rules.minProtocols) continue;
    if (usd < rules.minUsd) continue;

    out.push({
      id: new Date(run[0].hour * BUCKET_SECONDS * 1000).toISOString().slice(0, 16) + "Z",
      startHour: run[0].hour,
      endHour: run[run.length - 1].hour,
      startBlock: Math.min(...run.map((b) => b.firstBlock)),
      endBlock: Math.max(...run.map((b) => b.lastBlock)),
      usd,
      rows,
      accounts: accounts.size,
      protocols: [...protocols].sort(),
    });
  }
  return out;
}

/**
 * Hours that are ordinary: the negative labels.
 *
 * Choosing these badly is the easiest way to manufacture a good AUC, so the rule is
 * stated precisely and it is *not* "no liquidations at all". Two conditions:
 *
 *   - at least `separationHours` from any detected episode, since the whole claim
 *     under test is that the hours *before* an episode look elevated. Sampling a
 *     negative six hours before a cascade would label the signal's correct warning
 *     as a false positive and flatter the baseline instead.
 *   - the hour's own activity does not itself clear the breadth-and-size rules, so a
 *     negative is never an unlabelled positive.
 *
 * The first version of this required no liquidation anywhere within a six-hour radius,
 * which sounds stricter and was in fact wrong twice over. It admitted **5 negatives
 * from 8,700 hours**, which cannot support an ROC curve and forced them into one
 * cluster of the calendar — so the resulting AUC measured the signal's slow level
 * drift between that cluster and the positives, not any warning. And its implicit
 * claim, that any liquidation anywhere is abnormal, is contradicted by the data it
 * was run on: 1,265 of 2,686 active hours liquidated exactly one account. Individual
 * liquidations are the background state of a lending market, not a systemic event.
 *
 * Spread evenly across the eligible range rather than taken at random, so the set
 * is deterministic and re-runnable.
 */
export function quietHours(
  buckets: Map<number, Bucket>,
  episodes: CascadeEpisode[],
  range: { firstHour: number; lastHour: number },
  opts: { count: number; separationHours: number; rules: CascadeRules },
): number[] {
  const eligible: number[] = [];
  for (let h = range.firstHour; h <= range.lastHour; h++) {
    let clean = true;
    const own = buckets.get(h);
    if (
      own &&
      own.accounts.size >= opts.rules.minAccounts &&
      own.protocols.size >= opts.rules.minProtocols &&
      own.usd >= opts.rules.minUsd
    ) {
      continue;
    }
    for (const ep of episodes) {
      if (
        h >= ep.startHour - opts.separationHours &&
        h <= ep.endHour + opts.separationHours
      ) {
        clean = false;
        break;
      }
    }
    if (clean) eligible.push(h);
  }

  if (eligible.length <= opts.count) return eligible;
  const stride = eligible.length / opts.count;
  const out: number[] = [];
  for (let i = 0; i < opts.count; i++) out.push(eligible[Math.floor(i * stride)]);
  return out;
}

/**
 * Area under the ROC curve, by the rank identity rather than by integrating a curve.
 *
 * AUC is the probability that a randomly chosen positive outscores a randomly chosen
 * negative, which the Mann-Whitney U statistic gives exactly — no threshold grid, no
 * trapezoid error, and ties handled by counting them as half a win, which is the
 * correct treatment and the one a curve drawn through a few points gets wrong.
 *
 * Returns `null` rather than 0.5 when either class is empty. A degenerate AUC that
 * looks like a coin flip is indistinguishable from a real one, and this figure is
 * the phase's headline.
 */
export function auc(scored: { score: number; positive: boolean }[]): number | null {
  const pos = scored.filter((s) => s.positive).map((s) => s.score);
  const neg = scored.filter((s) => !s.positive).map((s) => s.score);
  if (pos.length === 0 || neg.length === 0) return null;

  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

export type RocPoint = { threshold: number; tpr: number; fpr: number; tp: number; fp: number };

/**
 * The ROC curve at every threshold the data actually distinguishes.
 *
 * Thresholds come from the observed scores rather than a fixed grid, because a grid
 * either misses the operating point or invents resolution the sample cannot support.
 * `>=` throughout, matching how an alert policy fires.
 */
export function rocCurve(scored: { score: number; positive: boolean }[]): RocPoint[] {
  const pos = scored.filter((s) => s.positive).length;
  const neg = scored.length - pos;
  if (pos === 0 || neg === 0) return [];

  const thresholds = [...new Set(scored.map((s) => s.score))].sort((a, b) => b - a);
  return thresholds.map((threshold) => {
    const tp = scored.filter((s) => s.positive && s.score >= threshold).length;
    const fp = scored.filter((s) => !s.positive && s.score >= threshold).length;
    return { threshold, tp, fp, tpr: tp / pos, fpr: fp / neg };
  });
}

/**
 * The alert threshold, calibrated on the negatives alone.
 *
 * Deliberately not the threshold that maximises separation: that one is fitted to
 * the positives, and a lead time measured against it would be a lead time fitted to
 * the events it is reporting on. Taking a high quantile of the *quiet* scores
 * defines "abnormal" without ever consulting an outcome, so every lead time below is
 * out-of-sample with respect to the labels.
 */
export function calibrateThreshold(quietScores: number[], quantileP: number): number {
  return quantile(quietScores, quantileP);
}

export type PairedResult = {
  /** Comparisons with a non-zero difference. Ties carry no information and are dropped. */
  n: number;
  wins: number;
  ties: number;
  winRate: number;
  /** Two-sided exact binomial, so a 3-of-4 result cannot be read as significant. */
  pValue: number;
};

/**
 * A paired sign test, which is the statistic this study actually needs.
 *
 * The unpaired AUC turned out to be measuring the wrong thing, and measurably so. The
 * signal is a *level* that drifts slowly — 31 in July, 21 in September, a ten-point
 * move against under one point of within-episode variation — so comparing a positive
 * in one month to a negative in another compares calendars, not conditions. The first
 * run scored AUC 0.271 for Sentinel and 0.277 for the baseline: both far below chance,
 * in lockstep, which is the signature of a shared confound rather than of two useless
 * measurements.
 *
 * Pairing removes it. Each episode is compared to *itself* at a control block one week
 * earlier, same hour of the week, so the drift, the weekly cycle and the composition of
 * the book are all held roughly fixed and the only systematic difference left is that
 * one block precedes a cascade. The test asks how often the pre-event score exceeds its
 * own control, which needs no threshold and no calibration.
 *
 * Ties are dropped rather than split, the conservative choice: a signal that returns an
 * identical number at both blocks has not distinguished them.
 */
export function signTest(deltas: number[]): PairedResult {
  const nonZero = deltas.filter((d) => d !== 0);
  const wins = nonZero.filter((d) => d > 0).length;
  const n = nonZero.length;
  return {
    n,
    wins,
    ties: deltas.length - n,
    winRate: n > 0 ? wins / n : 0,
    pValue: twoSidedBinomialP(wins, n),
  };
}

/** Exact two-sided binomial tail at p = 0.5. Returns 1 for n = 0: no evidence. */
function twoSidedBinomialP(wins: number, n: number): number {
  if (n === 0) return 1;
  const extreme = Math.max(wins, n - wins);
  let tail = 0;
  for (let k = extreme; k <= n; k++) tail += binomial(n, k);
  // Doubling the one-sided tail is exact here because the null is symmetric.
  return Math.min(1, (2 * tail) / 2 ** n);
}

function binomial(n: number, k: number): number {
  let c = 1;
  for (let i = 0; i < k; i++) c = (c * (n - i)) / (i + 1);
  return c;
}

/** Linear-interpolated quantile. Empty input throws: a silent 0 would read as a score. */
export function quantile(xs: number[], p: number): number {
  if (xs.length === 0) throw new Error("quantile: no observations");
  if (p < 0 || p > 1) throw new Error(`quantile: p out of range (${p})`);
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const idx = p * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (idx - lo) * (s[hi] - s[lo]);
}
