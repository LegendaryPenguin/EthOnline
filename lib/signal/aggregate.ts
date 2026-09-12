/**
 * The confidential aggregation: per-address exposure in, one publishable signal out.
 *
 * This is the function the enclave exists for. Its input is the thing Sentinel
 * must never publish — a per-address map of who is levered on what, across which
 * protocols — and its output is a fixed set of aggregates that describe the
 * system without describing anyone in it.
 *
 * Why the input is dangerous rather than merely private: it is a ranked list of
 * the accounts closest to liquidation, cross-referenced across protocols, with
 * the collateral asset named. Published, it is an actionable target list for
 * liquidation bots and a deanonymization aid for anyone holding one address of a
 * cluster. Sentinel's value is in the aggregate, so there is no reason to expose
 * the rows — but there is also no way to compute the aggregate without them.
 * That is the whole argument for the TEE.
 *
 * Two properties this module owes the claim, both enforced rather than asserted:
 *
 *   1. Nothing address-shaped reaches the output. `assertAggregateOnly` walks the
 *      signal and refuses anything that looks like an address, so a field added
 *      carelessly later fails a test instead of leaking.
 *   2. No bucket is thin enough to re-identify. A protocol-pair overlap backed by
 *      one account, published with its debt, names that account's debt to anyone
 *      who can enumerate the pair. Buckets below the policy's k are suppressed
 *      and *counted*, so suppression is visible instead of silent.
 *
 * Runs identically inside the enclave and in the app, on purpose: a TEE running
 * different code from the product proves nothing. So no `process`, no `fetch`,
 * no Node built-ins, no `Intl` — this has to survive a WASM runtime.
 */

import { buildExposure, type EmodeOverride } from "../exposure/join";
import type { AccountExposure, Position } from "../exposure/types";
import { betaFor, type RiskPolicy } from "./policy";

export const SIGNAL_VERSION = "sentinel-signal/1";

/** A protocol-pair coupling bucket, published only when it clears k. */
export type CouplingBucket = {
  /** Two deployment keys, sorted, joined by "|". Never an address. */
  pair: string;
  borrowers: number;
  debtUsd: number;
};

/** Distressed debt at one shock magnitude. */
export type ShockResponse = {
  /** Positive fraction: 0.2 is a 20% collateral decline before betas. */
  shock: number;
  distressedDebtUsd: number;
  distressedBorrowers: number;
};

export type SentinelSignal = {
  version: string;
  /** Block each protocol's inputs were read at. Provenance is not optional. */
  blocks: Record<string, number>;
  protocols: string[];

  /** Distinct accounts carrying debt in the observed sample. */
  borrowersObserved: number;
  /** Observed debt USD. A sampled lower bound, never the protocol's total. */
  debtUsd: number;
  /** Observed debt on books whose risk parameters are self-consistent. */
  evaluableDebtUsd: number;
  /** Sum of protocol-reported total borrow balance, for coverage. */
  reportedDebtUsd: number;
  coverageOfReportedDebt: number;

  /** The headline: debt held by addresses levered across 2+ protocols. */
  multiProtocolBorrowers: number;
  multiProtocolDebtUsd: number;
  multiProtocolShareOfDebt: number;

  /** Debt at or below the policy's leverage watch level. */
  leveredDebtUsd: number;
  leveredShareOfDebt: number;

  /** Ascending by shock. Monotone by construction. */
  shockLadder: ShockResponse[];

  /** Protocol-pair coupling, thin buckets removed. */
  coupling: CouplingBucket[];
  /** Buckets withheld for k-anonymity, with the count that failed. */
  suppressedBuckets: { pair: string; borrowers: number }[];

  /**
   * Books whose numbers rest on the policy's E-Mode reconstruction rather than on
   * published parameters alone. Published so a consumer can see how much of the
   * evaluable book is inferred; a signal that hides its own inference is asking to
   * be trusted rather than checked.
   */
  emodeInferredBorrowers: number;
  emodeInferredDebtUsd: number;

  /** Composite in [0,100] under the confidential weights. */
  systemicRiskScore: number;
};

export type AggregateInput = {
  positions: Position[];
  /** Deployment key -> block served. */
  blocks: Record<string, number>;
  /** Deployment key -> protocol-reported total borrow balance USD. */
  reportedDebtUsd: Record<string, number>;
  policy: RiskPolicy;
};

