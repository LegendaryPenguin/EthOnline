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
  };
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
