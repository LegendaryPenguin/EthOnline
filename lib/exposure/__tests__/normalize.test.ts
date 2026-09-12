import { describe, expect, it } from "vitest";
import {
  addReceiptPrices,
  buildPriceIndex,
  normalizePosition,
  normalizeSide,
  toFraction,
  toTokenUnits,
} from "../normalize";
import type { Position, RawMarket, RawPosition } from "../types";

describe("normalizeSide", () => {
  it("maps the schema 2.x spelling", () => {
    // Not hypothetical: Compound V2 is live on 2.0.1 and returns LENDER today.
    expect(normalizeSide("LENDER")).toBe("COLLATERAL");
    expect(normalizeSide("COLLATERAL")).toBe("COLLATERAL");
    expect(normalizeSide("BORROWER")).toBe("BORROWER");
  });

  it("throws rather than guessing on an unknown side", () => {
    // Silently defaulting would misclassify debt as collateral and invert risk.
    expect(() => normalizeSide("SOMETHING_NEW")).toThrow(/Unrecognized PositionSide/);
  });
});

describe("toFraction", () => {
  it("reads percentages the way Aave V3 and Compound V2 emit them", () => {
    expect(toFraction("83")).toBeCloseTo(0.83);
    expect(toFraction("82.5")).toBeCloseTo(0.825);
  });

  it("reads fractions the way Morpho Aave V2 emits them", () => {
    // Same standardized field, different unit, both live.
    expect(toFraction("0.86")).toBeCloseTo(0.86);
    expect(toFraction("0.875")).toBeCloseTo(0.875);
  });

  it("resolves the ambiguous 1 to 100%, since a 1% threshold does not exist", () => {
    expect(toFraction("1")).toBe(1);
  });

  it("returns 0 for missing, zero, and out-of-range values instead of a default", () => {
    // 0 means "unknown" to callers. Inventing a threshold would silently corrupt
    // every health factor computed from it.
    expect(toFraction(null)).toBe(0);
    expect(toFraction(undefined)).toBe(0);
    expect(toFraction("0")).toBe(0);
    expect(toFraction("not a number")).toBe(0);
    expect(toFraction("150")).toBe(0);
    expect(toFraction("-5")).toBe(0);
  });
});

describe("toTokenUnits", () => {
  it("scales by decimals", () => {
    expect(toTokenUnits("1500000", 6)).toBeCloseTo(1.5);
    expect(toTokenUnits("0", 18)).toBe(0);
  });

  it("handles balances beyond Number.MAX_SAFE_INTEGER", () => {
    // A whale's wei balance overflows a float, so the scaling has to happen in
    // BigInt before crossing into Number.
    const wei = "123456789012345678901234567890";
    expect(toTokenUnits(wei, 18)).toBeCloseTo(123456789012.34568, 0);
    expect(Number.isFinite(toTokenUnits(wei, 18))).toBe(true);
  });

  it("preserves sign", () => {
    expect(toTokenUnits("-2500000", 6)).toBeCloseTo(-2.5);
  });
});

const market = (over: Partial<RawMarket> = {}): RawMarket => ({
  id: "0xmarket",
  name: "m",
  isActive: true,
  canUseAsCollateral: true,
  canBorrowFrom: true,
  maximumLTV: "80",
  liquidationThreshold: "82.5",
  liquidationPenalty: "5",
  inputTokenPriceUSD: "2000",
  totalValueLockedUSD: "1000",
  totalBorrowBalanceUSD: "500",
  totalDepositBalanceUSD: "1000",
  inputToken: { id: "0xweth", symbol: "WETH", decimals: 18 },
  ...over,
});

describe("buildPriceIndex", () => {
  it("prefers the deepest market when several quote the same asset", () => {
    // Token has no price field in the schema, so markets are the only source.
    // The deepest market's oracle read is the best supported.
    const index = buildPriceIndex([
      market({ id: "a", inputTokenPriceUSD: "1900", totalValueLockedUSD: "10" }),
      market({ id: "b", inputTokenPriceUSD: "2000", totalValueLockedUSD: "9999" }),
    ]);
    expect(index.get("0xweth")).toBe(2000);
  });

  it("ignores markets with no usable price", () => {
    const index = buildPriceIndex([
      market({ inputTokenPriceUSD: "0" }),
      market({ inputTokenPriceUSD: "-1" }),
    ]);
    expect(index.size).toBe(0);
  });

  it("lowercases asset ids so the join key is stable", () => {
    const index = buildPriceIndex([
      market({ inputToken: { id: "0xWETH", symbol: "WETH", decimals: 18 } }),
    ]);
    expect(index.get("0xweth")).toBe(2000);
  });
});

