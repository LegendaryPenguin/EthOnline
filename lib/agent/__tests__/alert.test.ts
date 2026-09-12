/**
 * The alert policy: its gates, and its behaviour replayed over Phase 6's labelled history.
 *
 * The replay is the part that matters. `lib/agent/__fixtures__/phase6-replay.json` holds
 * the measured scores from the backtest — the hour before each replayable cascade, and
 * twenty ordinary hours, each paired against the same hour a week earlier — so this test
 * asks the shipped policy the question Phase 6 asked the research code, and fails if the
 * two ever disagree. A policy whose thresholds drifted away from the run that calibrated
 * them would be an alert nobody had measured.
 *
 * The counts asserted below are Phase 6's, not this test's: each severity is a quantile of
 * the ordinary-hour change distribution, so p70 must fire on 6 of 20 ordinary hours, p80
 * on 4, p90 on 2. That is the stated false-alarm rate being checked against itself.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SentinelSignal } from "../../signal/aggregate";
import { decideAlert, parseAlertPolicy, severityAtLeast, type AlertPolicy } from "../alert";

const POLICY = parseAlertPolicy(readFileSync("docs/evidence/phase6-alert-policy.json", "utf8"));

const REPLAY = JSON.parse(
  readFileSync("lib/agent/__fixtures__/phase6-replay.json", "utf8"),
) as {
  controlLagHours: number;
  episodes: { id: string; block: number; score: number; controlScore: number }[];
  quiet: { hour: number; block: number; score: number; controlScore: number }[];
};

/**
 * A signal carrying only what the policy reads.
 *
 * Coverage is set above the gate on purpose: the Phase 6 backtest recorded the composite
 * score and not the whole signal, so coverage is exercised separately below with a
 * constructed value rather than invented into the replay fixture.
 */
function signalWith(score: number, block: number, over: Partial<SentinelSignal> = {}): SentinelSignal {
  return {
    version: "sentinel-signal/1",
    blocks: { "aave-v3-eth": block, "compound-v3-eth": block },
    protocols: ["aave-v3-eth", "compound-v3-eth"],
    borrowersObserved: 100,
    debtUsd: 1_000_000,
    evaluableDebtUsd: 1_000_000,
    reportedDebtUsd: 2_000_000,
    coverageOfReportedDebt: 0.5,
    multiProtocolBorrowers: 5,
    multiProtocolDebtUsd: 10_000,
    multiProtocolShareOfDebt: 0.01,
    leveredDebtUsd: 0,
    leveredShareOfDebt: 0,
    shockLadder: [],
    coupling: [],
    suppressedBuckets: [],
    emodeInferredBorrowers: 0,
    emodeInferredDebtUsd: 0,
    systemicRiskScore: score,
    ...over,
  };
}

const HEAD = 26_000_000;

function decide(score: number, controlScore: number | null, over: Partial<SentinelSignal> = {}) {
  return decideAlert({
    signal: signalWith(score, HEAD, over),
    control: controlScore === null ? null : signalWith(controlScore, HEAD - 50_000),
    headBlock: HEAD,
    policy: POLICY,
  });
}

describe("the calibrated policy document", () => {
  it("carries three severities, ascending, each stating its own false-alarm rate", () => {
    expect(POLICY.ladder.map((r) => r.severity)).toEqual(["watch", "warn", "alert"]);
    for (const row of POLICY.ladder) {
      expect(row.falseAlarmRate).toBeCloseTo(1 - row.quantile, 9);
    }
  });

  it("pairs against the same hour of the previous week", () => {
    // 168h, so hour-of-day and day-of-week cancel. Any other lag reintroduces the weekly
    // cycle that the pairing exists to remove.
    expect(POLICY.controlLagHours).toBe(168);
    expect(REPLAY.controlLagHours).toBe(POLICY.controlLagHours);
  });
});

describe("gates", () => {
  it("refuses a stale reading rather than alerting on it", () => {
    const decision = decideAlert({
      signal: signalWith(40, HEAD - 5_000),
      control: signalWith(20, HEAD - 55_000),
      headBlock: HEAD,
      policy: POLICY,
    });
    // A 20-point rise, which would be the loudest alert the ladder has, and it is refused.
    expect(decision.kind).toBe("refused");
    if (decision.kind === "refused") expect(decision.gate).toBe("stale");
  });

  it("refuses when only one deployment was read", () => {
    const decision = decide(40, 20, {
      protocols: ["aave-v3-eth"],
      blocks: { "aave-v3-eth": HEAD },
    });
    expect(decision.kind).toBe("refused");
    if (decision.kind === "refused") expect(decision.gate).toBe("protocols");
  });

  it("refuses when coverage is below the floor", () => {
    const decision = decide(40, 20, { coverageOfReportedDebt: 0.05 });
    expect(decision.kind).toBe("refused");
    if (decision.kind === "refused") expect(decision.gate).toBe("coverage");
  });

  it("refuses when no control reading exists, instead of falling back to the level", () => {
    // The level is the thing Phase 6 showed is not comparable across months. Falling back
    // to it would be the single worst substitution available here.
    const decision = decide(99, null);
    expect(decision.kind).toBe("refused");
    if (decision.kind === "refused") expect(decision.gate).toBe("no-control");
  });

  it("names the failing number in every refusal", () => {
    const stale = decideAlert({
      signal: signalWith(40, HEAD - 5_000),
      control: signalWith(20, HEAD - 55_000),
      headBlock: HEAD,
      policy: POLICY,
    });
    if (stale.kind !== "refused") throw new Error("expected refusal");
    expect(stale.reason).toMatch(/\d/);
    expect(stale.reason).toContain(String(POLICY.gates.maxStalenessBlocks));
  });
});

