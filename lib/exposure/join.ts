/**
 * The cross-protocol join.
 *
 * This is the one operation no lending protocol can perform on its own: group
 * positions by borrower *across* protocols. It works only because every
 * deployment on the Messari standardized schema keys `Account` by the raw
 * address, so this is a primary-key join — no fuzzy matching, no heuristics,
 * no address clustering.
 *
 * Remove the shared schema and this file becomes five bespoke adapters plus an
 * identity-reconciliation problem. That is the standards leverage.
 */

import type {
  AccountExposure,
  HealthConfidence,
  Position,
  ProtocolExposure,
} from "./types";

export function joinByAccount(positions: Position[]): Map<string, AccountExposure> {
  const byAccount = new Map<string, Position[]>();

  for (const p of positions) {
    const bucket = byAccount.get(p.account);
    if (bucket) bucket.push(p);
    else byAccount.set(p.account, [p]);
  }

  const out = new Map<string, AccountExposure>();
  for (const [account, ps] of byAccount) {
    out.set(account, buildExposure(account, ps));
  }
  return out;
}

const emptyProtocol = (): ProtocolExposure => ({
  collateralUsd: 0,
  debtUsd: 0,
  weightedCollateralUsd: 0,
  unknownThresholdUsd: 0,
  healthFactor: Infinity,
  confidence: "ok",
});

export function buildExposure(account: string, positions: Position[]): AccountExposure {
  const byProtocol: Record<string, ProtocolExposure> = {};
  const collateralByAsset: Record<string, number> = {};

  for (const p of positions) {
    const bucket = (byProtocol[p.protocol] ??= emptyProtocol());
    if (p.side === "BORROWER") {
      bucket.debtUsd += p.valueUsd;
      continue;
    }
    bucket.collateralUsd += p.valueUsd;
    collateralByAsset[p.assetId] = (collateralByAsset[p.assetId] ?? 0) + p.valueUsd;
    if (p.liquidationThreshold > 0) {
      bucket.weightedCollateralUsd += p.valueUsd * p.liquidationThreshold;
    } else {
      // Unknown threshold contributes nothing to the liquidation boundary. That
      // makes the health factor pessimistic rather than invented.
      bucket.unknownThresholdUsd += p.valueUsd;
    }
  }

  let collateralUsd = 0;
  let debtUsd = 0;
  let weightedCollateralUsd = 0;
  let unknownThresholdUsd = 0;
  let confidence: HealthConfidence = "ok";

  for (const b of Object.values(byProtocol)) {
    b.healthFactor = b.debtUsd > 0 ? b.weightedCollateralUsd / b.debtUsd : Infinity;
    b.confidence = classify(b);

    collateralUsd += b.collateralUsd;
    debtUsd += b.debtUsd;
    weightedCollateralUsd += b.weightedCollateralUsd;
    unknownThresholdUsd += b.unknownThresholdUsd;
    confidence = weaker(confidence, b.confidence);
  }

  return {
    account,
    protocols: Object.keys(byProtocol).sort(),
    collateralUsd,
    debtUsd,
    weightedCollateralUsd,
    unknownThresholdUsd,
    aggregateLeverageRatio: debtUsd > 0 ? weightedCollateralUsd / debtUsd : Infinity,
    confidence,
    byProtocol,
    positions,
    collateralByAsset,
  };
}

function classify(b: ProtocolExposure): HealthConfidence {
  // Order matters: a contradicted HF is the stronger signal, because it means the
  // number is not merely incomplete but demonstrably wrong.
  if (b.debtUsd > 0 && b.healthFactor < 1) return "contradicted";
  if (b.unknownThresholdUsd > 0) return "incomplete";
  return "ok";
}

const RANK: Record<HealthConfidence, number> = { ok: 0, incomplete: 1, contradicted: 2 };
const weaker = (a: HealthConfidence, b: HealthConfidence) => (RANK[b] > RANK[a] ? b : a);

