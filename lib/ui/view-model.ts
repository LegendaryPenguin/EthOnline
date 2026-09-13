/**
 * Everything the interface renders, assembled on the server.
 *
 * Three sources, and the difference between them is the point:
 *
 *   1. the **signed report** — the confidential aggregate, verified here the same way
 *      `contracts/src/SentinelConsumer.sol` verifies it on chain. These are the only
 *      figures Sentinel publishes, and the interface shows them *because* they were
 *      verified, not alongside a claim that they were.
 *   2. the **cascade run** — a simulation over a live snapshot, already aggregate:
 *      protocol-pair coupling, shared collateral, the shock ladder.
 *   3. the **snapshot's provenance** — the block each deployment served and when it was
 *      read, carried through untouched so the UI can say how old its data is instead of
 *      implying it is current.
 *
 * The invariant this module exists to hold: **no account address reaches the client.**
 * Publishing per-address leverage is the harm Sentinel is built to avoid, so the view
 * model is the last place it could leak, and `__tests__/view-model.test.ts` asserts that
 * no address from the underlying sample appears anywhere in the serialised output.
 */

import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { hexToBytes } from "viem";
import { ReportRejected, verifySignalReport, type SignedReport } from "../signal/consume";
import type { DecodedSignal } from "../signal/report";
import type { ShockLadder } from "./ladder";

/** Snapshot ages, in hours, at which the interface changes what it claims. */
export const FRESH_HOURS = 1;
export const AGING_HOURS = 24;

export type Freshness = "fresh" | "aging" | "stale";

export type Provenance = {
  /** Deployment key -> block served, from the snapshot the positions came from. */
  blocks: Record<string, number>;
  /** Oldest block any deployment served: the signal is only as current as its laggard. */
  asOfBlock: number;
  capturedAt: string;
  ageHours: number;
  freshness: Freshness;
  /** Share of protocol-reported debt the sample covers. */
  sampleCoverage: number;
  /** Share of cross-protocol collateral value the modelled assets cover. */
  assetCoverage: number;
};

export type VerifiedReportView = {
  workflowName: string;
  workflowOwner: Address;
  /** Signers whose signatures were accepted, and the quorum rule they satisfied. */
  acceptedSigners: Address[];
  requiredSigners: number;
  signerSetSize: number;
  version: string;
  asOfBlock: number;
  /** Report bytes, so a viewer can re-verify independently. */
  reportBytes: number;
  figures: {
    borrowersObserved: number;
    debtUsd: number;
    evaluableDebtUsd: number;
    multiProtocolDebtUsd: number;
    multiProtocolShareBps: number;
    leveredShareBps: number;
    worstShockBps: number;
    worstShockDistressedDebtUsd: number;
    systemicRiskScoreBps: number;
    couplingBuckets: number;
    suppressedBuckets: number;
    emodeInferredBorrowers: number;
    emodeInferredDebtUsd: number;
  };
};

export type CouplingView = {
  protocols: string[];
  /** Symmetric, debt-weighted Jaccard overlap of borrower sets. */
  borrowerOverlap: Record<string, Record<string, number>>;
  /** Asymmetric: share of the row's collateral value also lent against by the column. */
  collateralExposure: Record<string, Record<string, number>>;
  /** Collateral assets carrying value at more than one protocol, largest first. */
  sharedAssets: { symbol: string; assetUsd: number; protocols: string[] }[];
  /** Shared borrowers per protocol pair, from the completed sample. */
  pairBorrowers: { pair: [string, string]; borrowers: number }[];
};

export type GraphNode = {
  id: string;
  label: string;
  kind: "protocol" | "asset";
  /** Value the node carries, in USD: debt for a protocol, collateral for an asset. */
  valueUsd: number;
  /** Layout position in a unit square, computed server-side so the client never re-lays-out. */
  x: number;
  y: number;
};

export type GraphEdge = {
  source: string;
  target: string;
  /** `collateral`: the asset is posted at the protocol. `overlap`: shared borrowers. */
  kind: "collateral" | "overlap";
  /** 0–1, for stroke weight. */
  weight: number;
  valueUsd: number;
};

export type ContagionGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

export type DashboardData = {
  provenance: Provenance;
  report: VerifiedReportView;
  coupling: CouplingView;
  graph: ContagionGraph;
  ladder: ShockLadder;
  /** Protocol-level totals, for the graph and the timeline legend. */
  protocolDebtUsd: Record<string, number>;
};

export type DashboardState =
  | { status: "ready"; data: DashboardData }
  | { status: "empty"; missing: string[]; commands: string[] }
  | { status: "error"; message: string };

