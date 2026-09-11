/**
 * Snapshot capture.
 *
 * Pulls protocol totals, markets and open positions from every registered
 * deployment, normalizes them, and records provenance: which block each
 * deployment served, which deployments were excluded and why. A snapshot that
 * cannot say where its numbers came from is not evidence, so provenance is
 * mandatory rather than optional.
 */

import { MAX_BLOCK_LAG, query, queryAll, requireApiKey, type QueryResult } from "./client";
import { DEPLOYMENTS, type Deployment } from "./deployments";
import {
  BALANCE_CURSOR_START,
  MARKETS_QUERY,
  positionsQuery,
  PROTOCOL_QUERY,
} from "./queries";
import { buildPriceIndex, normalizePosition } from "../exposure/normalize";
import type { Position, RawMarket, RawPosition, Snapshot } from "../exposure/types";

type ProtocolData = {
  lendingProtocols: {
    id: string;
    name: string;
    schemaVersion: string;
    subgraphVersion: string;
    totalValueLockedUSD: string;
    totalBorrowBalanceUSD: string;
    totalDepositBalanceUSD: string;
    cumulativeUniqueUsers: number;
    openPositionCount: number;
  }[];
};

type MarketsData = { markets: RawMarket[] };
type PositionsData = { positions: RawPosition[] };

/**
 * Ceiling on sampled-debt / reported-debt before a deployment's position rows are
 * rejected. A subset cannot exceed the whole, so anything above 1.0 is already
 * contradictory; the headroom absorbs block skew and our own price index
 * differing slightly from the protocol's oracle.
 */
export const MAX_DEBT_RECONCILIATION_RATIO = 1.25;

const fmtUsd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export type SnapshotOptions = {
  /** Largest-first positions pulled per market. The stratification budget. */
  positionsPerMarket?: number;
  /** Page size. The gateway caps `first` at 1000. */
  pageSize?: number;
  /** In-flight requests per deployment. */
  concurrency?: number;
  onProgress?: (msg: string) => void;
  deployments?: Deployment[];
};