export type CoverageReport = {
  /** Accounts seen at all. */
  accountsTotal: number;
  /** Accounts with positions on 2+ protocols. */
  accountsMultiProtocol: number;
  /** Accounts carrying debt on 2+ protocols. */
  borrowersMultiProtocol: number;
  /** Debt USD held by multi-protocol accounts (sampled). */
  multiProtocolDebtUsd: number;
  /** Debt USD across all sampled accounts. */
  sampledDebtUsd: number;
  /** Protocol-reported total borrow balance — the true denominator. */
  reportedDebtUsd: number;
  /**
   * multiProtocolDebtUsd / sampledDebtUsd. A lower bound on the true figure:
   * the sample truncates, and truncation can only remove overlap, never invent
   * it.
   */
  multiProtocolDebtShareOfSample: number;
  /** What fraction of protocol-reported debt the sample actually covers. */
  sampleCoverageOfReported: number;
  /** Protocol-pair overlap counts, keyed "a|b" with a < b. */
  pairOverlap: Record<string, number>;
  /** Distribution of protocol counts per account. */
  protocolCountHistogram: Record<number, number>;
  /** Per-protocol sampled vs reported debt. Aggregates hide a single bad feed. */
  perProtocol: Record<string, { sampledDebtUsd: number; reportedDebtUsd: number; ratio: number }>;
  /**
   * Borrowers by health-factor confidence, and the debt behind each bucket.
   * `contradicted` is the honest measure of how much of the book the
   * standardized schema cannot price risk on — mostly Aave V3 E-Mode.
   */
  confidence: Record<HealthConfidence, { borrowers: number; debtUsd: number }>;
};

export function coverageReport(
  exposures: Map<string, AccountExposure>,
  reportedDebtUsd: number,
  protocolTotals: Record<string, { borrowUsd: number }> = {},
): CoverageReport {
  let accountsMultiProtocol = 0;
  let borrowersMultiProtocol = 0;
  let multiProtocolDebtUsd = 0;
  let sampledDebtUsd = 0;
  const pairOverlap: Record<string, number> = {};
  const protocolCountHistogram: Record<number, number> = {};
  const sampledByProtocol: Record<string, number> = {};
  const confidence: CoverageReport["confidence"] = {
    ok: { borrowers: 0, debtUsd: 0 },
    incomplete: { borrowers: 0, debtUsd: 0 },
    contradicted: { borrowers: 0, debtUsd: 0 },
  };

  for (const e of exposures.values()) {
    if (e.debtUsd > 0) {
      const bucket = confidence[e.confidence];
      bucket.borrowers++;
      bucket.debtUsd += e.debtUsd;
    }
    for (const p of e.positions) {
      if (p.side === "BORROWER") {
        sampledByProtocol[p.protocol] = (sampledByProtocol[p.protocol] ?? 0) + p.valueUsd;
      }
    }
    const n = e.protocols.length;
    protocolCountHistogram[n] = (protocolCountHistogram[n] ?? 0) + 1;
    sampledDebtUsd += e.debtUsd;

    if (n < 2) continue;
    accountsMultiProtocol++;

    // Count debt-bearing overlap separately: an address merely *supplying* to
    // two protocols is not a contagion channel, a leveraged one is.
    const debtProtocols = new Set(
      e.positions.filter((p) => p.side === "BORROWER").map((p) => p.protocol),
    );
    if (debtProtocols.size >= 2) {
      borrowersMultiProtocol++;
      multiProtocolDebtUsd += e.debtUsd;
    }

    for (let i = 0; i < e.protocols.length; i++) {
      for (let j = i + 1; j < e.protocols.length; j++) {
        const key = `${e.protocols[i]}|${e.protocols[j]}`;
        pairOverlap[key] = (pairOverlap[key] ?? 0) + 1;
      }
    }
  }

  const perProtocol: CoverageReport["perProtocol"] = {};
  for (const [key, totals] of Object.entries(protocolTotals)) {
    const sampled = sampledByProtocol[key] ?? 0;
    perProtocol[key] = {
      sampledDebtUsd: sampled,
      reportedDebtUsd: totals.borrowUsd,
      ratio: totals.borrowUsd > 0 ? sampled / totals.borrowUsd : 0,
    };
  }

  return {
    accountsTotal: exposures.size,
    accountsMultiProtocol,
    borrowersMultiProtocol,
    multiProtocolDebtUsd,
    sampledDebtUsd,
    reportedDebtUsd,
    multiProtocolDebtShareOfSample:
      sampledDebtUsd > 0 ? multiProtocolDebtUsd / sampledDebtUsd : 0,
    sampleCoverageOfReported: reportedDebtUsd > 0 ? sampledDebtUsd / reportedDebtUsd : 0,
    pairOverlap,
    protocolCountHistogram,
    perProtocol,
    confidence,
  };
}
