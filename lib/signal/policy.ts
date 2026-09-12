/**
 * The risk policy: the part of Sentinel that is secret on purpose.
 *
 * Sentinel publishes one number that markets could act on, so the recipe behind
 * that number is worth money to anyone who wants to move it. Publish the shock
 * magnitudes and the composite weights and the signal becomes gameable in a
 * specific, mechanical way: a borrower who knows the exact shock ladder knows
 * precisely how far to unwind to fall out of the distressed set, and a protocol
 * that knows the weights knows which component to flatter. The output stays
 * public — that is the whole product — but the policy that produces it does not.
 *
 * So the policy is a Vault DON secret, released only into an attested enclave,
 * and it enters this module as an opaque JSON string. Nothing here has a default:
 * a policy that silently falls back would publish a signal under weights nobody
 * chose, which is worse than failing. Every field is required and validated, and
 * a bad policy throws before a single position is read.
 *
 * This file is imported by both the CRE workflow and the app, so it must stay
 * free of `process`, `fetch`, and anything else absent from a WASM runtime.
 */

import type { EmodeOverride } from "../exposure/join";

export type RiskPolicy = {
  /**
   * Collateral price shocks to evaluate, as positive fractions: 0.2 is a 20%
   * decline. Ascending, so the published ladder is monotone by construction.
   */
  shocks: number[];
  /**
   * Per-asset shock multipliers keyed by lowercased token address. A shock of
   * 0.2 against an asset with beta 1.4 is a 28% decline for that asset. Assets
   * absent from the map take `defaultBeta`.
   *
   * Betas are the honest admission that a uniform shock is fiction: stETH and
   * USDC do not fall together. Phase 4 measures these against oracle history.
   */
  assetBeta: Record<string, number>;
  defaultBeta: number;
  /**
   * Minimum distinct accounts behind any published bucket. Buckets thinner than
   * this are suppressed rather than rounded — see `aggregate.ts`.
   */
  kAnonymity: number;
  /**
   * Weights of the composite score's three components, each already a fraction
   * of debt in [0,1]. Must sum to 1 so the score is bounded and its units mean
   * something.
   *
   * `concentration`  share of observed debt held by multi-protocol borrowers
   * `leverage`       share of observed debt above the leverage watch level
   * `distress`       share of observed debt distressed at the largest shock
   */
  weights: { concentration: number; leverage: number; distress: number };
  /**
   * Aggregate leverage ratio at or below which a borrower counts as levered for
   * the `leverage` component. Not a liquidation threshold — no protocol
   * liquidates against another's collateral — a watch level.
   */
  leverageWatchLevel: number;
  /**
   * The E-Mode reconstruction: correlated asset sets and the elevated liquidation
   * threshold they carry.
   *
   * Aave V3's E-Mode is not in the Messari lending schema, and ignoring it is the
   * largest single error in the system — measured live, it made $3.9B of $5.7B of
   * observed debt compute insolvent while alive on chain, so it was discarded and
   * two thirds of the book became unevaluable. Phase 4 measures the correlation
   * from a year of the protocols' own oracle prices and validates the result
   * against Aave's contract; that measurement cannot be repeated inside the
   * enclave, which has fifteen HTTP calls. So it arrives here, in the policy.
   *
   * It belongs in the *secret* half for the same reason as the shock ladder: the
   * groups and the ceiling are exactly what a borrower would need to know to
   * arrange a book that falls out of the distressed set.
   *
   * `groups` may be empty, which turns the reconstruction off. That has to be
   * written down explicitly rather than omitted — a signal published with E-Mode
   * silently disabled is a different signal, and nobody should get there by
   * forgetting a field.
   */
  emode: EmodeOverride;
};

const WEIGHT_KEYS = ["concentration", "leverage", "distress"] as const;

/** Tolerance on the weights summing to 1, for JSON float representation only. */
const WEIGHT_SUM_EPSILON = 1e-9;