/** The pinned consumer policy. The fixture records the signer set the report was signed under. */
type ReportFixture = {
  rawReport: `0x${string}`;
  reportContext: `0x${string}`;
  signatures: `0x${string}`[];
  signers: Address[];
  f: string;
  workflowOwner: Address;
  workflowName: string;
};

const PATHS = {
  report: "contracts/test/fixtures/report.json",
  ladder: "data/shock-ladder.json",
  cascade: "data/cascade.json",
  completed: "data/completed.json",
};

const COMMANDS = [
  "npm run snapshot",
  "npm run cascade",
  "npm run shock:ladder",
  "npm run fixture:report",
];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function freshnessOf(ageHours: number): Freshness {
  if (ageHours < FRESH_HOURS) return "fresh";
  if (ageHours < AGING_HOURS) return "aging";
  return "stale";
}

/**
 * Lay the graph out on a deterministic ring: protocols on an inner circle, shared
 * collateral assets on an outer one.
 *
 * A force simulation would look livelier and cost the honesty of the picture — the layout
 * would change between loads, so nothing on screen could be compared to a screenshot, and
 * the animation would compete with the cascade animation that carries the actual meaning.
 */
function layout(
  protocols: { id: string; valueUsd: number }[],
  assets: { id: string; valueUsd: number }[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const place = (ids: string[], radius: number, phase: number) => {
    ids.forEach((id, i) => {
      const angle = phase + (2 * Math.PI * i) / Math.max(1, ids.length);
      positions.set(id, { x: 0.5 + radius * Math.cos(angle), y: 0.5 + radius * Math.sin(angle) });
    });
  };
  // Largest first, and the ring starts at the top, so the biggest protocol is always in
  // the same place across runs.
  place(protocols.map((p) => p.id), 0.17, -Math.PI / 2);
  place(assets.map((a) => a.id), 0.4, -Math.PI / 2);
  return positions;
}

function buildGraph(
  coupling: CouplingView,
  protocolDebtUsd: Record<string, number>,
): ContagionGraph {
  const protocols = coupling.protocols
    .map((id) => ({ id, valueUsd: protocolDebtUsd[id] ?? 0 }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
  // Only assets held at more than one protocol: an asset at a single protocol cannot
  // transmit anything, and drawing it would pad the picture with edges that carry no risk.
  const assets = coupling.sharedAssets
    .filter((a) => a.protocols.length > 1)
    .slice(0, 10)
    .map((a) => ({ id: `asset:${a.symbol}`, valueUsd: a.assetUsd, symbol: a.symbol, protocols: a.protocols }));

  const positions = layout(protocols, assets);
  const maxAssetUsd = Math.max(1, ...assets.map((a) => a.valueUsd));
  const maxPairBorrowers = Math.max(1, ...coupling.pairBorrowers.map((p) => p.borrowers));

  const nodes: GraphNode[] = [
    ...protocols.map((p) => ({
      id: p.id,
      label: p.id,
      kind: "protocol" as const,
      valueUsd: p.valueUsd,
      ...positions.get(p.id)!,
    })),
    ...assets.map((a) => ({
      id: a.id,
      label: a.symbol,
      kind: "asset" as const,
      valueUsd: a.valueUsd,
      ...positions.get(a.id)!,
    })),
  ];

  const edges: GraphEdge[] = [];
  for (const asset of assets) {
    for (const protocol of asset.protocols) {
      if (!protocolDebtUsd[protocol]) continue;
      edges.push({
        source: asset.id,
        target: protocol,
        kind: "collateral",
        weight: asset.valueUsd / maxAssetUsd,
        valueUsd: asset.valueUsd,
      });
    }
  }
  for (const { pair, borrowers } of coupling.pairBorrowers) {
    edges.push({
      source: pair[0],
      target: pair[1],
      kind: "overlap",
      weight: borrowers / maxPairBorrowers,
      // Borrower counts, not value: the count is what the coupling measure is built from.
      valueUsd: 0,
    });
  }
  return { nodes, edges };
}

/**
 * Assemble the dashboard, or say precisely what is missing.
 *
 * Never throws. A missing data file is the fresh-clone case and gets the empty state with
 * the commands that produce it; a report that fails verification is an error state that
 * names the reason, because silently rendering an unverified signal would defeat the
 * entire point of signing it.
 */
export async function loadDashboard(now = Date.now()): Promise<DashboardState> {
  const missing: string[] = [];
  for (const path of Object.values(PATHS)) {
    try {
      readFileSync(path);
    } catch {
      missing.push(path);
    }
  }
  if (missing.length > 0) return { status: "empty", missing, commands: COMMANDS };

  try {
    const fixture = readJson<ReportFixture>(PATHS.report);
    const ladder = readJson<ShockLadder>(PATHS.ladder);
    const cascade = readJson<{
      provenance: { capturedAt: string; lendingBlocks: Record<string, number> };
      coupling: {
        protocols: string[];
        borrowerOverlap: Record<string, Record<string, number>>;
        collateralExposure: Record<string, Record<string, number>>;
        sharedAssets: { symbol: string; totalUsd: number; protocols: string[] }[];
      };
    }>(PATHS.cascade);
    const completed = readJson<{
      positions: { protocol: string; side: string; valueUsd: number }[];
      coverage: { sampleCoverageOfReported: number; pairOverlap: Record<string, number> };
    }>(PATHS.completed);

    const signed: SignedReport = {
      rawReport: hexToBytes(fixture.rawReport),
      reportContext: hexToBytes(fixture.reportContext),
      signatures: fixture.signatures.map((s) => hexToBytes(s)),
    };

    // Verified with the identity and quorum rules the on-chain consumer uses, and with
    // freshness deliberately not enforced here: a recording that has aged out is still
    // authentic, and the interface's job is to show its age rather than to hide the
    // report. The age is computed below and drives what the page is allowed to claim.
    const verified = await verifySignalReport(
      signed,
      {
        signers: fixture.signers,
        f: Number(fixture.f),
        workflowOwner: fixture.workflowOwner,
        workflowName: fixture.workflowName,
        maxBlockAge: 2n ** 63n,
      },
      BigInt(Number.MAX_SAFE_INTEGER),
    );

    const signal: DecodedSignal = verified.signal;
    const usd = (v: bigint) => Number(v) / 1e6;

    const blocks = ladder.blocks;
    const asOfBlock = Math.min(...Object.values(blocks));
    const capturedAt = cascade.provenance.capturedAt;
    const ageHours = (now - new Date(capturedAt).getTime()) / 3_600_000;

    const protocolDebtUsd: Record<string, number> = {};
    for (const p of completed.positions) {
      if (p.side !== "BORROWER") continue;
      protocolDebtUsd[p.protocol] = (protocolDebtUsd[p.protocol] ?? 0) + p.valueUsd;
    }

    const coupling: CouplingView = {
      protocols: cascade.coupling.protocols,
      borrowerOverlap: cascade.coupling.borrowerOverlap,
      collateralExposure: cascade.coupling.collateralExposure,
      sharedAssets: cascade.coupling.sharedAssets.map((a) => ({
        symbol: a.symbol,
        assetUsd: a.totalUsd,
        protocols: a.protocols,
      })),
      pairBorrowers: Object.entries(completed.coverage.pairOverlap)
        .map(([pair, borrowers]) => {
          const [a, b] = pair.split("|");
          return { pair: [a, b] as [string, string], borrowers };
        })
        .sort((x, y) => y.borrowers - x.borrowers),
    };

    return {
      status: "ready",
      data: {
        provenance: {
          blocks,
          asOfBlock,
          capturedAt,
          ageHours,
          freshness: freshnessOf(ageHours),
          sampleCoverage: completed.coverage.sampleCoverageOfReported,
          assetCoverage: ladder.assetCoverage,
        },
        report: {
          workflowName: verified.header.workflowName,
          workflowOwner: verified.header.workflowOwner,
          acceptedSigners: verified.signers,
          requiredSigners: Number(fixture.f) + 1,
          signerSetSize: fixture.signers.length,
          version: signal.version,
          asOfBlock: Number(signal.asOfBlock),
          reportBytes: signed.rawReport.length,
          figures: {
            borrowersObserved: signal.borrowersObserved,
            debtUsd: usd(signal.debtUsd6),
            evaluableDebtUsd: usd(signal.evaluableDebtUsd6),
            multiProtocolDebtUsd: usd(signal.multiProtocolDebtUsd6),
            multiProtocolShareBps: signal.multiProtocolShareBps,
            leveredShareBps: signal.leveredShareBps,
            worstShockBps: signal.worstShockBps,
            worstShockDistressedDebtUsd: usd(signal.worstShockDistressedDebtUsd6),
            systemicRiskScoreBps: signal.systemicRiskScoreBps,
            couplingBuckets: signal.couplingBuckets,
            suppressedBuckets: signal.suppressedBuckets,
            emodeInferredBorrowers: signal.emodeInferredBorrowers,
            emodeInferredDebtUsd: usd(signal.emodeInferredDebtUsd6),
          },
        },
        coupling,
        graph: buildGraph(coupling, protocolDebtUsd),
        ladder,
        protocolDebtUsd,
      },
    };
  } catch (error) {
    const message =
      error instanceof ReportRejected
        ? `the recorded signal did not verify — ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return { status: "error", message };
  }
}
