/**
 * Tests for the factor regression, the coupling matrix and the E-Mode inference.
 *
 * The regression tests matter more than they look. `ols2` replaced a price-band
 * heuristic that classified tokenised gold as an ETH derivative because XAUt
 * happened to trade at 1.73x ETH, so the closed-form solution below is load-bearing
 * for every shock the model applies. It is tested by constructing series with known
 * coefficients and checking they come back.
 */

import { describe, expect, it } from "vitest";
import {
  ANCHORS,
  type AssetBeta,
  logReturns,
  measureBetas,
  ols2,
  resolveReceiptBetas,
  stdev,
} from "../factors";
import { assertSymmetric, buildCouplingMatrix } from "../coupling";
import {
  classifyAsset,
  decideEmode,
  dominantFactor,
  EMODE_THRESHOLD,
  effectiveThresholds,
  tracksAnchor,
} from "../emode";
import { groupByAccountProtocol } from "../simulate";
import type { Position } from "../../exposure/types";
import type { PriceSeries } from "../../graph/history";

const ETH = ANCHORS.ETH;
const BTC = ANCHORS.BTC;
const DERIVATIVE = "0xdddddddddddddddddddddddddddddddddddddddd";
const STABLE = "0xssssssssssssssssssssssssssssssssssssssss";
/** Tokenised gold: low beta on both factors, fifty times a stablecoin's volatility. */
const GOLD = "0xgggggggggggggggggggggggggggggggggggggggg";

describe("ols2", () => {
  it("recovers coefficients it was built from", () => {
    const x1: number[] = [];
    const x2: number[] = [];
    const y: number[] = [];
    // Deterministic pseudo-random regressors; two irrational frequencies so the
    // two columns are not collinear, which is what the determinant guard exists for.
    for (let i = 0; i < 200; i++) {
      const a = Math.sin(i * 0.7);
      const b = Math.cos(i * 1.3);
      x1.push(a);
      x2.push(b);
      y.push(0.9 * a - 0.4 * b);
    }
    const fit = ols2(y, x1, x2);
    expect(fit).not.toBeNull();
    expect(fit!.b1).toBeCloseTo(0.9, 8);
    expect(fit!.b2).toBeCloseTo(-0.4, 8);
    expect(fit!.r2).toBeCloseTo(1, 8);
  });

  it("returns null rather than a number when the regressors are collinear", () => {
    // Two identical columns have no unique solution. Returning some value anyway
    // would put an invented beta into the shock.
    const x = Array.from({ length: 100 }, (_, i) => Math.sin(i));
    expect(ols2(x, x, x)).toBeNull();
  });

  it("reports a low R2 for a series the factors do not explain", () => {
    const x1 = Array.from({ length: 200 }, (_, i) => Math.sin(i * 0.7));
    const x2 = Array.from({ length: 200 }, (_, i) => Math.cos(i * 1.3));
    const y = Array.from({ length: 200 }, (_, i) => Math.sin(i * 0.11 + 2));
    const fit = ols2(y, x1, x2)!;
    expect(fit.r2).toBeLessThan(0.2);
  });
});

describe("logReturns and stdev", () => {
  it("yields a return only for days whose predecessor is also present", () => {
    // Day-indexed rather than positional, so a gap in the series produces no
    // return at all instead of silently comparing prices two weeks apart.
    const gapped = new Map([
      [100, 1],
      [101, 2],
      [102, 4],
      [200, 8],
    ]);
    const returns = logReturns(gapped);
    expect([...returns.keys()]).toEqual([101, 102]);
    expect(returns.get(101)).toBeCloseTo(Math.LN2, 12);
  });

  it("is zero for a flat series, which is how a stablecoin identifies itself", () => {
    const flat = new Map([100, 101, 102, 103, 104].map((d) => [d, 1] as const));
    expect(stdev([...logReturns(flat).values()])).toBe(0);
  });
});