export function parseRiskPolicy(json: string): RiskPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("risk policy is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("risk policy must be a JSON object");
  }
  const o = raw as Record<string, unknown>;

  const shocks = numberArray(o.shocks, "shocks");
  if (shocks.length === 0) throw new Error("risk policy: shocks must not be empty");
  for (const s of shocks) {
    if (s <= 0 || s >= 1) throw new Error(`risk policy: shock ${s} outside (0,1)`);
  }
  for (let i = 1; i < shocks.length; i++) {
    if (shocks[i] <= shocks[i - 1]) {
      throw new Error("risk policy: shocks must be strictly ascending");
    }
  }

  const assetBeta: Record<string, number> = {};
  const betaRaw = o.assetBeta;
  if (typeof betaRaw !== "object" || betaRaw === null) {
    throw new Error("risk policy: assetBeta must be an object");
  }
  for (const [asset, beta] of Object.entries(betaRaw as Record<string, unknown>)) {
    if (!/^0x[0-9a-f]{40}$/.test(asset)) {
      throw new Error(`risk policy: assetBeta key is not a lowercased address: ${asset}`);
    }
    assetBeta[asset] = positive(beta, `assetBeta.${asset}`);
  }

  const weightsRaw = o.weights;
  if (typeof weightsRaw !== "object" || weightsRaw === null) {
    throw new Error("risk policy: weights must be an object");
  }
  const w = weightsRaw as Record<string, unknown>;
  const weights = { concentration: 0, leverage: 0, distress: 0 };
  let sum = 0;
  for (const k of WEIGHT_KEYS) {
    const v = finite(w[k], `weights.${k}`);
    if (v < 0) throw new Error(`risk policy: weights.${k} is negative`);
    weights[k] = v;
    sum += v;
  }
  if (Math.abs(sum - 1) > WEIGHT_SUM_EPSILON) {
    throw new Error(`risk policy: weights sum to ${sum}, not 1`);
  }

  const kAnonymity = positive(o.kAnonymity, "kAnonymity");
  if (!Number.isInteger(kAnonymity)) throw new Error("risk policy: kAnonymity must be an integer");
  if (kAnonymity < 2) throw new Error("risk policy: kAnonymity below 2 suppresses nothing");

  return {
    shocks,
    assetBeta,
    defaultBeta: positive(o.defaultBeta, "defaultBeta"),
    kAnonymity,
    weights,
    leverageWatchLevel: positive(o.leverageWatchLevel, "leverageWatchLevel"),
    emode: parseEmode(o.emode),
  };
}

function parseEmode(v: unknown): EmodeOverride {
  if (typeof v !== "object" || v === null) throw new Error("risk policy: emode must be an object");
  const o = v as Record<string, unknown>;

  const threshold = positive(o.threshold, "emode.threshold");
  // Above 1 the "threshold" would let a book borrow more than its collateral is
  // worth and still read as solvent, which is not a lenient parameter but a broken
  // one. At or below the schema's own published thresholds it would never bind.
  if (threshold >= 1) throw new Error(`risk policy: emode.threshold ${threshold} is not below 1`);

  if (!Array.isArray(o.groups)) throw new Error("risk policy: emode.groups must be an array");
  const groups: string[][] = [];
  const seen = new Map<string, number>();
  for (const [i, group] of o.groups.entries()) {
    if (!Array.isArray(group) || group.length < 2) {
      // A one-asset group cannot express a correlated *pair*, so it is a typo
      // rather than a configuration: it would silently lift the threshold on any
      // single-asset book, which is the opposite of what E-Mode means.
      throw new Error(`risk policy: emode.groups[${i}] must list at least two assets`);
    }
    const assets: string[] = [];
    for (const asset of group) {
      if (typeof asset !== "string" || !/^0x[0-9a-f]{40}$/.test(asset)) {
        throw new Error(
          `risk policy: emode.groups[${i}] contains a non-lowercased address: ${String(asset)}`,
        );
      }
      // An asset in two groups makes the applied threshold depend on group order,
      // and a silently order-dependent risk parameter is not a risk parameter.
      const owner = seen.get(asset);
      if (owner !== undefined) {
        throw new Error(`risk policy: ${asset} appears in emode.groups[${owner}] and [${i}]`);
      }
      seen.set(asset, i);
      assets.push(asset);
    }
    groups.push(assets);
  }

  return { threshold, groups };
}

export function betaFor(policy: RiskPolicy, assetId: string): number {
  return policy.assetBeta[assetId] ?? policy.defaultBeta;
}

function finite(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`risk policy: ${field} must be a finite number`);
  }
  return v;
}

function positive(v: unknown, field: string): number {
  const n = finite(v, field);
  if (n <= 0) throw new Error(`risk policy: ${field} must be positive`);
  return n;
}

function numberArray(v: unknown, field: string): number[] {
  if (!Array.isArray(v)) throw new Error(`risk policy: ${field} must be an array`);
  return v.map((x, i) => finite(x, `${field}[${i}]`));
}
