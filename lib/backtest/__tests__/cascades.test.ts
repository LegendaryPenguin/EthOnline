/**
 * The labelling rules and the statistics, on constructed cases.
 *
 * These are the parts of Phase 6 that decide what counts as an event and what counts
 * as a win, so they are the parts where a subtle error would produce a plausible
 * headline number instead of a failure. Tested with no gateway, so the arithmetic is
 * checked against cases whose answers are known by hand.
 */

import { describe, expect, it } from "vitest";
import {
  auc,
  bucketLiquidations,
  calibrateThreshold,
  detectCascades,
  quantile,
  quietHours,
  rocCurve,
  signTest,
  type CascadeRules,
} from "../cascades";
import type { LiquidationEvent } from "../replay";

// Fixtures below default to $1,000 an event, so a 4-account episode clears $2,500.
const RULES: CascadeRules = { minAccounts: 4, minProtocols: 2, maxGapHours: 2, minUsd: 2_500 };

let seq = 0;
function ev(
  hour: number,
  account: string,
  protocol: string,
  amountUsd = 1_000,
): LiquidationEvent {
  seq += 1;
  return {
    id: `e${seq}`,
    protocol,
    hash: `0x${seq}`,
    // Mid-hour, so a bucket boundary error shows up as a shifted hour rather than
    // hiding at the edge.
    timestamp: hour * 3600 + 1800,
    blockNumber: 1_000_000 + hour * 300,
    amountUsd,
    profitUsd: 0,
    liquidatee: account,
    marketName: "m",
    assetSymbol: "WETH",
  } as LiquidationEvent;
}

describe("bucketLiquidations", () => {
  it("counts distinct accounts and protocols, not rows", () => {
    const b = bucketLiquidations([
      ev(10, "0xa", "aave-v3-eth"),
      ev(10, "0xa", "aave-v3-eth"),
      ev(10, "0xb", "compound-v3-eth"),
    ]);
    const bucket = b.get(10)!;
    expect(bucket.rows).toBe(3);
    expect(bucket.accounts.size).toBe(2);
    expect(bucket.protocols.size).toBe(2);
    expect(bucket.usd).toBe(3_000);
  });
});

describe("detectCascades", () => {
  it("rejects a single large account", () => {
    // The case that motivates breadth over volume: one whale, one protocol, big number.
    const events = [1, 2, 3].map((i) => ev(10, "0xwhale", "aave-v3-eth", 500_000 * i));
    expect(detectCascades(bucketLiquidations(events), RULES)).toEqual([]);
  });

  it("rejects breadth confined to one protocol", () => {
    const events = ["0xa", "0xb", "0xc", "0xd", "0xe"].map((a) => ev(10, a, "aave-v3-eth"));
    expect(detectCascades(bucketLiquidations(events), RULES)).toEqual([]);
  });

  it("accepts many accounts across protocols", () => {
    const events = [
      ev(10, "0xa", "aave-v3-eth"),
      ev(10, "0xb", "aave-v3-eth"),
      ev(10, "0xc", "compound-v3-eth"),
      ev(10, "0xd", "compound-v3-eth"),
    ];
    const [episode] = detectCascades(bucketLiquidations(events), RULES);
    expect(episode.accounts).toBe(4);
    expect(episode.protocols).toEqual(["aave-v3-eth", "compound-v3-eth"]);
    expect(episode.startBlock).toBe(1_000_000 + 10 * 300);
  });

  it("bridges a tolerated gap into one episode rather than three fragments", () => {
    // Two accounts an hour, three waves two hours apart: individually below the rule,
    // together one event. Splitting these would report three non-cascades and lose
    // the real one.
    const events = [
      ev(10, "0xa", "aave-v3-eth"),
      ev(10, "0xb", "compound-v3-eth"),
      ev(12, "0xc", "aave-v3-eth"),
      ev(14, "0xd", "compound-v3-eth"),
    ];
    const found = detectCascades(bucketLiquidations(events), RULES);
    expect(found).toHaveLength(1);
    expect(found[0].startHour).toBe(10);
    expect(found[0].endHour).toBe(14);
  });

  it("splits across a gap wider than the tolerance", () => {
    const events = [
      ev(10, "0xa", "aave-v3-eth"),
      ev(10, "0xb", "compound-v3-eth"),
      ev(10, "0xc", "aave-v3-eth"),
      ev(10, "0xd", "compound-v3-eth"),
      ev(100, "0xe", "aave-v3-eth"),
      ev(100, "0xf", "compound-v3-eth"),
      ev(100, "0xg", "aave-v3-eth"),
      ev(100, "0xh", "compound-v3-eth"),
    ];
    expect(detectCascades(bucketLiquidations(events), RULES)).toHaveLength(2);
  });

  it("rejects wide dust", () => {
    // The case the first live run exposed: 8 accounts across 2 protocols liquidating
    // $4 total. Breadth is satisfied and it is not a cascade — it is a bot sweeping
    // dust, and a year of live data contains hundreds of them.
    const events = ["0xa", "0xb", "0xc", "0xd", "0xe", "0xf", "0xg", "0xh"].map((a, i) =>
      ev(10, a, i % 2 === 0 ? "aave-v3-eth" : "compound-v2-eth", 0.5),
    );
    expect(detectCascades(bucketLiquidations(events), RULES)).toEqual([]);
    // …and it is admitted the moment the size floor is removed, which is what makes
    // the floor load-bearing rather than decorative.
    expect(detectCascades(bucketLiquidations(events), { ...RULES, minUsd: 0 })).toHaveLength(1);
  });

  it("names episodes by their starting hour in UTC", () => {
    const events = [
      ev(0, "0xa", "aave-v3-eth"),
      ev(0, "0xb", "compound-v3-eth"),
      ev(0, "0xc", "aave-v3-eth"),
      ev(0, "0xd", "compound-v3-eth"),
    ];
    expect(detectCascades(bucketLiquidations(events), RULES)[0].id).toBe("1970-01-01T00:00Z");
  });
});