describe("measureBetas", () => {
  /** A price series where the asset moves `beta` times as much as ETH each day. */
  function series(days: number, ethBeta: number, btcBeta = 0): PriceSeries {
    const out: PriceSeries = new Map();
    let price = 100;
    for (let day = 20_000; day < 20_000 + days; day++) {
      const ethMove = 0.01 * Math.sin(day * 0.7);
      const btcMove = 0.01 * Math.cos(day * 1.3);
      price *= Math.exp(ethBeta * ethMove + btcBeta * btcMove);
      out.set(day, price);
    }
    return out;
  }

  const history = new Map<string, PriceSeries>([
    [ETH, series(300, 1)],
    [BTC, series(300, 0, 1)],
    [DERIVATIVE, series(300, 1.02)],
    [STABLE, series(300, 0)],
  ]);

  const assets = [
    { id: ETH, symbol: "WETH" },
    { id: BTC, symbol: "WBTC" },
    { id: DERIVATIVE, symbol: "weETH" },
    { id: STABLE, symbol: "USDC" },
  ];

  it("measures a derivative's beta against the factor it tracks", () => {
    const betas = measureBetas(assets, history);
    const d = betas.get(DERIVATIVE)!;
    expect(d.betaEth).toBeCloseTo(1.02, 4);
    expect(d.betaBtc).toBeCloseTo(0, 4);
    expect(d.r2).toBeGreaterThan(0.99);
    expect(d.confidence).toBe("measured");
  });

  it("gives the ETH proxy a beta of exactly one against itself", () => {
    const eth = measureBetas(assets, history).get(ETH)!;
    expect(eth.betaEth).toBeCloseTo(1, 8);
  });

  it("identifies a stablecoin without being told it is one", () => {
    const stable = measureBetas(assets, history).get(STABLE)!;
    expect(Math.abs(stable.betaEth)).toBeLessThan(0.01);
    expect(stable.volatility).toBeLessThan(0.001);
  });

  it("refuses to run at all when a factor proxy has no history", () => {
    // Falling back to an assumed correlation here would silently replace measured
    // exposure with a guess across the whole model.
    const missing = new Map(history);
    missing.delete(ETH);
    expect(() => measureBetas(assets, missing)).toThrow(/ETH/);
  });

  it("marks an asset with too few observations as unmeasured", () => {
    const short = new Map(history);
    short.set(DERIVATIVE, series(10, 1.02));
    const betas = measureBetas(assets, short);
    expect(betas.get(DERIVATIVE)!.confidence).not.toBe("measured");
  });
});

/**
 * The price index every fixture below is denominated in.
 *
 * Shared with `position()` rather than declared per describe block, because
 * `amount * PRICES[assetId] === valueUsd` is an invariant of real data — the whole
 * point of `addReceiptPrices` — and a fixture that violates it asserts on a book the
 * pipeline cannot produce.
 */
const PRICES = new Map([
  [ETH, 2_000],
  [BTC, 60_000],
  [DERIVATIVE, 2_100],
  [STABLE, 1],
  [GOLD, 3_300],
]);

let seq = 0;
function position(
  account: string,
  protocol: string,
  side: Position["side"],
  assetId: string,
  valueUsd: number,
  liquidationThreshold = 0.8,
): Position {
  const price = PRICES.get(assetId);
  if (price === undefined) throw new Error(`fixture asset ${assetId} has no price`);
  return {
    id: `q${seq++}`,
    protocol,
    account,
    side,
    assetId,
    assetSymbol: assetId.slice(0, 6),
    amount: valueUsd / price,
    valueUsd,
    liquidationThreshold,
    maximumLtv: liquidationThreshold - 0.05,
    marketId: `${protocol}-${assetId}`,
  };
}

describe("coupling", () => {
  const positions = [
    // Big protocol and small protocol, both secured by the same asset.
    position("0xa", "big", "COLLATERAL", ETH, 10_000_000_000),
    position("0xa", "big", "BORROWER", STABLE, 1_000_000),
    position("0xb", "small", "COLLATERAL", ETH, 10_000_000),
    position("0xb", "small", "BORROWER", STABLE, 1_000_000),
    // A third protocol sharing a borrower with `big` but no collateral asset.
    position("0xa", "other", "COLLATERAL", BTC, 5_000_000),
    position("0xa", "other", "BORROWER", STABLE, 1_000_000),
  ];
  const m = buildCouplingMatrix(positions);

  it("has a symmetric borrower-overlap matrix", () => {
    expect(() => assertSymmetric(m.borrowerOverlap)).not.toThrow();
  });

  it("catches a transposed index", () => {
    const broken = { a: { a: 1, b: 0.5 }, b: { a: 0.2, b: 1 } };
    expect(() => assertSymmetric(broken)).toThrow(/not symmetric/);
  });

  it("scores shared collateral asymmetrically, in the direction contagion runs", () => {
    // Both are fully exposed to the same asset, and that is the point: the small
    // protocol is existentially exposed to the big one's forced selling, and
    // symmetrising the matrix would erase the size difference entirely.
    expect(m.collateralExposure.small.big).toBeCloseTo(1, 12);
    expect(m.collateralExposure.big.other).toBeCloseTo(0, 12);
    expect(m.collateralExposure.other.big).toBeCloseTo(0, 12);
  });

  it("finds a shared borrower where there is no shared collateral", () => {
    expect(m.borrowerOverlap.big.other).toBeGreaterThan(0);
    expect(m.collateralExposure.big.other).toBe(0);
  });

  it("lists the assets doing the transmitting, largest first", () => {
    expect(m.sharedAssets[0].assetId).toBe(ETH);
    expect(m.sharedAssets[0].protocols).toEqual(["big", "small"]);
  });
});

