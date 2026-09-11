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

import type { AccountExposure, Position } from "./types";

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

export function buildExposure(account: string, positions: Position[]): AccountExposure {
  let collateralUsd = 0;
  let debtUsd = 0;
  let weightedCollateralUsd = 0;
  const collateralByAsset: Record<string, number> = {};
  const protocols = new Set<string>();

  for (const p of positions) {
    protocols.add(p.protocol);
    if (p.side === "BORROWER") {
      debtUsd += p.valueUsd;
    } else {
      collateralUsd += p.valueUsd;
      weightedCollateralUsd += p.valueUsd * p.liquidationThreshold;
      collateralByAsset[p.assetId] = (collateralByAsset[p.assetId] ?? 0) + p.valueUsd;
    }
  }

  return {
    account,
    protocols: [...protocols].sort(),
    collateralUsd,
    debtUsd,
    weightedCollateralUsd,
    healthFactor: debtUsd > 0 ? weightedCollateralUsd / debtUsd : Infinity,
    positions,
    collateralByAsset,
  };
}

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

  for (const e of exposures.values()) {
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
  };
}
