/**
 * Property tests for the cascade.
 *
 * These are written against the three bugs the first working run of the model
 * shipped with, because each one was visible in the output and none of them was
 * caught by anything: a 0% shock liquidating $680M, total liquidation falling as
 * the shock rose, and more depth producing more distress. A property test is the
 * only kind that would have failed on all three, since every individual number
 * looked plausible.
 *
 * The positions here are constructed rather than fetched. That is not mock data
 * standing in for the real thing — `npm run cascade` runs the same functions over
 * the live snapshot and is the only source of any published figure. These exist to
 * pin down behaviour at boundaries the live data does not happen to contain.
 */

import { describe, expect, it } from "vitest";
import type { Position } from "../../exposure/types";
import type { AssetLiquidity } from "../../graph/dex";
import type { AssetBeta } from "../factors";
import type { MarketParams } from "../inputs";
import type { EmodeMode } from "../emode";
import { clearableVolume, simulateCascade } from "../simulate";
import { executionPriceRatio } from "../impact";

const ETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WSTETH = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const MODES: EmodeMode[] = ["off", "inferred", "calibrated"];

function beta(assetId: string, symbol: string, betaEth: number, r2 = 0.95): AssetBeta {
  return {
    assetId,
    symbol,
    betaEth,
    betaBtc: 0,
    r2,
    observations: 364,
    volatility: 0.03,
    confidence: "measured",
    reason: "constructed for test",
  };
}

const betas = new Map<string, AssetBeta>([
  [ETH, beta(ETH, "WETH", 1)],
  [WSTETH, beta(WSTETH, "wstETH", 1.02)],
  [USDC, beta(USDC, "USDC", 0, 0.01)],
]);

const prices = new Map([
  [ETH, 2_000],
  [WSTETH, 2_400],
  [USDC, 1],
]);

function liquidity(reserves: Record<string, number>): Map<string, AssetLiquidity> {
  return new Map(
    Object.entries(reserves).map(([assetId, reserveTokens]) => [
      assetId,
      {
        assetId,
        symbol: assetId.slice(0, 6),
        reserveTokens,
        reserveUsd: reserveTokens * (prices.get(assetId) ?? 0),
        pools: [],
      } as AssetLiquidity,
    ]),
  );
}

let seq = 0;
function position(
  account: string,
  protocol: string,
  side: Position["side"],
  assetId: string,
  amount: number,
  liquidationThreshold: number,
): Position {
  return {
    id: `p${seq++}`,
    protocol,
    account,
    side,
    assetId,
    assetSymbol: assetId.slice(0, 6),
    amount,
    valueUsd: amount * (prices.get(assetId) ?? 0),
    liquidationThreshold,
    maximumLtv: liquidationThreshold - 0.05,
    marketId: `${protocol}-${assetId}`,
  };
}

/** One healthy book and one that is exactly at its boundary before any shock. */
function book(account: string, collateralEth: number, debtUsdc: number, threshold = 0.8) {
  return [
    position(account, "aave-v3-eth", "COLLATERAL", ETH, collateralEth, threshold),
    position(account, "aave-v3-eth", "BORROWER", USDC, debtUsdc, 0),
  ];
}

const marketParams = new Map<string, MarketParams>([
  [`aave-v3-eth-${ETH}`, { liquidationThreshold: 0.8, liquidationPenalty: 5 }],
  [`aave-v3-eth-${WSTETH}`, { liquidationThreshold: 0.79, liquidationPenalty: 6 }],
  [`aave-v3-eth-${USDC}`, { liquidationThreshold: 0.87, liquidationPenalty: 5 }],
  [`compound-v3-eth-${ETH}`, { liquidationThreshold: 0.83, liquidationPenalty: 7 }],
  [`compound-v3-eth-${USDC}`, { liquidationThreshold: 0.9, liquidationPenalty: 7 }],
]);

function run(positions: Position[], shock: number, opts: Partial<Parameters<typeof simulateCascade>[0]> = {}) {
  return simulateCascade({
    positions,
    prices,
    betas,
    liquidity: liquidity({ [ETH]: 50_000, [WSTETH]: 10_000 }),
    marketParams,
    shocks: { ETH: shock, BTC: 0 },
    ...opts,
  });
}