describe("E-Mode inference", () => {
  const betas = measureBetas(
    [
      { id: ETH, symbol: "WETH" },
      { id: BTC, symbol: "WBTC" },
      { id: DERIVATIVE, symbol: "weETH" },
      { id: STABLE, symbol: "USDC" },
    ],
    new Map<string, PriceSeries>([
      [ETH, seriesFor(1, 0)],
      [BTC, seriesFor(0, 1)],
      [DERIVATIVE, seriesFor(1.02, 0)],
      [STABLE, seriesFor(0, 0)],
    ]),
  );
  const prices = PRICES;

  function seriesFor(ethBeta: number, btcBeta: number): PriceSeries {
    const out: PriceSeries = new Map();
    let price = 100;
    for (let day = 20_000; day < 20_300; day++) {
      price *= Math.exp(
        ethBeta * 0.01 * Math.sin(day * 0.7) + btcBeta * 0.01 * Math.cos(day * 1.3),
      );
      out.set(day, price);
    }
    return out;
  }

  it("grants E-Mode where correlated collateral secures correlated debt", () => {
    // weETH against WETH: the real Aave ETH-correlated category, and the case that
    // explains the entire health-factor gap on the largest cross-protocol borrower.
    const d = decideEmode(
      "0xa",
      "aave-v3-eth",
      [position("0xa", "aave-v3-eth", "COLLATERAL", DERIVATIVE, 1_000_000, 0.8)],
      [position("0xa", "aave-v3-eth", "BORROWER", ETH, 850_000, 0)],
      betas,
      prices,
    );
    expect(d.eligible).toBe(true);
    expect(d.factor).toBe("ETH");
    expect(d.thresholdAfter).toBe(EMODE_THRESHOLD);
    expect(d.healthAfter).toBeGreaterThan(1);
  });

  it("refuses where there is no contradiction to resolve", () => {
    // Raising a solvent account's threshold on a guess would invent safety margin
    // and suppress liquidations the simulation should be finding.
    const d = decideEmode(
      "0xa",
      "aave-v3-eth",
      [position("0xa", "aave-v3-eth", "COLLATERAL", DERIVATIVE, 1_000_000, 0.8)],
      [position("0xa", "aave-v3-eth", "BORROWER", ETH, 100_000, 0)],
      betas,
      prices,
    );
    expect(d.eligible).toBe(false);
    expect(d.reason).toMatch(/no contradiction/);
  });

  it("refuses where collateral and debt are not the same bet", () => {
    const d = decideEmode(
      "0xa",
      "aave-v3-eth",
      [position("0xa", "aave-v3-eth", "COLLATERAL", DERIVATIVE, 1_000_000, 0.8)],
      [position("0xa", "aave-v3-eth", "BORROWER", STABLE, 900_000, 0)],
      betas,
      prices,
    );
    expect(d.eligible).toBe(false);
    expect(d.reason).toMatch(/E-Mode cannot explain it/);
  });

  it("never lowers a threshold that is already above the E-Mode ceiling", () => {
    const d = decideEmode(
      "0xa",
      "aave-v3-eth",
      [position("0xa", "aave-v3-eth", "COLLATERAL", DERIVATIVE, 1_000_000, 0.98)],
      [position("0xa", "aave-v3-eth", "BORROWER", ETH, 990_000, 0)],
      betas,
      prices,
    );
    expect(d.thresholdAfter).toBeCloseTo(0.98, 12);
  });

  it("recognises the dollar category by measurement, not by a token list", () => {
    // Aave's third E-Mode category is stablecoin against stablecoin, and a two
    // factor ETH/BTC model cannot see it: both legs correctly have zero beta, so
    // neither loads on anything. Volatility is what identifies them.
    expect(dominantFactor([position("0xa", "p", "COLLATERAL", STABLE, 1_000)], betas, prices)).toBe(
      "USD",
    );
    const d = decideEmode(
      "0xa",
      "aave-v3-eth",
      [position("0xa", "aave-v3-eth", "COLLATERAL", STABLE, 1_000_000, 0.8)],
      [position("0xa", "aave-v3-eth", "BORROWER", STABLE, 900_000, 0)],
      betas,
      prices,
    );
    expect(d.eligible).toBe(true);
    expect(d.factor).toBe("USD");
  });

  it("keeps a low-beta but volatile asset out of the dollar category", () => {
    // Tokenised gold has near-zero betas on both factors, so betas alone would put
    // XAUt in with the stablecoins. It is 50x more volatile than any of them, and
    // the same asset defeating a price-band heuristic is why factors.ts measures.
    const gold = GOLD;
    const goldBetas = new Map(betas);
    goldBetas.set(gold, {
      assetId: gold,
      symbol: "XAUt",
      betaEth: 0.05,
      betaBtc: 0.17,
      r2: 0.11,
      observations: 362,
      volatility: 0.01582,
      confidence: "measured",
      reason: "measured from live oracle history",
    });
    const goldPrices = new Map(prices).set(gold, 3_300);
    expect(
      dominantFactor([position("0xa", "p", "COLLATERAL", gold, 1_000)], goldBetas, goldPrices),
    ).toBeNull();
  });

  it("finds no dominant factor in a mixed book", () => {
    expect(
      dominantFactor(
        [
          position("0xa", "p", "COLLATERAL", DERIVATIVE, 500_000),
          position("0xa", "p", "COLLATERAL", STABLE, 500_000),
        ],
        betas,
        prices,
      ),
    ).toBeNull();
  });

  it("calibrated mode leaves no book contradicted that collateral can cover", () => {
    const positions = [
      position("0xa", "aave-v3-eth", "COLLATERAL", DERIVATIVE, 1_000_000, 0.8),
      position("0xa", "aave-v3-eth", "BORROWER", STABLE, 900_000, 0),
    ];
    const grouped = groupByAccountProtocol(positions);
    const off = effectiveThresholds(grouped, betas, prices, "off");
    const calibrated = effectiveThresholds(grouped, betas, prices, "calibrated");
    expect(off.contradicted.size).toBe(1);
    expect(calibrated.contradicted.size).toBe(0);
    // Exactly marginal, by construction: 900k of debt against 1M of collateral.
    expect(calibrated.thresholds.get(positions[0].id)).toBeCloseTo(0.9, 12);
  });

  it("keeps a book contradicted when its debt exceeds its collateral outright", () => {
    // A threshold above 1 would mean lending more than the collateral is worth, so
    // the error is something other than a missing threshold and stays unexplained.
    const positions = [
      position("0xa", "aave-v3-eth", "COLLATERAL", DERIVATIVE, 500_000, 0.8),
      position("0xa", "aave-v3-eth", "BORROWER", STABLE, 900_000, 0),
    ];
    const calibrated = effectiveThresholds(
      groupByAccountProtocol(positions),
      betas,
      prices,
      "calibrated",
    );
    expect(calibrated.contradicted.size).toBe(1);
  });
});

