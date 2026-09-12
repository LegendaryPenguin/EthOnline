/**
 * The alert policy: when a published signal is worth waking someone for.
 *
 * This is deliberately not a cron that prints the score, and deliberately not a model
 * deciding whether a number "looks bad". It is a function of the signal and its own
 * value one week earlier, with thresholds that were calibrated in Phase 6 on ordinary
 * hours alone — never on an outcome — and copied here from
 * `docs/evidence/phase6-alert-policy.json` rather than chosen.
 *
 * ## Why the operating variable is a change and not a level
 *
 * Phase 6 measured this and it was not the expected answer. An absolute threshold
 * calibrated once on ordinary hours (the p90 of the score itself) detected **0 of 5**
 * replayable cascades, and the score ladder shows why: the published score sat near 31
 * in July and near 21 in September, a ten-point drift against under one point of
 * movement across an episode's own approach. Any fixed level is therefore either always
 * on or never on, depending only on the month it was fitted in. The *change* is
 * comparable across months; the level is not. So the policy reads
 * `systemicRiskScore(now) − systemicRiskScore(now − 168h)`, and 168 hours is chosen so
 * that hour-of-day and day-of-week match and the weekly cycle cancels.
 *
 * ## Why three severities and not one
 *
 * Each severity is a quantile of the ordinary-hour change distribution, so each one
 * states its own false-alarm rate: `watch` fires on the 30% of ordinary weeks with the
 * largest rise, `warn` on the top 20%, `alert` on the top 10%. Phase 6 could have
 * picked whichever quantile detected the most episodes, which would have been fitting
 * the operating point to five labels. Publishing the ladder instead lets a consumer with
 * its own cost of a false alarm pick a row, and it is honest that the strictest row is
 * the one the five replayable episodes do not clear.
 *
 * ## Why it refuses
 *
 * Three of the five registered deployments serve no historical state and one is rejected
 * outright by the reconciliation gate, so "the data is thinner than usual" is the normal
 * condition here, not an exception. An alert computed from a book the enclave could not
 * read is worse than silence, because it looks identical to one that could. Every
 * refusal names the gate it failed and the number that failed it.
 */

import type { SentinelSignal } from "../signal/aggregate";