describe("zero shock liquidates nothing", () => {
  // The bug this pins: contradicted books were liquidated rather than excluded,
  // so a 0% shock reported $680,695,224 of liquidations. Every account in this
  // fixture is deliberately solvent, insolvent, or exactly marginal.
  const positions = [
    ...book("0xhealthy", 100, 50_000), // HF 3.2
    ...book("0xmarginal", 100, 160_000), // HF exactly 1.0
    ...book("0xcontradicted", 100, 200_000), // HF 0.8: impossible on a live chain
  ];

  for (const emode of MODES) {
    it(`liquidates $0 at a 0% shock under emode=${emode}`, () => {
      const r = run(positions, 0, { emode });
      expect(r.totalLiquidatedDebtUsd).toBe(0);
      expect(r.rounds).toHaveLength(0);
      expect(r.converged).toBe(true);
    });
  }

  it("excludes the contradicted book and reports its debt rather than dropping it", () => {
    const r = run(positions, 0, { emode: "off" });
    expect(r.excludedContradictedBooks).toBe(1);
    expect(r.excludedContradictedDebtUsd).toBeCloseTo(200_000, 6);
  });

  it("keeps a book that is exactly marginal, since it is not a contradiction", () => {
    // HF of exactly 1.0 is solvent. Excluding it would quietly discard the
    // accounts the model most needs, which is the failure mode of over-correcting
    // for the contradicted ones.
    const r = run(book("0xmarginal", 100, 160_000), 0.0001, { emode: "off" });
    expect(r.excludedContradictedBooks).toBe(0);
    expect(r.totalLiquidatedDebtUsd).toBeGreaterThan(0);
  });
});

describe("distress is monotone in the shock", () => {
  // The bug this pins: liquidated volume fell as the shock rose. It is asserted on
  // snapshot-priced distressed debt because liquidated USD legitimately is not
  // monotone — a bigger shock shrinks the dollars the same collateral is worth.
  const positions = [
    ...book("0xa", 100, 120_000),
    ...book("0xb", 100, 140_000),
    ...book("0xc", 100, 150_000),
    ...book("0xd", 1_000, 1_000_000),
  ];

  for (const emode of MODES) {
    it(`never distresses less debt at a larger shock under emode=${emode}`, () => {
      let previous = -1;
      for (const shock of [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5]) {
        const r = run(positions, shock, { emode });
        expect(r.distressedDebtUsd).toBeGreaterThanOrEqual(previous);
        previous = r.distressedDebtUsd;
      }
    });
  }
});

describe("more depth is never worse", () => {
  // The bug this pins: 2x depth produced more total liquidation than 1x, which is
  // impossible. Deeper markets must let more of the same distress clear.
  const positions = [
    ...book("0xa", 5_000, 7_500_000),
    ...book("0xb", 5_000, 7_600_000),
  ];

  it("clears more and strands less as depth grows, with distress unchanged", () => {
    const results = [0.25, 0.5, 1, 2, 4].map((dm) =>
      run(positions, 0.2, { depthMultiplier: dm, emode: "calibrated" }),
    );
    for (let i = 1; i < results.length; i++) {
      expect(results[i].totalLiquidatedDebtUsd).toBeGreaterThanOrEqual(
        results[i - 1].totalLiquidatedDebtUsd - 1,
      );
      expect(results[i].distressedDebtUsd).toBeCloseTo(results[0].distressedDebtUsd, 6);
    }
  });
});

describe("the slippage cap", () => {
  it("clearableVolume is exactly the sale that exhausts the tolerance", () => {
    for (const tolerance of [0.02, 0.05, 0.08, 0.15]) {
      const volume = clearableVolume(1_000, tolerance);
      expect(1 - executionPriceRatio(volume, 1_000)).toBeCloseTo(tolerance, 12);
    }
  });

  it("grinds the price down instead of collapsing it in one round", () => {
    // $12M of collateral against 100 ETH of depth: the pathological ratio that
    // reported a 99.99% price collapse before the cap existed. wstETH on mainnet
    // is this case at 106x.
    const options = {
      liquidity: liquidity({ [ETH]: 100 }),
      emode: "calibrated" as EmodeMode,
    };
    const positions = book("0xwhale", 6_000, 9_600_000);

    // One round can only move the price by about the liquidation bonus, because
    // that is all the slippage a liquidator is paid to absorb.
    const first = run(positions, 0.3, { ...options, maxRounds: 1 });
    expect(1 - first.impactOnlyRatio[ETH]).toBeLessThan(0.2);

    // Across every round it can go much further, but never below the constant-
    // product floor of selling the entire reserve: (R/2R)^2 = 0.25. Reaching that
    // floor requires depth that never regenerates, which no real market has, so
    // the cumulative figure is a worst case and the per-round one is the honest
    // description of any single wave.
    const all = run(positions, 0.3, options);
    expect(all.impactOnlyRatio[ETH]).toBeGreaterThan(0.25);
    expect(all.impactOnlyRatio[ETH]).toBeLessThan(first.impactOnlyRatio[ETH]);
    expect(all.unliquidatableDebtUsd).toBeGreaterThan(0);
    expect(all.strandedCollateralUsd).toBeGreaterThan(0);
  });

  it("strands everything when an asset has no measured depth at all", () => {
    // rsETH is this case on mainnet: real liquidity, all of it on a venue that
    // publishes no standardized deployment. Selling it at book value would
    // finance the cascade out of liquidity never shown to exist.
    const r = run(book("0xwhale", 6_000, 9_600_000), 0.3, {
      liquidity: new Map(),
      emode: "calibrated",
    });
    expect(r.totalLiquidatedDebtUsd).toBe(0);
    expect(r.unliquidatableDebtUsd).toBeGreaterThan(0);
    expect(r.impactOnlyRatio[ETH]).toBe(1);
  });
});

