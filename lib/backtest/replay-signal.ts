/**
 * The published signal, recomputed at a historical block.
 *
 * This is the enclave's own three-pass plan from `lib/signal/enclave-queries.ts`
 * with a block argument threaded through it, and that is deliberate to the point of
 * being the main design decision in Phase 6. A backtest that samples differently
 * from the product measures a system nobody ships: if the historical scorer read
 * whole books while the enclave reads the top N positions per market, a good AUC
 * would be evidence about the scorer, not about Sentinel. So there are no new query
 * builders here — the same functions, the same reconciliation gate, the same
 * `aggregateSignal`, one extra argument.
 *
 * It also happens to fit. Three calls per deployment per block is ~6 per scored
 * block on the two deployments that serve history at all, which is why a study over
 * dozens of blocks is a few hundred calls rather than tens of thousands.
 *
 * Two hard constraints this module enforces rather than documents:
 *
 *   - **No lookahead.** `signalAtBlock` takes one block and passes it to every
 *     query. Nothing here reads a liquidation, a later block, or an outcome, and
 *     `__tests__/no-lookahead.test.ts` asserts that by inspecting the documents
 *     this builds. The scorer cannot cheat because it is never handed the answer.
 *   - **Not every block is readable.** Indexers retain state for a bounded depth
 *     (measured at ~481,250 blocks on `aave-v3-eth`), so a block outside it is
 *     reported as unavailable rather than scored from whatever subset answered. A
 *     signal assembled from one protocol when two were asked for is not a lower
 *     bound, it is a different measurement.
 */

import { query } from "../graph/client";
import type { Deployment } from "../graph/deployments";
import { buildPriceIndex, normalizePosition } from "../exposure/normalize";
import type { Position, RawMarket, RawPosition } from "../exposure/types";
import {
  collectAliasedPositions,
  completeBooksQuery,
  enclaveBootstrapQuery,
  topPositionsQuery,
} from "../signal/enclave-queries";
import { aggregateSignal, type SentinelSignal } from "../signal/aggregate";
import type { RiskPolicy } from "../signal/policy";

/** The enclave's sampling budget, read from `cre/sentinel-signal/config.staging.json`. */
export type SamplingConfig = {
  marketsPerDeployment: number;
  marketsSampled: number;
  positionsPerMarket: number;
  candidatesPerDeployment: number;
  candidateAccounts: number;
  completeBooksPageSize: number;
};

/**
 * Same gate as `scripts/leak-demo.mts` and the workflow: a subgraph whose sampled
 * debt exceeds its own reported total is mis-indexing, and the candidate slots it
 * would win are slots spent on fiction. Aave V2 fails this by ~1925x.
 */
const SAMPLED_DEBT_TOLERANCE = 1.25;

type BootstrapData = {
  _meta: { block: { number: number; timestamp: number } };
  lendingProtocols: {
    name: string;
    schemaVersion: string;
    totalBorrowBalanceUSD: string;
    totalValueLockedUSD: string;
  }[];
  markets: RawMarket[];
};

export type ScoredBlock = {
  block: number;
  /** Chain timestamp from `_meta`, so the x-axis is real time rather than assumed. */
  timestamp: number;
  signal: SentinelSignal;
  /**
   * The naive comparison Sentinel has to beat: protocol utilization, borrow over
   * TVL, summed across deployments. Chosen because it is the strongest thing
   * available from public totals alone — one call, no positions, no enclave — so
   * beating it is evidence that the per-address aggregation buys something. A
   * baseline of "total TVL" alone would have been a straw man: TVL drifts on
   * deposits and would lose to anything.
   */
  baselineUtilization: number;
  /** Deployments that answered all three passes. */
  sampled: string[];
  /** Deployments asked for and not obtained, with the reason. */
  missing: { key: string; reason: string }[];
  /** HTTP calls spent. Reported because the enclave's budget is 15. */
  calls: number;
};

/**
 * Recompute the signal at `atBlock`, or explain why it cannot be.
 *
 * Returns `null` when no deployment served the block, which is the retention wall
 * rather than an error: it is expected, it is a finding, and the caller publishes
 * the count.
 */