export function aggregateSignal(input: AggregateInput): SentinelSignal {
  const { policy } = input;
  const exposures = groupByAccount(input.positions, policy.emode);

  let borrowersObserved = 0;
  let debtUsd = 0;
  let evaluableDebtUsd = 0;
  let multiProtocolBorrowers = 0;
  let multiProtocolDebtUsd = 0;
  let leveredDebtUsd = 0;
  let emodeInferredBorrowers = 0;
  let emodeInferredDebtUsd = 0;

  const pairBorrowers = new Map<string, { borrowers: number; debtUsd: number }>();
  const distressed = policy.shocks.map((shock) => ({
    shock,
    distressedDebtUsd: 0,
    distressedBorrowers: 0,
  }));

  for (const e of exposures) {
    if (e.debtUsd <= 0) continue;
    borrowersObserved++;
    debtUsd += e.debtUsd;

    // A contradicted book reports a health factor below 1 while the account sits
    // un-liquidated. Liquidating it would be profitable and bots are fast, so the
    // account still being alive is stronger evidence than our arithmetic: the
    // published risk parameters are wrong, not the borrower. Phase 4 traced the
    // dominant cause to Aave V3 E-Mode, which the standardized schema does not
    // express. Such books are counted in `debtUsd` and excluded from every
    // component, because shocking a book whose baseline is already wrong produces
    // a distress figure with no defensible units.
    if (e.confidence === "contradicted") continue;
    evaluableDebtUsd += e.debtUsd;

    if (Object.values(e.byProtocol).some((b) => b.emodeThreshold !== null)) {
      emodeInferredBorrowers++;
      emodeInferredDebtUsd += e.debtUsd;
    }

    const debtProtocols = borrowingProtocols(e);
    if (debtProtocols.length >= 2) {
      multiProtocolBorrowers++;
      multiProtocolDebtUsd += e.debtUsd;
      for (let i = 0; i < debtProtocols.length; i++) {
        for (let j = i + 1; j < debtProtocols.length; j++) {
          const key = `${debtProtocols[i]}|${debtProtocols[j]}`;
          const bucket = pairBorrowers.get(key) ?? { borrowers: 0, debtUsd: 0 };
          bucket.borrowers++;
          bucket.debtUsd += e.debtUsd;
          pairBorrowers.set(key, bucket);
        }
      }
    }

    if (e.aggregateLeverageRatio <= policy.leverageWatchLevel) {
      leveredDebtUsd += e.debtUsd;
    }

    for (let i = 0; i < policy.shocks.length; i++) {
      const hit = shockedDistress(e, policy.shocks[i], policy);
      if (hit > 0) {
        distressed[i].distressedDebtUsd += hit;
        distressed[i].distressedBorrowers++;
      }
    }
  }

  // Suppression happens here and only here: buckets are built without regard to
  // k and then filtered, so the count that failed is known and can be reported.
  const coupling: CouplingBucket[] = [];
  const suppressedBuckets: { pair: string; borrowers: number }[] = [];
  for (const [pair, b] of [...pairBorrowers].sort((a, z) => a[0].localeCompare(z[0]))) {
    if (b.borrowers < policy.kAnonymity) {
      suppressedBuckets.push({ pair, borrowers: b.borrowers });
      continue;
    }
    coupling.push({ pair, borrowers: b.borrowers, debtUsd: b.debtUsd });
  }

  let reportedTotal = 0;
  for (const v of Object.values(input.reportedDebtUsd)) reportedTotal += v;

  const share = (n: number) => (evaluableDebtUsd > 0 ? n / evaluableDebtUsd : 0);
  const worstShock = distressed.length > 0 ? distressed[distressed.length - 1] : undefined;

  const signal: SentinelSignal = {
    version: SIGNAL_VERSION,
    blocks: { ...input.blocks },
    protocols: Object.keys(input.blocks).sort(),
    borrowersObserved,
    debtUsd,
    evaluableDebtUsd,
    reportedDebtUsd: reportedTotal,
    coverageOfReportedDebt: reportedTotal > 0 ? debtUsd / reportedTotal : 0,
    multiProtocolBorrowers,
    multiProtocolDebtUsd,
    multiProtocolShareOfDebt: share(multiProtocolDebtUsd),
    leveredDebtUsd,
    leveredShareOfDebt: share(leveredDebtUsd),
    shockLadder: distressed,
    coupling,
    suppressedBuckets,
    emodeInferredBorrowers,
    emodeInferredDebtUsd,
    systemicRiskScore:
      100 *
      clamp01(
        policy.weights.concentration * share(multiProtocolDebtUsd) +
          policy.weights.leverage * share(leveredDebtUsd) +
          policy.weights.distress * share(worstShock?.distressedDebtUsd ?? 0),
      ),
  };

  // Cheap enough to run unconditionally, and the one check whose failure means the
  // enclave leaked. Running it here rather than at the call site means every
  // caller gets it, including the one written next year.
  assertAggregateOnly(signal);
  return signal;
}

/**
 * Debt that crosses its liquidation boundary under a shock, summed per protocol.
 *
 * Per protocol on purpose: no protocol can liquidate against collateral held at
 * another, so an aggregate health factor would net a surplus on Aave against a
 * deficit on Compound and report safety that nobody could enforce. The
 * cross-protocol part of the story is the *correlation* of these events, not a
 * pooled balance sheet.
 */
