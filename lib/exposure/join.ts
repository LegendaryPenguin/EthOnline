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

/**
 * An elevated liquidation threshold for correlated collateral-and-debt pairs.
 *
 * This is Aave V3 E-Mode, which the Messari lending schema has no field for. Left
 * uncorrected it is the single largest error in the whole system: measured on live
 * mainnet, $3.9B of the $5.7B of observed debt computed to a health factor below 1
 * while sitting un-liquidated on chain, so it had to be discarded as
 * `contradicted` and 68% of the book became unevaluable.
 *
 * `groups` are correlated asset sets and `threshold` is the ceiling those sets
 * carry. Neither is guessed here: `lib/cascade/factors.ts` measures correlation
 * from a year of the protocols' own oracle prices, `lib/cascade/emode.ts` derives
 * the inference, and `npm run verify:emode` checks it against Aave's contract. This
 * type is just the channel that carries the measurement to the place that needs it
 * — including into the enclave, which has no HTTP budget to measure a year of
 * prices and receives the result inside its secret risk policy instead.
 */
export type EmodeOverride = {
  /** Elevated liquidation threshold, as a fraction. */
  threshold: number;
  /** Correlated asset sets, lowercased asset ids. */
  groups: string[][];
};

export function joinByAccount(
  positions: Position[],
  emode?: EmodeOverride,
): Map<string, AccountExposure> {
  const byAccount = new Map<string, Position[]>();

  for (const p of positions) {
    const bucket = byAccount.get(p.account);
    if (bucket) bucket.push(p);
    else byAccount.set(p.account, [p]);
  }

  const out = new Map<string, AccountExposure>();
  for (const [account, ps] of byAccount) {
    out.set(account, buildExposure(account, ps, emode));
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
  emodeThreshold: null,
});

/** Totals for one protocol, with `floor` as a lower bound on every known threshold. */
function measureProtocol(positions: Position[], floor: number): ProtocolExposure {
  const b = emptyProtocol();

  for (const p of positions) {
    if (p.side === "BORROWER") {
      b.debtUsd += p.valueUsd;
      continue;
    }
    b.collateralUsd += p.valueUsd;
    if (p.liquidationThreshold > 0) {
      // The floor lifts a known threshold; it never invents one. E-Mode says a
      // correlated pair is treated more leniently, not that an asset the subgraph
      // reports no threshold for is collateral at all.
      b.weightedCollateralUsd += p.valueUsd * Math.max(p.liquidationThreshold, floor);
    } else {
      // Unknown threshold contributes nothing to the liquidation boundary. That
      // makes the health factor pessimistic rather than invented.
      b.unknownThresholdUsd += p.valueUsd;
    }
  }

  b.healthFactor = b.debtUsd > 0 ? b.weightedCollateralUsd / b.debtUsd : Infinity;
  b.confidence = classify(b);
  return b;
}

/**
 * The elevated threshold this protocol's book qualifies for, or 0.
 *
 * Every priced collateral asset and every borrowed asset must sit in one group.
 * Aave grants E-Mode to a position, not to an asset, so a book with an
 * uncorrelated leg does not qualify — and requiring the whole book rather than a
 * dominant share of it errs toward applying the inference less often.
 */
export function correlatedFloor(positions: Position[], emode: EmodeOverride): number {
  const assets = new Set<string>();
  for (const p of positions) {
    if (p.valueUsd <= 0) continue;
    if (p.side === "COLLATERAL" && p.liquidationThreshold <= 0) continue;
    assets.add(p.assetId);
  }
  if (assets.size === 0) return 0;

  for (const group of emode.groups) {
    const members = new Set(group);
    let all = true;
    for (const a of assets) {
      if (!members.has(a)) {
        all = false;
        break;
      }
    }
    if (all) return emode.threshold;
  }
  return 0;
}

export function buildExposure(
  account: string,
  positions: Position[],
  emode?: EmodeOverride,
): AccountExposure {
  const positionsByProtocol = new Map<string, Position[]>();
  const collateralByAsset: Record<string, number> = {};

  for (const p of positions) {
    const bucket = positionsByProtocol.get(p.protocol);
    if (bucket) bucket.push(p);
    else positionsByProtocol.set(p.protocol, [p]);
    if (p.side === "COLLATERAL") {
      collateralByAsset[p.assetId] = (collateralByAsset[p.assetId] ?? 0) + p.valueUsd;
    }
  }

  const byProtocol: Record<string, ProtocolExposure> = {};
  for (const [protocol, ps] of positionsByProtocol) {
    let measured = measureProtocol(ps, 0);

    // E-Mode is inferred only where it is needed to resolve a contradiction. A book
    // that already computes solvent tells us nothing about whether it is in E-Mode,
    // and lifting its threshold anyway would flatter the signal for free. A book
    // that computes insolvent while alive on chain is evidence that the published
    // threshold is wrong, and the correlated-pair case is the known reason why.
    if (emode && measured.confidence === "contradicted") {
      const floor = correlatedFloor(ps, emode);
      if (floor > 0) {
        const lifted = measureProtocol(ps, floor);
        // Still contradicted means E-Mode was not the explanation, so nothing is
        // claimed: the book keeps its original, honest numbers.
        if (lifted.confidence !== "contradicted") {
          lifted.emodeThreshold = floor;
          measured = lifted;
        }
      }
    }

    byProtocol[protocol] = measured;
  }

  let collateralUsd = 0;
  let debtUsd = 0;
  let weightedCollateralUsd = 0;
  let unknownThresholdUsd = 0;
  let confidence: HealthConfidence = "ok";

  for (const b of Object.values(byProtocol)) {
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