export async function signalAtBlock(
  deployments: Deployment[],
  cfg: SamplingConfig,
  policy: RiskPolicy,
  atBlock: number,
): Promise<ScoredBlock | null> {
  if (!Number.isInteger(atBlock) || atBlock <= 0) {
    throw new Error(`signalAtBlock: bad block ${atBlock}`);
  }

  let calls = 0;
  const missing: { key: string; reason: string }[] = [];

  // ─── Pass 1: bootstrap ───────────────────────────────────────────────────
  const bootstrap = new Map<string, BootstrapData>();
  for (const d of deployments) {
    try {
      const res = await query<BootstrapData>(d, enclaveBootstrapQuery(atBlock), {
        markets: cfg.marketsPerDeployment,
      });
      calls++;
      bootstrap.set(d.key, res.data);
    } catch (err) {
      calls++;
      missing.push({ key: d.key, reason: reasonFor(err) });
    }
  }
  if (bootstrap.size === 0) return null;

  // One price index across every deployment that answered, exactly as the live path
  // builds it: the deepest market quoting an asset sets its price, so the same asset
  // is not valued two ways depending on which protocol it was seen in.
  const allMarkets: RawMarket[] = [];
  for (const b of bootstrap.values()) allMarkets.push(...b.markets);
  const prices = buildPriceIndex(allMarkets);

  // ─── Pass 2: discovery ───────────────────────────────────────────────────
  const sampledBy = new Map<string, Position[]>();
  for (const d of deployments) {
    const b = bootstrap.get(d.key);
    if (!b) continue;

    const markets = b.markets
      .filter((m) => Number(m.totalDepositBalanceUSD) > 0 || Number(m.totalBorrowBalanceUSD) > 0)
      .slice(0, cfg.marketsSampled);
    if (markets.length === 0) {
      missing.push({ key: d.key, reason: "no active markets at this block" });
      continue;
    }

    let positions: Position[];
    try {
      const res = await query<Record<string, unknown>>(
        d,
        topPositionsQuery(
          d.schemaVersion,
          markets.map((m) => m.id),
          cfg.positionsPerMarket,
          atBlock,
        ),
      );
      calls++;
      positions = [];
      for (const raw of collectAliasedPositions<RawPosition>(res.data)) {
        const p = normalizePosition(raw, d.key, prices);
        if (p) positions.push(p);
      }
    } catch (err) {
      calls++;
      missing.push({ key: d.key, reason: reasonFor(err) });
      continue;
    }

    const reported = Number(b.lendingProtocols[0]?.totalBorrowBalanceUSD ?? 0);
    const sampledDebt = positions.reduce((s, p) => (p.side === "BORROWER" ? s + p.valueUsd : s), 0);
    if (reported > 0 && sampledDebt / reported > SAMPLED_DEBT_TOLERANCE) {
      missing.push({
        key: d.key,
        reason: `sampled debt ${(sampledDebt / reported).toFixed(1)}x reported`,
      });
      continue;
    }
    sampledBy.set(d.key, positions);
  }
  if (sampledBy.size === 0) return null;

  // Nominate per deployment first, then pool — so a large protocol cannot take every
  // slot and erase the cross-protocol signal, which is the thing being measured.
  const nominated = new Set<string>();
  for (const positions of sampledBy.values()) {
    const debt = new Map<string, number>();
    for (const p of positions) {
      if (p.side !== "BORROWER" || p.valueUsd <= 0) continue;
      debt.set(p.account, (debt.get(p.account) ?? 0) + p.valueUsd);
    }
    for (const [account] of [...debt]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, cfg.candidatesPerDeployment)) {
      nominated.add(account);
    }
  }

  const pooled = new Map<string, number>();
  for (const positions of sampledBy.values()) {
    for (const p of positions) {
      if (p.side !== "BORROWER" || !nominated.has(p.account)) continue;
      pooled.set(p.account, (pooled.get(p.account) ?? 0) + p.valueUsd);
    }
  }
  const candidates = [...pooled]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cfg.candidateAccounts)
    .map(([account]) => account);
  if (candidates.length === 0) return null;

  // ─── Pass 3: complete books ──────────────────────────────────────────────
  const complete: Position[] = [];
  const blocks: Record<string, number> = {};
  const reportedDebtUsd: Record<string, number> = {};
  const sampled: string[] = [];

  for (const d of deployments) {
    if (!sampledBy.has(d.key)) continue;
    try {
      const res = await query<{ positions: RawPosition[] }>(
        d,
        completeBooksQuery(d.schemaVersion, atBlock),
        { accounts: candidates, first: cfg.completeBooksPageSize },
      );
      calls++;
      // A full page means books were truncated, and a health factor from a truncated
      // book is meaningless rather than pessimistic. Drop the deployment loudly.
      if (res.data.positions.length >= cfg.completeBooksPageSize) {
        missing.push({ key: d.key, reason: "complete-books page filled; book truncated" });
        continue;
      }
      for (const raw of res.data.positions) {
        const p = normalizePosition(raw, d.key, prices);
        if (p) complete.push(p);
      }
      blocks[d.key] = atBlock;
      reportedDebtUsd[d.key] = Number(
        bootstrap.get(d.key)?.lendingProtocols[0]?.totalBorrowBalanceUSD ?? 0,
      );
      sampled.push(d.key);
    } catch (err) {
      calls++;
      missing.push({ key: d.key, reason: reasonFor(err) });
    }
  }
  if (sampled.length === 0) return null;

  const signal = aggregateSignal({ positions: complete, blocks, reportedDebtUsd, policy });

  let borrow = 0;
  let tvl = 0;
  for (const key of sampled) {
    const p = bootstrap.get(key)?.lendingProtocols[0];
    borrow += Number(p?.totalBorrowBalanceUSD ?? 0);
    tvl += Number(p?.totalValueLockedUSD ?? 0);
  }

  // Any deployment that answered gives the same chain timestamp; take the first.
  const timestamp = Number(bootstrap.get(sampled[0])?._meta.block.timestamp ?? 0);

  return {
    block: atBlock,
    timestamp,
    signal,
    baselineUtilization: tvl > 0 ? borrow / tvl : 0,
    sampled,
    missing,
    calls,
  };
}

/** The gateway's own words, unwrapped one level, with no URL — the URL holds the key. */
function reasonFor(err: unknown): string {
  const e = err as Error & { cause?: unknown };
  const detail = (e.cause as Error | undefined)?.message ?? e.message ?? String(err);
  return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
}
