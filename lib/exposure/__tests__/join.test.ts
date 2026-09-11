import { describe, expect, it } from "vitest";
import { buildExposure, coverageReport, joinByAccount } from "../join";
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