/** Severity names, weakest first. Ordering is load-bearing: `severityAtLeast` uses it. */
export const SEVERITIES = ["watch", "warn", "alert"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type AlertPolicy = {
  /** Provenance of the thresholds: which Phase 6 run produced them. */
  calibration: {
    /** ISO timestamp of the backtest run. */
    generatedAt: string;
    /** Head block the run was calibrated at. */
    head: number;
    /** Ordinary-hour observations behind each quantile. */
    ordinaryHours: number;
    /** Replayable cascade episodes the ladder was scored against. */
    episodes: number;
  };
  /** Hours between a reading and its control. 168 = same hour, previous week. */
  controlLagHours: number;
  /**
   * One row per severity, ascending in threshold. `quantile` and `falseAlarmRate` are
   * kept alongside the threshold so a consumer never has to guess what it bought.
   */
  ladder: {
    severity: Severity;
    quantile: number;
    falseAlarmRate: number;
    /** Minimum week-on-week rise in `systemicRiskScore` that fires this severity. */
    deltaThreshold: number;
  }[];
  /** Gates below which no severity is emitted and a refusal is returned instead. */
  gates: {
    /** Blocks the signal may lag the chain head before it is stale. */
    maxStalenessBlocks: number;
    /** Sampled debt as a share of protocol-reported borrow, below which coverage is too thin. */
    minCoverageOfReportedDebt: number;
    /** Distinct deployments that must have been read. 1 cannot show cross-protocol leverage. */
    minProtocols: number;
  };
};

export type AlertInput = {
  signal: SentinelSignal;
  /** The signal published `controlLagHours` earlier, or null if none is retained. */
  control: SentinelSignal | null;
  /** Chain head at decision time, for the staleness gate. */
  headBlock: number;
  policy: AlertPolicy;
};

export type AlertDecision =
  | {
      kind: "refused";
      /** The gate that failed, machine-readable, so a monitor can count refusals by cause. */
      gate: "stale" | "coverage" | "protocols" | "no-control";
      reason: string;
    }
  | { kind: "quiet"; delta: number; reason: string }
  | {
      kind: "alert";
      severity: Severity;
      delta: number;
      falseAlarmRate: number;
      reason: string;
    };

/** True when `a` is at least as severe as `b`. */
export function severityAtLeast(a: Severity, b: Severity): boolean {
  return SEVERITIES.indexOf(a) >= SEVERITIES.indexOf(b);
}

/**
 * The whole policy, as one pure function.
 *
 * Pure and total on purpose: the same signal and control always yield the same decision,
 * which is what makes the Phase 6 replay a test of the policy rather than an anecdote
 * about one run. Gates are checked before the comparison so a thin book can never
 * produce a severity, however large its apparent change.
 */
export function decideAlert({ signal, control, headBlock, policy }: AlertInput): AlertDecision {
  const blocks = Object.values(signal.blocks);
  if (blocks.length === 0) {
    return { kind: "refused", gate: "protocols", reason: "signal names no blocks" };
  }
  const asOf = Math.min(...blocks);

  const lag = headBlock - asOf;
  if (lag > policy.gates.maxStalenessBlocks) {
    return {
      kind: "refused",
      gate: "stale",
      reason:
        `signal is ${lag} blocks behind head ${headBlock} (limit ` +
        `${policy.gates.maxStalenessBlocks}); a stale alert is indistinguishable from a fresh one`,
    };
  }

  if (signal.protocols.length < policy.gates.minProtocols) {
    return {
      kind: "refused",
      gate: "protocols",
      reason:
        `only ${signal.protocols.length} deployment(s) read (need ` +
        `${policy.gates.minProtocols}); cross-protocol leverage is not observable`,
    };
  }

  if (signal.coverageOfReportedDebt < policy.gates.minCoverageOfReportedDebt) {
    return {
      kind: "refused",
      gate: "coverage",
      reason:
        `sampled debt covers ${(100 * signal.coverageOfReportedDebt).toFixed(1)}% of ` +
        `reported borrow (need ${(100 * policy.gates.minCoverageOfReportedDebt).toFixed(1)}%)`,
    };
  }

  if (!control) {
    return {
      kind: "refused",
      gate: "no-control",
      reason:
        `no signal retained ${policy.controlLagHours}h earlier, and the calibrated ` +
        `operating variable is the change against that reading, not the level`,
    };
  }

  const delta = signal.systemicRiskScore - control.systemicRiskScore;

  // Descending, so the strongest severity a delta clears is the one reported.
  const ladder = [...policy.ladder].sort((a, b) => b.deltaThreshold - a.deltaThreshold);
  for (const row of ladder) {
    if (delta >= row.deltaThreshold) {
      return {
        kind: "alert",
        severity: row.severity,
        delta,
        falseAlarmRate: row.falseAlarmRate,
        reason:
          `systemic risk score rose ${delta.toFixed(2)} points against the same hour ` +
          `last week (${control.systemicRiskScore.toFixed(2)} -> ` +
          `${signal.systemicRiskScore.toFixed(2)}), clearing the ${row.severity} threshold ` +
          `of ${row.deltaThreshold.toFixed(2)} calibrated at the p` +
          `${(100 * row.quantile).toFixed(0)} of ordinary weeks`,
      };
    }
  }

  const weakest = ladder[ladder.length - 1];
  return {
    kind: "quiet",
    delta,
    reason:
      `week-on-week change ${delta.toFixed(2)} is below the weakest threshold ` +
      `${weakest.deltaThreshold.toFixed(2)}`,
  };
}

/** Parse and validate a policy document, with no defaults. A silent default would alert under thresholds nobody chose. */
export function parseAlertPolicy(json: string): AlertPolicy {
  const raw = JSON.parse(json) as unknown;
  if (typeof raw !== "object" || raw === null) throw new Error("alert policy: not an object");
  const p = raw as Partial<AlertPolicy>;

  if (!p.calibration || typeof p.calibration.head !== "number") {
    throw new Error("alert policy: missing calibration.head");
  }
  if (typeof p.controlLagHours !== "number" || p.controlLagHours <= 0) {
    throw new Error("alert policy: controlLagHours must be positive");
  }
  if (!Array.isArray(p.ladder) || p.ladder.length === 0) {
    throw new Error("alert policy: empty ladder");
  }
  for (const row of p.ladder) {
    if (!SEVERITIES.includes(row.severity)) {
      throw new Error(`alert policy: unknown severity ${row.severity}`);
    }
    if (!Number.isFinite(row.deltaThreshold)) {
      throw new Error(`alert policy: ${row.severity} has no finite threshold`);
    }
    if (Math.abs(row.falseAlarmRate - (1 - row.quantile)) > 1e-9) {
      // The stated false-alarm rate is what a consumer chooses a row by, so it must be
      // the quantile's complement and not an independently typed number.
      throw new Error(
        `alert policy: ${row.severity} states a false-alarm rate that does not match its quantile`,
      );
    }
  }
  const bySeverity = new Set(p.ladder.map((r) => r.severity));
  if (bySeverity.size !== p.ladder.length) throw new Error("alert policy: duplicate severity");

  // A stronger severity must never be easier to fire than a weaker one.
  const ordered = [...p.ladder].sort(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity),
  );
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].deltaThreshold < ordered[i - 1].deltaThreshold) {
      throw new Error(
        `alert policy: ${ordered[i].severity} threshold is below ${ordered[i - 1].severity}`,
      );
    }
  }

  const g = p.gates;
  if (
    !g ||
    typeof g.maxStalenessBlocks !== "number" ||
    typeof g.minCoverageOfReportedDebt !== "number" ||
    typeof g.minProtocols !== "number"
  ) {
    throw new Error("alert policy: gates incomplete");
  }
  if (g.minProtocols < 2) {
    throw new Error("alert policy: minProtocols below 2 cannot observe cross-protocol leverage");
  }

  return p as AlertPolicy;
}