const rawPosition = (over: Partial<RawPosition> = {}): RawPosition => ({
  id: "p1",
  side: "COLLATERAL",
  isCollateral: true,
  balance: "1000000000000000000",
  account: { id: "0xABC" },
  asset: { id: "0xweth", symbol: "WETH", decimals: 18 },
  market: {
    id: "0xmarket",
    liquidationThreshold: "82.5",
    maximumLTV: "80",
    inputTokenPriceUSD: "2000",
    inputToken: { id: "0xweth", symbol: "WETH", decimals: 18 },
  },
  ...over,
});

describe("normalizePosition", () => {
  it("values a position and lowercases the join key", () => {
    const p = normalizePosition(rawPosition(), "aave-v3-eth", new Map());
    expect(p).not.toBeNull();
    expect(p!.valueUsd).toBeCloseTo(2000);
    expect(p!.account).toBe("0xabc");
    expect(p!.liquidationThreshold).toBeCloseTo(0.825);
  });

  it("falls back to the market's input token when Position.asset is absent", () => {
    // Schema 2.0.1 has no Position.asset; Compound V2 is live on it.
    const raw = rawPosition();
    delete raw.asset;
    const p = normalizePosition(raw, "compound-v2-eth", new Map());
    expect(p!.assetSymbol).toBe("WETH");
    expect(p!.valueUsd).toBeCloseTo(2000);
  });

  it("uses the cross-market index when the asset differs from the market's token", () => {
    // Compound V3 markets hold collateral assets other than the base token.
    const raw = rawPosition({
      asset: { id: "0xwbtc", symbol: "WBTC", decimals: 8 },
      balance: "100000000",
    });
    const p = normalizePosition(raw, "compound-v3-eth", new Map([["0xwbtc", 60000]]));
    expect(p!.valueUsd).toBeCloseTo(60000);
  });

  it("returns null for an unpriceable position rather than valuing it at zero", () => {
    // A zero-valued position inside a total is a silent understatement of risk.
    const raw = rawPosition({
      asset: { id: "0xunknown", symbol: "???", decimals: 18 },
      market: { ...rawPosition().market, inputTokenPriceUSD: "0" },
    });
    expect(normalizePosition(raw, "aave-v3-eth", new Map())).toBeNull();
  });

  it("prices a receipt token at the market's own quote", () => {
    // The measured failure: Aave V3 reports supply positions in the aToken, which
    // has no price anywhere in the schema. Dropping the position made the largest
    // borrower on Aave V3 read as $1.03B of debt against $0 of collateral and
    // publish as insolvent under a 5% shock, while alive on chain.
    const base = rawPosition();
    const raw = rawPosition({
      asset: { id: "0xaethweth", symbol: "aEthWETH", decimals: 18 },
      market: {
        ...base.market,
        outputToken: { id: "0xaEthWETH", symbol: "aEthWETH", decimals: 18 },
      },
    });
    const p = normalizePosition(raw, "aave-v3-eth", new Map());
    expect(p).not.toBeNull();
    expect(p!.valueUsd).toBeCloseTo(2000);
  });

  it("applies a reported exchange rate to a receipt token", () => {
    // A cToken is not 1:1 with its underlying. Where the protocol reports the
    // rate, assuming 1:1 would understate collateral by the accrued interest.
    const base = rawPosition();
    const raw = rawPosition({
      asset: { id: "0xceth", symbol: "cETH", decimals: 18 },
      market: {
        ...base.market,
        exchangeRate: "1.05",
        outputToken: { id: "0xceth", symbol: "cETH", decimals: 18 },
      },
    });
    expect(normalizePosition(raw, "compound-v2-eth", new Map())!.valueUsd).toBeCloseTo(2100);
  });

  it("refuses a 1:1 assumption when the receipt token's decimals differ", () => {
    // Different decimals mean the receipt is not a plain unit-for-unit claim, and
    // an unreported rate is then unknown rather than 1. Unknown drops the row.
    const base = rawPosition();
    const raw = rawPosition({
      asset: { id: "0xreceipt", symbol: "rWETH", decimals: 8 },
      balance: "100000000",
      market: {
        ...base.market,
        outputToken: { id: "0xreceipt", symbol: "rWETH", decimals: 8 },
      },
    });
    expect(normalizePosition(raw, "x", new Map())).toBeNull();
  });

  it("does not mistake an unrelated asset for the receipt token", () => {
    // Compound V3 collateral is a real asset in a market whose output token is the
    // base receipt. Pricing WBTC at the USDC quote would be catastrophic.
    const base = rawPosition();
    const raw = rawPosition({
      asset: { id: "0xwbtc", symbol: "WBTC", decimals: 8 },
      balance: "100000000",
      market: {
        ...base.market,
        outputToken: { id: "0xcusdcv3", symbol: "cUSDCv3", decimals: 6 },
      },
    });
    expect(normalizePosition(raw, "compound-v3-eth", new Map())).toBeNull();
    expect(
      normalizePosition(raw, "compound-v3-eth", new Map([["0xwbtc", 60000]]))!.valueUsd,
    ).toBeCloseTo(60000);
  });

  it("returns null for a zero balance", () => {
    expect(normalizePosition(rawPosition({ balance: "0" }), "x", new Map())).toBeNull();
  });

  it("records the underlying of a receipt token, and nothing else's", () => {
    // Downstream, a receipt token has no price index entry and no price history. The
    // only thing that can resolve either is knowing what it is a receipt for, and
    // this is the one place that knows.
    const base = rawPosition();
    const receipt = normalizePosition(
      rawPosition({
        asset: { id: "0xaethweth", symbol: "aEthWETH", decimals: 18 },
        market: {
          ...base.market,
          outputToken: { id: "0xaEthWETH", symbol: "aEthWETH", decimals: 18 },
        },
      }),
      "aave-v3-eth",
      new Map(),
    );
    expect(receipt!.underlyingAssetId).toBe("0xweth");

    // A plain position is not a receipt for anything, and claiming otherwise would
    // give an asset the beta of whatever market it happened to sit in.
    expect(normalizePosition(base, "aave-v3-eth", new Map())!.underlyingAssetId).toBeUndefined();
    const collateralInAReceiptMarket = normalizePosition(
      rawPosition({
        asset: { id: "0xwbtc", symbol: "WBTC", decimals: 8 },
        balance: "100000000",
        market: { ...base.market, outputToken: { id: "0xcusdcv3", symbol: "cUSDCv3", decimals: 6 } },
      }),
      "compound-v3-eth",
      new Map([["0xwbtc", 60000]]),
    );
    expect(collateralInAReceiptMarket!.underlyingAssetId).toBeUndefined();
  });
});