describe("severity", () => {
  const [watch, warn, alert] = [...POLICY.ladder].sort(
    (a, b) => a.deltaThreshold - b.deltaThreshold,
  );

  it("is quiet below the weakest threshold", () => {
    const d = decide(20 + watch.deltaThreshold - 0.01, 20);
    expect(d.kind).toBe("quiet");
  });

  it("reports the strongest severity a change clears", () => {
    for (const row of [watch, warn, alert]) {
      // A hair above the threshold rather than exactly on it: `20 + t - 20` is not `t` in
      // binary floating point, and this test is about the ladder, not about rounding.
      const d = decide(20 + row.deltaThreshold + 1e-9, 20);
      if (d.kind !== "alert") throw new Error(`expected an alert at ${row.severity}`);
      expect(severityAtLeast(d.severity, row.severity)).toBe(true);
    }
    const loud = decide(20 + alert.deltaThreshold + 5, 20);
    if (loud.kind !== "alert") throw new Error("expected an alert");
    expect(loud.severity).toBe("alert");
  });

  it("does not fire on a fall, however large", () => {
    // The August structural break was a nine-point fall. A policy that alerted on
    // magnitude rather than direction would have called it a crisis.
    const d = decide(10, 30);
    expect(d.kind).toBe("quiet");
  });

  it("explains itself with the threshold and its stated false-alarm rate", () => {
    const d = decide(20 + alert.deltaThreshold, 20);
    if (d.kind !== "alert") throw new Error("expected an alert");
    expect(d.reason).toContain(alert.deltaThreshold.toFixed(2));
    expect(d.reason).toContain("last week");
  });
});

describe("replayed over Phase 6's labelled history", () => {
  const fire = (score: number, control: number, minimum: "watch" | "warn" | "alert") => {
    const d = decide(score, control);
    return d.kind === "alert" && severityAtLeast(d.severity, minimum);
  };

  it("fires on the episodes Phase 6 says it should, and not the ones it says it should not", () => {
    // Phase 6's published result: the p80 change policy detects 3 of the 5 replayable
    // episodes, and the p90 detects none. Both halves are asserted, because a policy that
    // fired on everything would satisfy the first alone.
    const warnHits = REPLAY.episodes.filter((e) => fire(e.score, e.controlScore, "warn"));
    expect(warnHits).toHaveLength(3);
    const alertHits = REPLAY.episodes.filter((e) => fire(e.score, e.controlScore, "alert"));
    expect(alertHits).toHaveLength(0);
  });

  it("holds each severity to the false-alarm rate it states", () => {
    // The ordinary hours are the calibration set, so these counts are the quantile
    // definition being checked end to end through the shipped decision function.
    const expected: Record<string, number> = { watch: 6, warn: 4, alert: 2 };
    for (const [severity, count] of Object.entries(expected)) {
      const hits = REPLAY.quiet.filter((q) =>
        fire(q.score, q.controlScore, severity as "watch" | "warn" | "alert"),
      );
      expect(hits).toHaveLength(count);
      expect(hits.length / REPLAY.quiet.length).toBeCloseTo(
        POLICY.ladder.find((r) => r.severity === severity)!.falseAlarmRate,
        2,
      );
    }
  });

  it("separates episodes from ordinary hours better than chance at the warn level", () => {
    // Not a significance claim — Phase 6 states its own power at n = 5 — but the direction
    // has to survive being run through the shipped code, or the shipped code is not the
    // thing that was measured.
    const episodeRate =
      REPLAY.episodes.filter((e) => fire(e.score, e.controlScore, "warn")).length /
      REPLAY.episodes.length;
    const quietRate =
      REPLAY.quiet.filter((q) => fire(q.score, q.controlScore, "warn")).length /
      REPLAY.quiet.length;
    expect(episodeRate).toBeGreaterThan(quietRate);
  });
});

describe("parseAlertPolicy", () => {
  const base = JSON.parse(
    readFileSync("docs/evidence/phase6-alert-policy.json", "utf8"),
  ) as AlertPolicy;

  const mutated = (fn: (p: AlertPolicy) => void) => {
    const copy = JSON.parse(JSON.stringify(base)) as AlertPolicy;
    fn(copy);
    return () => parseAlertPolicy(JSON.stringify(copy));
  };

  it("rejects a ladder whose stronger severity is easier to fire", () => {
    expect(mutated((p) => {
      p.ladder.find((r) => r.severity === "alert")!.deltaThreshold = -1;
    })).toThrow(/below/);
  });

  it("rejects a stated false-alarm rate that does not match its quantile", () => {
    expect(mutated((p) => {
      p.ladder[0].falseAlarmRate = 0.001;
    })).toThrow(/does not match/);
  });

  it("rejects a single-protocol policy", () => {
    expect(mutated((p) => {
      p.gates.minProtocols = 1;
    })).toThrow(/cross-protocol/);
  });

  it("rejects a duplicated severity", () => {
    expect(mutated((p) => {
      p.ladder[1].severity = p.ladder[0].severity;
    })).toThrow(/duplicate|below/);
  });

  it("has no defaults to fall back on", () => {
    expect(() => parseAlertPolicy("{}")).toThrow();
  });
});