describe("the result is a pure function of its inputs", () => {
  const positions = [
    ...book("0xa", 100, 150_000),
    ...book("0xb", 200, 300_000),
    ...book("0xc", 50, 78_000),
  ];

  it("is deterministic", () => {
    const a = run(positions, 0.2, { emode: "calibrated" });
    const b = run(positions, 0.2, { emode: "calibrated" });
    expect(b.totalLiquidatedDebtUsd).toBe(a.totalLiquidatedDebtUsd);
    expect(b.rounds.length).toBe(a.rounds.length);
  });

  it("does not depend on the order positions arrive in", () => {
    // Round-level concurrency exists precisely so that whichever book happens to
    // be first in the array does not get the whole of the depth.
    const forward = run(positions, 0.2, { emode: "calibrated" });
    const reversed = run([...positions].reverse(), 0.2, { emode: "calibrated" });
    expect(reversed.totalLiquidatedDebtUsd).toBeCloseTo(forward.totalLiquidatedDebtUsd, 4);
    expect(reversed.unliquidatableDebtUsd).toBeCloseTo(forward.unliquidatableDebtUsd, 4);
  });
});

describe("conservation", () => {
  const positions = [...book("0xa", 100, 150_000), ...book("0xb", 5_000, 7_800_000)];

  it("never liquidates more debt than exists", () => {
    for (const shock of [0.05, 0.2, 0.5]) {
      const r = run(positions, shock, { emode: "calibrated" });
      expect(r.totalLiquidatedDebtUsd).toBeLessThanOrEqual(r.totalDebtUsd + 1);
    }
  });

  it("splits liquidation into round one and the rest with no double counting", () => {
    const r = run(positions, 0.3, { emode: "calibrated" });
    const summed = r.rounds.reduce((s, x) => s + x.liquidatedDebtUsd, 0);
    expect(r.totalLiquidatedDebtUsd).toBeCloseTo(summed, 4);
    expect(r.idiosyncraticDebtUsd + r.systemicDebtUsd).toBeCloseTo(summed, 4);
  });

  it("converges rather than hitting the round cap", () => {
    const r = run(positions, 0.3, { emode: "calibrated" });
    expect(r.converged).toBe(true);
  });
});

describe("cross-protocol contagion is the mechanism, not an artefact", () => {
  it("a shock confined to one protocol's collateral reaches the other", () => {
    // Two accounts with nothing in common but the asset securing them. Aave's
    // borrower is pushed over by the shock; its forced selling is what moves
    // Compound's borrower, and there is no shared address anywhere.
    const positions = [
      position("0xaave", "aave-v3-eth", "COLLATERAL", ETH, 5_000, 0.8),
      position("0xaave", "aave-v3-eth", "BORROWER", USDC, 7_900_000, 0),
      position("0xcomp", "compound-v3-eth", "COLLATERAL", ETH, 5_000, 0.83),
      position("0xcomp", "compound-v3-eth", "BORROWER", USDC, 8_260_000, 0),
    ];
    const r = run(positions, 0.02, { liquidity: liquidity({ [ETH]: 3_000 }) });
    expect(Object.keys(r.rounds[0].byProtocol)).toContain("aave-v3-eth");
    expect(r.rounds.length).toBeGreaterThan(1);
    expect(r.systemicDebtUsd).toBeGreaterThan(0);
  });
});

describe("unmeasured assets are excluded rather than assumed", () => {
  it("does not shock collateral whose beta was never measured", () => {
    const unknown = "0x1111111111111111111111111111111111111111";
    prices.set(unknown, 100);
    const positions = [
      position("0xa", "aave-v3-eth", "COLLATERAL", unknown, 1_000, 0.8),
      position("0xa", "aave-v3-eth", "BORROWER", USDC, 70_000, 0),
    ];
    const r = run(positions, 0.9);
    expect(r.totalLiquidatedDebtUsd).toBe(0);
    expect(r.unmeasuredCollateralUsd).toBeCloseTo(100_000, 6);
    prices.delete(unknown);
  });
});