describe("addReceiptPrices", () => {
  // The bug this exists for: the cascade simulator re-derived USD as
  // `amount x priceIndex[assetId]`, the index is keyed by `Market.inputToken`, and a
  // receipt token is in it nowhere. Two aToken positions worth $10.4M priced at $0
  // made a solvent book read as underwater and liquidated $25,177 at a **zero
  // percent shock**.
  const position = (over: Partial<Position> = {}): Position => ({
    id: "p",
    protocol: "aave-v3-eth",
    account: "0xa",
    side: "COLLATERAL",
    assetId: "0xaethweth",
    assetSymbol: "aEthWETH",
    amount: 4,
    valueUsd: 8000,
    liquidationThreshold: 0.8,
    maximumLtv: 0.75,
    marketId: "m",
    underlyingAssetId: "0xweth",
    ...over,
  });

  it("prices a receipt token so amount x price reproduces valueUsd exactly", () => {
    const prices = addReceiptPrices(new Map([["0xweth", 2000]]), [position()]);
    const p = position();
    expect(prices.get("0xaethweth")).toBe(2000);
    expect(p.amount * prices.get(p.assetId)!).toBe(p.valueUsd);
  });

  it("does not overwrite a price the market index already published", () => {
    // The market's own quote is the authority. An implied price from one position's
    // rounded balance is not an improvement on it.
    const prices = addReceiptPrices(new Map([["0xaethweth", 1999]]), [position()]);
    expect(prices.get("0xaethweth")).toBe(1999);
  });

  it("adds nothing it cannot derive", () => {
    const prices = addReceiptPrices(new Map(), [
      position({ assetId: "0xzero", amount: 0 }),
      position({ assetId: "0xnegative", valueUsd: -1 }),
    ]);
    expect(prices.size).toBe(0);
  });
});
