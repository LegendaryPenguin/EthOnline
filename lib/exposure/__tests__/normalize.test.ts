import { describe, expect, it } from "vitest";
import {
  buildPriceIndex,
  normalizePosition,
  normalizeSide,
  toFraction,
  toTokenUnits,
} from "../normalize";
import type { RawMarket, RawPosition } from "../types";

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

  it("returns null for a zero balance", () => {
    expect(normalizePosition(rawPosition({ balance: "0" }), "x", new Map())).toBeNull();
  });
});