describe("quietHours", () => {
  const events = [
    ev(100, "0xa", "aave-v3-eth"),
    ev(100, "0xb", "compound-v3-eth"),
    ev(100, "0xc", "aave-v3-eth"),
    ev(100, "0xd", "compound-v3-eth"),
  ];
  const buckets = bucketLiquidations(events);
  const episodes = detectCascades(buckets, RULES);

  it("keeps its distance from the episode it would otherwise flatter", () => {
    // A negative sampled just before an episode turns a correct early warning into a
    // false positive, which inflates the baseline and deflates the signal.
    const quiet = quietHours(
      buckets,
      episodes,
      { firstHour: 0, lastHour: 300 },
      { count: 50, separationHours: 36, rules: RULES },
    );
    expect(quiet.length).toBeGreaterThan(0);
    for (const h of quiet) expect(Math.abs(h - 100)).toBeGreaterThan(36);
  });

  it("never returns an hour that is itself episode-grade, even with no separation", () => {
    // A negative that is an unlabelled positive is the worst single error available
    // here: it penalises a correct warning and rewards a blind signal.
    const quiet = quietHours(
      buckets,
      [],
      { firstHour: 0, lastHour: 300 },
      { count: 50, separationHours: 0, rules: RULES },
    );
    expect(quiet).not.toContain(100);
  });

  it("does admit an ordinary active hour", () => {
    // The rule deliberately is not "no liquidations at all": individual liquidations
    // are the background state of a lending market, and requiring their absence left
    // 5 usable negatives out of 8,700 hours on live data.
    const withBackground = bucketLiquidations([...events, ev(200, "0xz", "aave-v3-eth")]);
    const quiet = quietHours(
      withBackground,
      episodes,
      { firstHour: 0, lastHour: 300 },
      { count: 200, separationHours: 36, rules: RULES },
    );
    expect(quiet).toContain(200);
  });

  it("spreads the requested count across the range instead of clustering", () => {
    const quiet = quietHours(
      buckets,
      episodes,
      { firstHour: 0, lastHour: 300 },
      { count: 4, separationHours: 36, rules: RULES },
    );
    expect(quiet).toHaveLength(4);
    expect([...quiet].sort((a, b) => a - b)).toEqual(quiet);
    expect(new Set(quiet).size).toBe(4);
  });
});

