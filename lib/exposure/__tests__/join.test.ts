import { describe, expect, it } from "vitest";
import { buildExposure, correlatedFloor, coverageReport, joinByAccount } from "../join";
import type { Position } from "../types";

const pos = (over: Partial<Position> = {}): Position => ({
  id: Math.random().toString(36),
  protocol: "aave-v3-eth",
  account: "0xabc",
  side: "COLLATERAL",
  assetId: "0xweth",
  assetSymbol: "WETH",
  amount: 1,
  valueUsd: 1000,
  liquidationThreshold: 0.8,
  maximumLtv: 0.75,
  marketId: "0xmarket",
  ...over,
});

describe("joinByAccount", () => {
  it("groups positions across protocols by address", () => {
    // The primary-key join that no single lending protocol can perform.
    const exposures = joinByAccount([
      pos({ account: "0xa", protocol: "aave-v3-eth" }),
      pos({ account: "0xa", protocol: "compound-v3-eth" }),
      pos({ account: "0xb", protocol: "aave-v3-eth" }),
    ]);

    expect(exposures.size).toBe(2);
    expect(exposures.get("0xa")!.protocols).toEqual(["aave-v3-eth", "compound-v3-eth"]);
    expect(exposures.get("0xb")!.protocols).toEqual(["aave-v3-eth"]);
  });
});

describe("buildExposure", () => {
  it("keeps protocols separate, because liquidation is per-protocol", () => {
    const e = buildExposure("0xa", [
      pos({ protocol: "aave-v3-eth", valueUsd: 1000, liquidationThreshold: 0.8 }),
      pos({ protocol: "aave-v3-eth", side: "BORROWER", valueUsd: 400 }),
      pos({ protocol: "compound-v3-eth", valueUsd: 500, liquidationThreshold: 0.9 }),
      pos({ protocol: "compound-v3-eth", side: "BORROWER", valueUsd: 450 }),
    ]);

    expect(e.byProtocol["aave-v3-eth"].healthFactor).toBeCloseTo(800 / 400);
    expect(e.byProtocol["compound-v3-eth"].healthFactor).toBeCloseTo(450 / 450);
    expect(e.collateralUsd).toBe(1500);
    expect(e.debtUsd).toBe(850);
  });

  it("computes the aggregate as a leverage ratio, not a liquidation predictor", () => {
    // No protocol can liquidate against another's collateral, so this number
    // must never be read as a liquidation signal.
    const e = buildExposure("0xa", [
      pos({ protocol: "p1", valueUsd: 1000, liquidationThreshold: 0.8 }),
      pos({ protocol: "p2", side: "BORROWER", valueUsd: 400 }),
    ]);
    expect(e.aggregateLeverageRatio).toBeCloseTo(800 / 400);
    // Yet p2 alone is completely unbacked.
    expect(e.byProtocol["p2"].healthFactor).toBe(0);
  });

  it("excludes unknown-threshold collateral from the boundary and flags it", () => {
    // Counting it would invent a threshold; ignoring it silently would hide the
    // gap. It is excluded and reported.
    const e = buildExposure("0xa", [
      pos({ valueUsd: 1000, liquidationThreshold: 0 }),
      pos({ valueUsd: 1000, liquidationThreshold: 0.8 }),
      pos({ side: "BORROWER", valueUsd: 500 }),
    ]);
    expect(e.weightedCollateralUsd).toBeCloseTo(800);
    expect(e.unknownThresholdUsd).toBe(1000);
    expect(e.confidence).toBe("incomplete");
  });

  it("marks a health factor below 1 as contradicted", () => {
    // A live, un-liquidated account with HF < 1 means our parameters are wrong,
    // not that the borrower is unsafe. Liquidation is profitable and bots are
    // fast. In practice this is Aave V3 E-Mode, absent from the schema.
    const e = buildExposure("0xa", [
      pos({ valueUsd: 1000, liquidationThreshold: 0.8 }),
      pos({ side: "BORROWER", valueUsd: 900 }),
    ]);
    expect(e.byProtocol["aave-v3-eth"].healthFactor).toBeLessThan(1);
    expect(e.confidence).toBe("contradicted");
  });

  it("reports the weakest confidence across protocols", () => {
    const e = buildExposure("0xa", [
      pos({ protocol: "p1", valueUsd: 1000, liquidationThreshold: 0.8 }),
      pos({ protocol: "p1", side: "BORROWER", valueUsd: 100 }),
      pos({ protocol: "p2", valueUsd: 1000, liquidationThreshold: 0.8 }),
      pos({ protocol: "p2", side: "BORROWER", valueUsd: 900 }),
    ]);
    expect(e.byProtocol["p1"].confidence).toBe("ok");
    expect(e.byProtocol["p2"].confidence).toBe("contradicted");
    expect(e.confidence).toBe("contradicted");
  });

  it("treats a debt-free account as infinitely healthy", () => {
    const e = buildExposure("0xa", [pos({ valueUsd: 1000 })]);
    expect(e.aggregateLeverageRatio).toBe(Infinity);
  });
});

