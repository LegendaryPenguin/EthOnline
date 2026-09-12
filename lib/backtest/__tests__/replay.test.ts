/**
 * Tests for the backtest's scoring logic.
 *
 * The network parts are exercised by `npm run backtest` against live data, which is
 * the only source of any published figure. What is pinned here is everything that
 * decides *how* a replay is scored — the classification of a miss, the query surgery
 * that makes the historical read possible, and the re-pricing that separates a
 * misread position from a price that had not been published yet. A silent fault in
 * any of those changes the published recall without failing anything.
 */

import { describe, expect, it } from "vitest";
import {
  accountPositionsAtBlockQuery,
  classify,
  marketsAtBlockQuery,
  repriceVerdict,
  STALE_MARGIN,
  verdict,
} from "../replay";
import type { Position } from "../../exposure/types";

const ETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

let seq = 0;
function position(
  side: Position["side"],
  assetId: string,
  amount: number,
  price: number,
  liquidationThreshold: number,
): Position {
  return {
    id: `b${seq++}`,
    protocol: "aave-v3-eth",
    account: "0xa",
    side,
    assetId,
    assetSymbol: assetId.slice(0, 6),
    amount,
    valueUsd: amount * price,
    liquidationThreshold,
    maximumLtv: Math.max(0, liquidationThreshold - 0.05),
    marketId: `aave-v3-eth-${assetId}`,
  };
}

describe("the historical queries", () => {
  it("asks for the block on both the markets and the positions query", () => {
    // Without this the query silently returns head state, and the backtest would
    // score the engine against prices from after the liquidation it is replaying.
    expect(marketsAtBlockQuery()).toContain("block: { number: $block }");
    expect(marketsAtBlockQuery()).toContain("query MarketsAt($block: Int!)");
    expect(accountPositionsAtBlockQuery("3.1.0")).toContain("block: { number: $block }");
  });

  it("keeps the 2.x asset-field concession", () => {
    // Position.asset arrived in 3.x and Compound V2 is live on 2.0.1, so requesting
    // it unconditionally makes the query invalid on a third of the deployments.
    expect(accountPositionsAtBlockQuery("3.1.0")).toContain("asset { id symbol decimals }");
    expect(accountPositionsAtBlockQuery("2.0.1")).not.toContain("asset { id symbol decimals }");
  });

  it("filters to one account rather than a batch", () => {
    // The block is what varies per call here, not the account set. Reusing the
    // batched live query would page a hundred accounts through one historical block.
    expect(accountPositionsAtBlockQuery("3.1.0")).toContain("account: $account");
    expect(accountPositionsAtBlockQuery("3.1.0")).not.toContain("account_in");
  });
});

describe("verdict", () => {
  it("weights collateral by its liquidation threshold", () => {
    const v = verdict([
      position("COLLATERAL", ETH, 100, 2_000, 0.8),
      position("BORROWER", USDC, 100_000, 1, 0),
    ]);
    expect(v.collateralUsd).toBeCloseTo(200_000, 6);
    expect(v.weightedCollateralUsd).toBeCloseTo(160_000, 6);
    expect(v.healthFactor).toBeCloseTo(1.6, 12);
  });

  it("segregates collateral with no published threshold instead of assuming one", () => {
    // toFraction returns 0 for a missing threshold, and treating that as 0 would
    // report a solvent book as insolvent while treating it as 1 would do the
    // reverse. It is quarantined so `classify` can decline the verdict.
    const v = verdict([
      position("COLLATERAL", ETH, 100, 2_000, 0),
      position("BORROWER", USDC, 100_000, 1, 0),
    ]);
    expect(v.unknownThresholdUsd).toBeCloseTo(200_000, 6);
    expect(v.weightedCollateralUsd).toBe(0);
  });

  it("has an infinite health factor with no debt, not a division by zero", () => {
    expect(verdict([position("COLLATERAL", ETH, 1, 2_000, 0.8)]).healthFactor).toBe(Infinity);
  });
});

describe("classify", () => {
  const debt = (usd: number) => position("BORROWER", USDC, usd, 1, 0);
  const coll = (usd: number, lt = 0.8) => position("COLLATERAL", USDC, usd, 1, lt);

  it("flags a book below its boundary", () => {
    expect(classify(verdict([coll(100_000), debt(90_000)]))).toBe("flagged");
  });

  it("does not flag a book at exactly 1", () => {
    // HF of exactly 1 is solvent. Aave liquidates strictly below it, so flagging
    // here would be a false positive against the protocol's own rule.
    const v = verdict([coll(100_000), debt(80_000)]);
    expect(v.healthFactor).toBe(1);
    expect(classify(v)).not.toBe("flagged");
  });

  it("separates a near-miss from a real one at the stale-balance margin", () => {
    // The split is what makes the miss analysis mean anything: one is a small
    // one-directional offset, the other is the engine being wrong.
    const near = verdict([coll(100_000), debt(80_000 / (STALE_MARGIN - 0.01))]);
    expect(classify(near)).toBe("stale-balance");
    const far = verdict([coll(100_000), debt(40_000)]);
    expect(classify(far)).toBe("solvent");
  });

  it("declines rather than guessing when a threshold is missing", () => {
    // Checked before the stale/solvent split, because a book whose boundary is
    // partly uncomputable has not been evaluated at all.
    expect(classify(verdict([coll(100_000, 0), debt(50_000)]))).toBe("unknown-threshold");
  });

  it("reports no debt and no positions as distinct causes", () => {
    expect(classify(verdict([coll(100_000)]))).toBe("no-debt");
    expect(classify(verdict([]))).toBe("no-positions");
  });
});

describe("repriceVerdict", () => {
  const positions = [
    position("COLLATERAL", ETH, 100, 2_000, 0.8),
    position("BORROWER", USDC, 150_000, 1, 0),
  ];

  it("re-values from token amounts, not from the stored USD figure", () => {
    // Scaling valueUsd would compound the old price into the new one. The whole
    // diagnostic depends on the amount being the thing that is fixed and the price
    // being the thing that moved.
    const same = repriceVerdict(positions, new Map([[ETH, 2_000], [USDC, 1]]));
    expect(same.healthFactor).toBeCloseTo(verdict(positions).healthFactor, 12);
  });

  it("crosses the boundary when the price move alone is enough", () => {
    // 1.067 before, below 1 after: the signature of a liquidation triggered by the
    // oracle update in its own block, which no read at block-1 could have caught.
    expect(verdict(positions).healthFactor).toBeGreaterThan(1);
    const after = repriceVerdict(positions, new Map([[ETH, 1_800], [USDC, 1]]));
    expect(after.healthFactor).toBeLessThan(1);
  });

  it("treats an asset the new price set does not cover as worthless rather than stale", () => {
    // Carrying the old price forward would silently mix two blocks' oracles in one
    // health factor. Dropping to zero is visible in the result instead.
    const after = repriceVerdict(positions, new Map([[USDC, 1]]));
    expect(after.collateralUsd).toBe(0);
    expect(after.healthFactor).toBe(0);
  });
});