describe("tracksAnchor", () => {
  // The gate that decides E-Mode *group membership*, as distinct from which shock an
  // asset receives. It exists because of one measured near-miss: LINK regresses to a
  // 0.807 ETH beta at 79% R2, which passes `classifyAsset` — correctly, LINK really
  // does fall about 0.8 of an ETH move — but LINK against WETH is not an Aave E-Mode
  // pair, and admitting it would have manufactured solvency for a book that has none.
  const beta = (over: Partial<AssetBeta>): AssetBeta => ({
    assetId: "0x1111111111111111111111111111111111111111",
    symbol: "TEST",
    betaEth: 0,
    betaBtc: 0,
    r2: 0.95,
    observations: 364,
    volatility: 0.034,
    confidence: "measured",
    reason: "measured from live oracle history",
    ...over,
  });

  it("admits the four real ETH wrappers, on their measured live numbers", () => {
    // weETH, wstETH, rETH, cbETH — Aave's published ETH-correlated category, arrived
    // at by regression rather than by listing the symbols.
    for (const [betaEth, betaBtc, r2] of [
      [0.94, 0.073, 0.947],
      [0.979, 0.032, 0.986],
      [0.937, 0.0, 0.76],
      [0.977, -0.116, 0.712],
    ]) {
      expect(tracksAnchor(beta({ betaEth, betaBtc, r2 }))).toBe(true);
    }
  });

  it("rejects LINK, which loads on ETH but carries its own BTC exposure", () => {
    const link = beta({ betaEth: 0.807, betaBtc: 0.298, r2: 0.792, volatility: 0.038 });
    // Still ETH for shock purposes — the two questions have different answers, which
    // is the entire reason this function is separate.
    expect(classifyAsset(link)).toBe("ETH");
    expect(tracksAnchor(link)).toBe(false);
  });

  it("admits the BTC wrappers in mirror", () => {
    for (const [betaBtc, betaEth, r2] of [
      [0.999, -0.002, 0.982],
      [0.883, 0.002, 0.758],
      [0.915, 0.028, 0.889],
    ]) {
      expect(tracksAnchor(beta({ betaEth, betaBtc, r2, volatility: 0.0236 }))).toBe(true);
    }
  });

  it("admits a dollar without asking it to track anything", () => {
    // There is no USD proxy in the regression, so a stablecoin has no anchor to load
    // on. The volatility test in `classifyAsset` is already the tight one.
    expect(tracksAnchor(beta({ betaEth: -0.001, betaBtc: 0.001, r2: 0.008, volatility: 0.00011 }))).toBe(
      true,
    );
  });

  it("rejects anything classifyAsset already rejected", () => {
    expect(tracksAnchor(undefined)).toBe(false);
    // rsETH as measured: a genuine ETH derivative whose fit is too poor to claim it.
    // Unmeasured is not uncorrelated, and it is not correlated either.
    expect(tracksAnchor(beta({ betaEth: 0.573, betaBtc: 0.242, r2: 0.506 }))).toBe(false);
    expect(tracksAnchor(beta({ betaEth: 0.98, confidence: "unmeasured" }))).toBe(false);
  });
});