describe("health factor monotonicity", () => {
  // Properties that must hold for any correct risk measure. If these ever fail,
  // the engine is wrong regardless of what it reconciles against.
  const build = (collateral: number, debt: number, threshold = 0.8) =>
    buildExposure("0xa", [
      pos({ valueUsd: collateral, liquidationThreshold: threshold }),
      pos({ side: "BORROWER", valueUsd: debt }),
    ]).byProtocol["aave-v3-eth"].healthFactor;

  it("falls as debt rises", () => {
    let previous = Infinity;
    for (const debt of [100, 200, 400, 800, 1600]) {
      const hf = build(1000, debt);
      expect(hf).toBeLessThan(previous);
      previous = hf;
    }
  });

  it("rises as collateral rises", () => {
    let previous = 0;
    for (const collateral of [100, 200, 400, 800, 1600]) {
      const hf = build(collateral, 500);
      expect(hf).toBeGreaterThan(previous);
      previous = hf;
    }
  });

  it("rises as the liquidation threshold rises", () => {
    // The E-Mode finding in one property: a higher threshold is strictly safer,
    // which is why using the default understates safety.
    expect(build(1000, 900, 0.95)).toBeGreaterThan(build(1000, 900, 0.8));
  });

  it("is scale invariant", () => {
    // Doubling both sides changes nothing, so the measure is a true ratio.
    expect(build(2000, 1000)).toBeCloseTo(build(200, 100));
  });
});