export async function captureSnapshot({
  positionsPerMarket = 1000,
  pageSize = 1000,
  concurrency = 8,
  onProgress = () => {},
  deployments = DEPLOYMENTS,
}: SnapshotOptions = {}): Promise<Snapshot> {
  // Fail before the first request rather than letting a missing key surface five
  // times as a per-deployment "exclusion" — that would read like the network was
  // down when the real cause is configuration.
  requireApiKey();

  const excluded: { deployment: string; reason: string }[] = [];
  const blocks: Record<string, number> = {};

  // Pass 1: protocol totals. Also establishes each deployment's sync block.
  const protocols = await queryAll<ProtocolData>(deployments, PROTOCOL_QUERY);
  for (const f of protocols.failed) {
    excluded.push({ deployment: f.deployment.key, reason: f.error.message });
    onProgress(`excluded ${f.deployment.key}: ${f.error.message}`);
  }

  // Head is the furthest-ahead deployment we can observe. Anything lagging it by
  // more than MAX_BLOCK_LAG is describing a different world and is dropped.
  const head = Math.max(0, ...protocols.ok.map((r) => r.block));
  const live: QueryResult<ProtocolData>[] = [];
  for (const r of protocols.ok) {
    const lag = head - r.block;
    if (lag > MAX_BLOCK_LAG) {
      const reason = `stale: ${lag} blocks behind head ${head}`;
      excluded.push({ deployment: r.deployment.key, reason });
      onProgress(`excluded ${r.deployment.key}: ${reason}`);
      continue;
    }
    blocks[r.deployment.key] = r.block;
    live.push(r);
    onProgress(
      `${r.deployment.key}: block ${r.block} (lag ${lag}), schema ` +
        `${r.data.lendingProtocols[0]?.schemaVersion ?? "?"}, ${r.elapsedMs}ms`,
    );
  }

  if (live.length === 0) {
    throw new Error("No deployment responded. Snapshot aborted — there is no mock mode.");
  }

  const protocolTotals: Snapshot["protocolTotals"] = {};
  for (const r of live) {
    const p = r.data.lendingProtocols[0];
    if (!p) continue;
    protocolTotals[r.deployment.key] = {
      name: p.name,
      borrowUsd: Number(p.totalBorrowBalanceUSD),
      tvlUsd: Number(p.totalValueLockedUSD),
    };
  }

  // Pass 2: markets. These carry risk parameters and the only price signal.
  const liveDeployments = live.map((r) => r.deployment);
  const marketsByProtocol: Record<string, RawMarket[]> = {};
  const marketResults = await queryAll<MarketsData>(liveDeployments, MARKETS_QUERY);
  for (const f of marketResults.failed) {
    excluded.push({ deployment: f.deployment.key, reason: `markets: ${f.error.message}` });
  }
  for (const r of marketResults.ok) {
    marketsByProtocol[r.deployment.key] = r.data.markets;
    onProgress(`${r.deployment.key}: ${r.data.markets.length} markets`);
  }

  // A global price index across every protocol's markets. Assets missing from
  // one protocol's market list are still priceable from another's.
  const allMarkets = Object.values(marketsByProtocol).flat();
  const prices = buildPriceIndex(allMarkets);
  onProgress(`price index: ${prices.size} assets`);

  // Pass 3: positions, cursor-paged per deployment, in parallel.
  const positionSets = await Promise.all(
    liveDeployments
      .filter((d) => marketsByProtocol[d.key])
      .map((d) =>
        fetchPositions(
          d,
          marketsByProtocol[d.key],
          prices,
          positionsPerMarket,
          pageSize,
          concurrency,
          onProgress,
        ).catch((err: Error) => {
          excluded.push({ deployment: d.key, reason: `positions: ${err.message}` });
          onProgress(`excluded ${d.key}: positions: ${err.message}`);
          return [] as Position[];
        }),
      ),
  );

  // Pass 4: reconcile position rows against the protocol's own totals.
  //
  // Sampling can only ever return a subset, so a protocol's sampled debt must not
  // exceed the debt it reports. When it does, the position-level mappings and the
  // protocol-level mappings disagree, and the position rows cannot be trusted for
  // risk. This gate is only affordable because the standardized schema exposes
  // both levels in one query shape — the cross-check comes free with the standard.
  const kept: Position[] = [];
  for (const set of positionSets) {
    if (set.length === 0) continue;
    const key = set[0].protocol;
    const reported = protocolTotals[key]?.borrowUsd ?? 0;
    const sampled = set.reduce((s, p) => (p.side === "BORROWER" ? s + p.valueUsd : s), 0);
    const ratio = reported > 0 ? sampled / reported : 0;

    if (ratio > MAX_DEBT_RECONCILIATION_RATIO) {
      const reason =
        `debt reconciliation failed: sampled ${fmtUsd(sampled)} is ${ratio.toFixed(1)}x ` +
        `the protocol-reported ${fmtUsd(reported)}; position mappings disagree with ` +
        `protocol totals, so these rows are unusable for risk`;
      excluded.push({ deployment: key, reason });
      delete blocks[key];
      delete protocolTotals[key];
      delete marketsByProtocol[key];
      onProgress(`excluded ${key}: ${reason}`);
      continue;
    }

    onProgress(`${key}: debt reconciles at ${(ratio * 100).toFixed(1)}% of reported`);
    kept.push(...set);
  }

  if (kept.length === 0) {
    throw new Error("Every deployment failed reconciliation. Snapshot aborted.");
  }

  const positions = kept;
  const includedBlocks = Object.values(blocks);

  return {
    provenance: {
      blocks,
      capturedAt: new Date().toISOString(),
      excluded,
      blockAligned: new Set(includedBlocks).size === 1,
    },
    positions,
    markets: marketsByProtocol,
    protocolTotals,
  };
}

/**
 * Pull the largest positions from every market in one deployment.
 *
 * The per-market budget is what makes the sample stratified: a market holding
 * 0.1% of the protocol's book still contributes its own biggest borrowers, so
 * cross-protocol overlap concentrated in a small market is not invisible.
 */
async function fetchPositions(
  deployment: Deployment,
  markets: RawMarket[],
  prices: Map<string, number>,
  perMarket: number,
  pageSize: number,
  concurrency: number,
  onProgress: (msg: string) => void,
): Promise<Position[]> {
  const document = positionsQuery(deployment.schemaVersion);

  // Markets with no book have no positions worth a round trip.
  const active = markets.filter(
    (m) => Number(m.totalDepositBalanceUSD) > 0 || Number(m.totalBorrowBalanceUSD) > 0,
  );

  const out: Position[] = [];
  let dropped = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < active.length) {
      const market = active[cursor++];
      let lastBalance = BALANCE_CURSOR_START;
      let taken = 0;

      while (taken < perMarket) {
        const first = Math.min(pageSize, perMarket - taken);
        const res = await query<PositionsData>(deployment, document, {
          first,
          lastBalance,
          market: market.id,
        });
        const page = res.data.positions;
        if (page.length === 0) break;

        for (const raw of page) {
          const p = normalizePosition(raw, deployment.key, prices);
          if (p) out.push(p);
          else dropped++;
        }

        taken += page.length;
        lastBalance = page[page.length - 1].balance;
        if (page.length < first) break;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  onProgress(
    `${deployment.key}: ${out.length} positions from ${active.length} markets, ` +
      `${dropped} dropped (unpriceable or zero)`,
  );
  return out;
}