function shockedDistress(e: AccountExposure, shock: number, policy: RiskPolicy): number {
  const weighted: Record<string, number> = {};
  const debt: Record<string, number> = {};

  for (const p of e.positions) {
    if (p.side === "BORROWER") {
      debt[p.protocol] = (debt[p.protocol] ?? 0) + p.valueUsd;
      continue;
    }
    // Unknown thresholds contribute nothing, matching `buildExposure`. That makes
    // the shock response pessimistic rather than invented, and the direction is
    // stated rather than hidden.
    if (p.liquidationThreshold <= 0) continue;
    const decline = Math.min(1, shock * betaFor(policy, p.assetId));
    // The same effective threshold the baseline was measured at. Shocking a book
    // against the published threshold when its baseline solvency was established
    // under the E-Mode reconstruction would report distress the reconstruction
    // already ruled out — the shock response has to be consistent with the
    // health factor it is a shock to.
    const threshold = Math.max(
      p.liquidationThreshold,
      e.byProtocol[p.protocol]?.emodeThreshold ?? 0,
    );
    weighted[p.protocol] = (weighted[p.protocol] ?? 0) + p.valueUsd * (1 - decline) * threshold;
  }

  let hit = 0;
  for (const [protocol, d] of Object.entries(debt)) {
    if (d > 0 && (weighted[protocol] ?? 0) < d) hit += d;
  }
  return hit;
}

function borrowingProtocols(e: AccountExposure): string[] {
  const seen = new Set<string>();
  for (const p of e.positions) {
    if (p.side === "BORROWER" && p.valueUsd > 0) seen.add(p.protocol);
  }
  return [...seen].sort();
}

function groupByAccount(positions: Position[], emode: EmodeOverride): AccountExposure[] {
  const byAccount = new Map<string, Position[]>();
  for (const p of positions) {
    const bucket = byAccount.get(p.account);
    if (bucket) bucket.push(p);
    else byAccount.set(p.account, [p]);
  }
  return [...byAccount].map(([account, ps]) => buildExposure(account, ps, emode));
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Anything that looks like an EVM address, in any case. */
const ADDRESS_LIKE = /0x[0-9a-fA-F]{40}/;

/**
 * Refuse to emit a signal carrying anything address-shaped.
 *
 * The privacy claim is only as good as the last field somebody added, and the
 * realistic failure is not malice: it is a debugging field, or a `Record` keyed
 * by account that someone forgets is keyed by account. So the guard is structural
 * — every string and every object key in the whole tree, values and keys alike,
 * because a leak through a key is still a leak.
 *
 * `blocks` and `coupling.pair` are keyed by deployment key ("aave-v3-eth"), which
 * is why deployment keys are names and not contract addresses. That was already
 * true; this check is what keeps it true.
 */
export function assertAggregateOnly(signal: unknown): void {
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      if (ADDRESS_LIKE.test(node)) {
        throw new Error(`signal leak: address-shaped value at ${path}: ${node}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [k, v] of Object.entries(node)) {
        if (ADDRESS_LIKE.test(k)) {
          throw new Error(`signal leak: address-shaped key at ${path}.${k}`);
        }
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(signal, "signal");
}

/**
 * The rows the enclave exists to withhold.
 *
 * Not part of the product path — nothing in `lib/` or `app/` calls this. It
 * exists so `npm run leak-demo` can run the identical aggregation with the
 * enclave taken out of the loop and show, concretely, what would be published:
 * named addresses, their cross-protocol debt, their distance from liquidation,
 * ranked. Claiming a TEE is load-bearing without showing the leak is a claim; the
 * script makes it a demonstration.
 *
 * Deliberately not exported through any index barrel, and deliberately named so
 * that its appearance in a diff is a question.
 */
export function perAddressRowsForLeakDemoOnly(
  positions: Position[],
  policy: RiskPolicy,
): {
  account: string;
  protocols: string[];
  debtUsd: number;
  collateralUsd: number;
  aggregateLeverageRatio: number;
  topCollateralAsset: string;
  distressedAtShock: number | null;
}[] {
  return groupByAccount(positions, policy.emode)
    .filter((e) => e.debtUsd > 0)
    .map((e) => {
      let topCollateralAsset = "";
      let topValue = 0;
      for (const [asset, usd] of Object.entries(e.collateralByAsset)) {
        if (usd > topValue) {
          topValue = usd;
          topCollateralAsset = asset;
        }
      }
      const firstHit = policy.shocks.find((s) => shockedDistress(e, s, policy) > 0);
      return {
        account: e.account,
        protocols: e.protocols,
        debtUsd: e.debtUsd,
        collateralUsd: e.collateralUsd,
        aggregateLeverageRatio: e.aggregateLeverageRatio,
        topCollateralAsset,
        distressedAtShock: firstHit ?? null,
      };
    })
    .sort((a, b) => b.debtUsd - a.debtUsd);
}