describe("the E-Mode reconstruction", () => {
  // Aave V3 E-Mode is not in the Messari schema, and left uncorrected it made $3.9B
  // of the $5.7B of observed debt compute insolvent while alive on chain. These tests
  // pin the two properties that keep the correction from becoming a free upgrade:
  // it fires only on a contradiction, and only when the *whole* book is correlated.
  const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const WEETH = "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee";
  const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
  const emode = { threshold: 0.95, groups: [[WETH, WEETH]] };

  /** weETH collateral against WETH debt: exactly the live E-Mode shape. */
  const correlatedBook = (threshold: number) => [
    pos({ assetId: WEETH, valueUsd: 1000, liquidationThreshold: threshold }),
    pos({ assetId: WETH, side: "BORROWER", valueUsd: 900 }),
  ];

  it("lifts a contradicted correlated book to the elevated threshold", () => {
    // At 0.80 the boundary is $800 against $900 of debt — insolvent on paper, alive
    // on chain. At 0.95 it is $950, which is what the account's continued existence
    // says is true.
    const before = buildExposure("0xa", correlatedBook(0.8));
    expect(before.confidence).toBe("contradicted");

    const after = buildExposure("0xa", correlatedBook(0.8), emode);
    expect(after.confidence).not.toBe("contradicted");
    expect(after.byProtocol["aave-v3-eth"].emodeThreshold).toBe(0.95);
    expect(after.byProtocol["aave-v3-eth"].healthFactor).toBeCloseTo(950 / 900);
  });

  it("leaves a book that already computes solvent alone", () => {
    // A solvent book is no evidence that it is in E-Mode, so lifting its threshold
    // would flatter the signal for free.
    const e = buildExposure("0xa", correlatedBook(0.95), emode);
    expect(e.byProtocol["aave-v3-eth"].emodeThreshold).toBeNull();
  });

  it("refuses a book with an uncorrelated leg", () => {
    // Aave grants E-Mode to a position, not an asset. A WBTC leg disqualifies the
    // whole book, so nothing is claimed and it stays honestly contradicted.
    const e = buildExposure(
      "0xa",
      [
        pos({ assetId: WEETH, valueUsd: 1000, liquidationThreshold: 0.8 }),
        pos({ assetId: WBTC, valueUsd: 10, liquidationThreshold: 0.7 }),
        pos({ assetId: WETH, side: "BORROWER", valueUsd: 900 }),
      ],
      emode,
    );
    expect(e.confidence).toBe("contradicted");
    expect(e.byProtocol["aave-v3-eth"].emodeThreshold).toBeNull();
  });

  it("claims nothing when the lift does not resolve the contradiction", () => {
    // $950 of boundary against $2000 of debt is still insolvent, so E-Mode was not
    // the explanation and the book keeps its original numbers rather than a
    // half-applied inference.
    const e = buildExposure(
      "0xa",
      [
        pos({ assetId: WEETH, valueUsd: 1000, liquidationThreshold: 0.8 }),
        pos({ assetId: WETH, side: "BORROWER", valueUsd: 2000 }),
      ],
      emode,
    );
    expect(e.confidence).toBe("contradicted");
    expect(e.byProtocol["aave-v3-eth"].emodeThreshold).toBeNull();
    expect(e.byProtocol["aave-v3-eth"].healthFactor).toBeCloseTo(800 / 2000);
  });

  it("never lowers a published threshold", () => {
    // The floor is a lower bound, not a replacement. Compound's 0.98 base market
    // must not be dragged down to 0.95 by a correction meant to raise things.
    const e = buildExposure(
      "0xa",
      [
        pos({ assetId: WEETH, valueUsd: 1000, liquidationThreshold: 0.98 }),
        pos({ assetId: WETH, side: "BORROWER", valueUsd: 990 }),
      ],
      emode,
    );
    expect(e.byProtocol["aave-v3-eth"].healthFactor).toBeCloseTo(980 / 990);
  });

  it("applies per protocol, not across the account", () => {
    // Only the leg that is both contradicted and correlated is lifted; a separate
    // protocol's book is untouched, because thresholds are the protocol's own.
    const e = buildExposure(
      "0xa",
      [
        pos({ protocol: "aave-v3-eth", assetId: WEETH, valueUsd: 1000, liquidationThreshold: 0.8 }),
        pos({ protocol: "aave-v3-eth", assetId: WETH, side: "BORROWER", valueUsd: 900 }),
        pos({ protocol: "compound-v3-eth", assetId: WBTC, valueUsd: 100, liquidationThreshold: 0.7 }),
        pos({ protocol: "compound-v3-eth", assetId: WETH, side: "BORROWER", valueUsd: 50 }),
      ],
      emode,
    );
    expect(e.byProtocol["aave-v3-eth"].emodeThreshold).toBe(0.95);
    expect(e.byProtocol["compound-v3-eth"].emodeThreshold).toBeNull();
  });

  it("does not invent a threshold for collateral that reports none", () => {
    // E-Mode says a correlated pair is treated more leniently, not that an asset the
    // subgraph reports no threshold for is collateral at all. `correlatedFloor`
    // ignores such a leg, and `measureProtocol` must still exclude it.
    const e = buildExposure(
      "0xa",
      [
        pos({ assetId: WEETH, valueUsd: 1000, liquidationThreshold: 0 }),
        pos({ assetId: WETH, side: "BORROWER", valueUsd: 900 }),
      ],
      emode,
    );
    expect(e.byProtocol["aave-v3-eth"].weightedCollateralUsd).toBe(0);
    expect(e.byProtocol["aave-v3-eth"].unknownThresholdUsd).toBe(1000);
    expect(e.byProtocol["aave-v3-eth"].emodeThreshold).toBeNull();
  });

  it("does nothing when the policy carries no groups", () => {
    const e = buildExposure("0xa", correlatedBook(0.8), { threshold: 0.95, groups: [] });
    expect(e.confidence).toBe("contradicted");
    expect(e.byProtocol["aave-v3-eth"].emodeThreshold).toBeNull();
  });
});