describe("auc", () => {
  it("is 1 for perfect separation and 0 for perfect inversion", () => {
    expect(auc([
      { score: 10, positive: true },
      { score: 9, positive: true },
      { score: 1, positive: false },
    ])).toBe(1);
    expect(auc([
      { score: 1, positive: true },
      { score: 10, positive: false },
    ])).toBe(0);
  });

  it("counts a tie as half a win", () => {
    // The case a curve drawn through observed thresholds gets wrong.
    expect(auc([
      { score: 5, positive: true },
      { score: 5, positive: false },
    ])).toBe(0.5);
  });

  it("is null rather than 0.5 when a class is empty", () => {
    // 0.5 would be indistinguishable from a real coin flip, and this is the headline.
    expect(auc([{ score: 1, positive: true }])).toBeNull();
    expect(auc([])).toBeNull();
  });

  it("agrees with a hand-computed mixed case", () => {
    // positives {3, 1}; negatives {2, 0}. Wins: 3>2, 3>0, 1>0. Losses: 1<2. 3/4.
    expect(auc([
      { score: 3, positive: true },
      { score: 1, positive: true },
      { score: 2, positive: false },
      { score: 0, positive: false },
    ])).toBe(0.75);
  });
});

describe("rocCurve", () => {
  it("uses >= at each observed score and reaches the top-right corner", () => {
    const points = rocCurve([
      { score: 10, positive: true },
      { score: 5, positive: false },
    ]);
    expect(points[0]).toMatchObject({ threshold: 10, tp: 1, fp: 0, tpr: 1, fpr: 0 });
    expect(points[points.length - 1]).toMatchObject({ tpr: 1, fpr: 1 });
  });

  it("is empty when one class is missing", () => {
    expect(rocCurve([{ score: 1, positive: true }])).toEqual([]);
  });
});

describe("quantile", () => {
  it("interpolates between neighbours", () => {
    expect(quantile([0, 10], 0.5)).toBe(5);
    expect(quantile([0, 10, 20, 30], 0.5)).toBe(15);
  });

  it("does not care about input order", () => {
    expect(quantile([30, 0, 20, 10], 0.5)).toBe(15);
  });

  it("throws on no observations rather than returning a score-shaped zero", () => {
    expect(() => quantile([], 0.5)).toThrow(/no observations/);
  });

  it("rejects a p outside [0,1]", () => {
    expect(() => quantile([1, 2], 1.5)).toThrow(/out of range/);
  });
});

describe("signTest", () => {
  it("counts only the direction, not the magnitude", () => {
    // The reason to pair: one enormous difference must not outvote three small ones,
    // because the level this is differencing drifts by more than any event moves it.
    expect(signTest([1000, -1, -1, -1]).wins).toBe(1);
    expect(signTest([1000, -1, -1, -1]).n).toBe(4);
  });

  it("drops ties rather than splitting them", () => {
    const r = signTest([1, 0, 0, -1]);
    expect(r.n).toBe(2);
    expect(r.ties).toBe(2);
    expect(r.winRate).toBe(0.5);
  });

  it("gives an exact two-sided binomial p", () => {
    // 4 of 4: 2 * (1/16) = 0.125. The number that shows this design cannot reach
    // significance at n = 4, which is why the report states its own power.
    expect(signTest([1, 1, 1, 1]).pValue).toBeCloseTo(0.125, 6);
    // 5 of 5: 2 * (1/32).
    expect(signTest([1, 1, 1, 1, 1]).pValue).toBeCloseTo(0.0625, 6);
    // 3 of 4: 2 * (4 + 1)/16.
    expect(signTest([1, 1, 1, -1]).pValue).toBeCloseTo(0.625, 6);
    // A coin flip must not look like evidence.
    expect(signTest([1, -1]).pValue).toBe(1);
  });

  it("is symmetric under negation", () => {
    expect(signTest([1, 1, -1]).pValue).toBe(signTest([-1, -1, 1]).pValue);
  });

  it("reports no evidence rather than a p of 0 when nothing is paired", () => {
    expect(signTest([]).pValue).toBe(1);
    expect(signTest([0, 0]).n).toBe(0);
  });
});

describe("calibrateThreshold", () => {
  it("sits above the bulk of the quiet windows", () => {
    const quiet = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const t = calibrateThreshold(quiet, 0.9);
    expect(t).toBeGreaterThan(quantile(quiet, 0.5));
    expect(quiet.filter((q) => q >= t)).toHaveLength(1);
  });
});