describe("resolveReceiptBetas", () => {
  // Receipt tokens are never a `Market.inputToken`, so they have no oracle price
  // history and `measureBetas` correctly returns `unmeasured`. But `shockForAsset`
  // holds unmeasured collateral at ratio 1 — no shock at all — and $10.4M of aToken
  // collateral modelled as shock-proof understates the cascade rather than being
  // cautious about it.
  const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  const AWETH = "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8";

  const measured = (over: Partial<AssetBeta> = {}): AssetBeta => ({
    assetId: WETH,
    symbol: "WETH",
    betaEth: 1,
    betaBtc: 0,
    r2: 1,
    observations: 364,
    volatility: 0.03,
    confidence: "measured",
    reason: "factor proxy: defines the ETH shock",
    ...over,
  });

  const unmeasured = (assetId: string, symbol: string): AssetBeta => ({
    assetId,
    symbol,
    betaEth: 0,
    betaBtc: 0,
    r2: 0,
    observations: 0,
    volatility: 0,
    confidence: "unmeasured",
    reason: "no daily price history available",
  });

  const receipt = { assetId: AWETH, assetSymbol: "aEthWETH", underlyingAssetId: WETH };

  it("gives a receipt the beta of the asset it is a receipt for", () => {
    const betas = resolveReceiptBetas(
      new Map([
        [WETH, measured()],
        [AWETH, unmeasured(AWETH, "aEthWETH")],
      ]),
      [receipt],
    );
    const a = betas.get(AWETH)!;
    expect(a.betaEth).toBe(1);
    expect(a.confidence).toBe("measured");
    // It keeps its own identity, and says where the number came from.
    expect(a.assetId).toBe(AWETH);
    expect(a.symbol).toBe("aEthWETH");
    expect(a.reason).toMatch(/receipt token for WETH/);
  });

  it("adds a beta for a receipt the measurement never saw at all", () => {
    // `measureBetas` only covers the assets it was asked about, so a receipt can be
    // missing from the map rather than present-and-unmeasured.
    const betas = resolveReceiptBetas(new Map([[WETH, measured()]]), [receipt]);
    expect(betas.get(AWETH)?.betaEth).toBe(1);
  });

  it("does not upgrade a receipt whose underlying is itself unmeasured", () => {
    // Otherwise the substitution would launder an absence of evidence into a
    // measured-looking zero, which is the one thing worse than admitting the gap.
    const betas = resolveReceiptBetas(
      new Map([
        ["0xrsETH".toLowerCase(), unmeasured("0xrseth", "rsETH")],
        [AWETH, unmeasured(AWETH, "aEthrsETH")],
      ]),
      [{ assetId: AWETH, assetSymbol: "aEthrsETH", underlyingAssetId: "0xrseth" }],
    );
    expect(betas.get(AWETH)!.confidence).toBe("unmeasured");
  });

  it("leaves a measured receipt alone, and leaves non-receipts alone", () => {
    const own = measured({ assetId: AWETH, symbol: "aEthWETH", betaEth: 0.9, r2: 0.8 });
    const betas = resolveReceiptBetas(
      new Map([
        [WETH, measured()],
        [AWETH, own],
      ]),
      [receipt, { assetId: WETH, assetSymbol: "WETH" }],
    );
    // A real measurement beats an inherited one.
    expect(betas.get(AWETH)!.betaEth).toBe(0.9);
    expect(betas.get(WETH)!.reason).toBe(measured().reason);
  });
});