describe("correlatedFloor", () => {
  const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const C = "0xcccccccccccccccccccccccccccccccccccccccc";
  const emode = { threshold: 0.9, groups: [[A, B]] };

  it("requires every leg to sit in one group", () => {
    expect(correlatedFloor([pos({ assetId: A }), pos({ assetId: B })], emode)).toBe(0.9);
    expect(correlatedFloor([pos({ assetId: A }), pos({ assetId: C })], emode)).toBe(0);
  });

  it("does not straddle two groups", () => {
    // A and C are each correlated with something, but not with each other, and
    // E-Mode is a property of the pair rather than of the assets separately.
    const D = "0xdddddddddddddddddddddddddddddddddddddddd";
    const two = { threshold: 0.9, groups: [[A, B], [C, D]] };
    expect(correlatedFloor([pos({ assetId: A }), pos({ assetId: C })], two)).toBe(0);
    expect(correlatedFloor([pos({ assetId: C }), pos({ assetId: D })], two)).toBe(0.9);
  });

  it("ignores worthless legs and unpriced collateral", () => {
    // A dust or unpriced leg is not evidence about the book's E-Mode status, and
    // treating it as disqualifying would throw away the correction on rounding.
    expect(
      correlatedFloor(
        [
          pos({ assetId: A }),
          pos({ assetId: B }),
          pos({ assetId: C, valueUsd: 0 }),
          pos({ assetId: C, liquidationThreshold: 0 }),
        ],
        emode,
      ),
    ).toBe(0.9);
  });

  it("returns 0 for a book with nothing in it", () => {
    expect(correlatedFloor([], emode)).toBe(0);
    expect(correlatedFloor([pos({ assetId: A, valueUsd: 0 })], emode)).toBe(0);
  });
});

describe("coverageReport", () => {
  const exposures = joinByAccount([
    // Levered on two protocols: a real contagion channel.
    pos({ account: "0xa", protocol: "p1", side: "BORROWER", valueUsd: 600 }),
    pos({ account: "0xa", protocol: "p2", side: "BORROWER", valueUsd: 400 }),
    // Present on two protocols but borrowing on one: not a contagion channel.
    pos({ account: "0xb", protocol: "p1", valueUsd: 100 }),
    pos({ account: "0xb", protocol: "p2", side: "BORROWER", valueUsd: 200 }),
    // Single protocol.
    pos({ account: "0xc", protocol: "p1", side: "BORROWER", valueUsd: 300 }),
  ]);

  it("counts only debt-bearing overlap as multi-protocol leverage", () => {
    const r = coverageReport(exposures, 1500);
    expect(r.accountsMultiProtocol).toBe(2);
    // 0xb supplies to one and borrows from the other, so it is excluded.
    expect(r.borrowersMultiProtocol).toBe(1);
    expect(r.multiProtocolDebtUsd).toBe(1000);
  });

  it("reports the share of sampled debt, not of reported debt", () => {
    // The denominator has to be what we actually measured; using reported debt
    // would understate the share by the sample's own incompleteness.
    const r = coverageReport(exposures, 3000);
    expect(r.sampledDebtUsd).toBe(1500);
    expect(r.multiProtocolDebtShareOfSample).toBeCloseTo(1000 / 1500);
    expect(r.sampleCoverageOfReported).toBeCloseTo(0.5);
  });

  it("records pair overlap and the protocol-count distribution", () => {
    const r = coverageReport(exposures, 1500);
    expect(r.pairOverlap["p1|p2"]).toBe(2);
    expect(r.protocolCountHistogram[2]).toBe(2);
    expect(r.protocolCountHistogram[1]).toBe(1);
  });

  it("breaks coverage down per protocol, since an aggregate hides a bad feed", () => {
    // Aave V2 passed every aggregate check while being wrong by 1925x.
    const r = coverageReport(exposures, 1500, { p1: { borrowUsd: 900 } });
    expect(r.perProtocol.p1.sampledDebtUsd).toBe(900);
    expect(r.perProtocol.p1.ratio).toBeCloseTo(1);
  });

  it("buckets borrowers by health-factor confidence", () => {
    const r = coverageReport(exposures, 1500);
    const total = (["ok", "incomplete", "contradicted"] as const).reduce(
      (s, k) => s + r.confidence[k].borrowers,
      0,
    );
    expect(total).toBe(3);
  });
});
