/**
 * The wire format round-trip.
 *
 * `decodeSignal` casts viem's `unknown[]` to a fifteen-element tuple, because
 * `SIGNAL_ABI_PARAMS` is a runtime concatenation and viem cannot infer a type from
 * it. That cast is unchecked by the compiler, so it is checked here: every field is
 * asserted individually, against a signal produced by the real aggregation rather
 * than a hand-written literal. A test that only checked the count would pass while
 * two same-typed fields sat swapped.
 */

import { describe, expect, it } from "vitest";
import { aggregateSignal } from "../aggregate";
import { parseRiskPolicy } from "../policy";
import { asOfBlock, bps, decodeSignal, encodeSignal, SIGNAL_ABI_PARAMS, usd6 } from "../report";
import type { Position } from "../../exposure/types";

const ETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";

const policy = parseRiskPolicy(
  JSON.stringify({
    shocks: [0.1, 0.2, 0.3],
    assetBeta: { [ETH]: 1, [USDC]: 0.01, [WBTC]: 1 },
    defaultBeta: 1,
    kAnonymity: 3,
    weights: { concentration: 0.5, leverage: 0.25, distress: 0.25 },
    leverageWatchLevel: 1.5,
    // One group, so the reconstruction actually fires and the two `emodeInferred*`
    // fields carry non-zero values. Zeros would round-trip even if they were wired
    // to the wrong slot.
    emode: { threshold: 0.95, groups: [[ETH, USDC]] },
  }),
);

let seq = 0;
function pos(
  account: string,
  protocol: string,
  side: Position["side"],
  assetId: string,
  valueUsd: number,
): Position {
  return {
    id: `p${seq++}`,
    protocol,
    account,
    side,
    assetId,
    assetSymbol: assetId === ETH ? "WETH" : assetId === WBTC ? "WBTC" : "USDC",
    amount: valueUsd,
    valueUsd,
    liquidationThreshold: side === "BORROWER" ? 0 : 0.8,
    maximumLtv: 0.75,
    marketId: `${protocol}-${assetId}`,
  };
}

const book = (account: string, protocol: string, collateralUsd: number, debtUsd: number) => [
  pos(account, protocol, "COLLATERAL", ETH, collateralUsd),
  pos(account, protocol, "BORROWER", USDC, debtUsd),
];

/**
 * A sample with something in every published field: three addresses levered on both
 * protocols (so the coupling bucket clears k = 3), one distressed at the deepest
 * shock, one whose health factor needs the E-Mode lift, and one contradicted book the
 * lift cannot reach — so `debtUsd` and `evaluableDebtUsd` are genuinely different
 * numbers and cannot pass this test by coincidence.
 */
function sample(): Position[] {
  const out: Position[] = [];
  for (let i = 0; i < 3; i++) {
    out.push(
      ...book(`0xacct${i}`, "aave-v3-eth", 400, 100),
      ...book(`0xacct${i}`, "compound-v3-eth", 400, 100),
    );
  }
  out.push(...book("0xthin", "aave-v3-eth", 170, 100));
  out.push(...book("0xlifted", "aave-v3-eth", 100, 85));
  // WBTC is outside the group, so this book stays contradicted: observed, not
  // evaluated. Exactly the case `evaluableDebtUsd6` exists to expose.
  out.push(
    pos("0xstranded", "aave-v3-eth", "COLLATERAL", WBTC, 100),
    pos("0xstranded", "aave-v3-eth", "BORROWER", USDC, 85),
  );
  return out;
}

const signal = aggregateSignal({
  positions: sample(),
  blocks: { "aave-v3-eth": 999, "compound-v3-eth": 1000 },
  reportedDebtUsd: { "aave-v3-eth": 1_000_000, "compound-v3-eth": 1_000_000 },
  policy,
});

describe("the signal wire format", () => {
  const decoded = decodeSignal(encodeSignal(signal));

  it("round-trips every field into the field of the same name", () => {
    expect(decoded.version).toBe(signal.version);
    expect(decoded.asOfBlock).toBe(BigInt(asOfBlock(signal)));
    expect(decoded.borrowersObserved).toBe(signal.borrowersObserved);
    expect(decoded.debtUsd6).toBe(usd6(signal.debtUsd));
    expect(decoded.evaluableDebtUsd6).toBe(usd6(signal.evaluableDebtUsd));
    expect(decoded.multiProtocolDebtUsd6).toBe(usd6(signal.multiProtocolDebtUsd));
    expect(decoded.multiProtocolShareBps).toBe(bps(signal.multiProtocolShareOfDebt));
    expect(decoded.leveredShareBps).toBe(bps(signal.leveredShareOfDebt));
    expect(decoded.systemicRiskScoreBps).toBe(bps(signal.systemicRiskScore / 100));
    expect(decoded.couplingBuckets).toBe(signal.coupling.length);
    expect(decoded.suppressedBuckets).toBe(signal.suppressedBuckets.length);
    expect(decoded.emodeInferredBorrowers).toBe(signal.emodeInferredBorrowers);
    expect(decoded.emodeInferredDebtUsd6).toBe(usd6(signal.emodeInferredDebtUsd));

    const worst = signal.shockLadder[signal.shockLadder.length - 1];
    expect(decoded.worstShockBps).toBe(bps(worst.shock));
    expect(decoded.worstShockDistressedDebtUsd6).toBe(usd6(worst.distressedDebtUsd));
  });

  it("carries values a swapped pair of same-typed fields would not survive", () => {
    // The round-trip above would pass with any two equal-valued fields transposed, so
    // the fixture is built to make them distinct. Asserted here so a future change
    // that flattens them fails loudly rather than weakening the test in silence.
    expect(decoded.debtUsd6).not.toBe(decoded.evaluableDebtUsd6);
    expect(decoded.multiProtocolDebtUsd6).not.toBe(decoded.debtUsd6);
    expect(decoded.multiProtocolShareBps).not.toBe(decoded.leveredShareBps);
    expect(decoded.couplingBuckets).not.toBe(decoded.suppressedBuckets);
    expect(decoded.emodeInferredBorrowers).toBeGreaterThan(0);
    expect(decoded.emodeInferredDebtUsd6).toBeGreaterThan(0n);
  });

  it("publishes the oldest block, not the newest", () => {
    // A consumer's staleness check is only honest against the least fresh input.
    expect(decoded.asOfBlock).toBe(999n);
  });

  it("names fifteen fields, and the decoder reads all fifteen", () => {
    // The cast in `decodeSignal` is positional. If a field is appended to
    // `SIGNAL_ABI_PARAMS` without extending the tuple, the new value is dropped
    // silently; this catches that.
    expect(SIGNAL_ABI_PARAMS.split(",")).toHaveLength(15);
    expect(Object.keys(decoded)).toHaveLength(15);
  });

  it("encodes no address, because the payload is the published artifact", () => {
    expect(encodeSignal(signal)).not.toMatch(/0x[0-9a-f]*(?:c02aaa39|a0b86991)/i);
  });
});

describe("usd6", () => {
  it("scales to six decimals and rounds rather than truncating", () => {
    expect(usd6(1)).toBe(1_000_000n);
    expect(usd6(0.0000005)).toBe(1n);
  });

  it("refuses a value it cannot represent exactly", () => {
    // Silently wrapping money is not an option: the number would still look like a
    // number to every consumer downstream.
    expect(() => usd6(1e12)).toThrow(/exceeds exact integer range/);
    expect(() => usd6(-1)).toThrow(/refusing to encode/);
    expect(() => usd6(Number.NaN)).toThrow(/refusing to encode/);
  });
});

describe("bps", () => {
  it("saturates at 100% rather than wrapping uint16", () => {
    expect(bps(0.5)).toBe(5_000);
    expect(bps(1)).toBe(10_000);
    expect(bps(2.5)).toBe(10_000);
  });

  it("refuses a negative or non-finite fraction", () => {
    expect(() => bps(-0.1)).toThrow(/refusing/);
    expect(() => bps(Number.POSITIVE_INFINITY)).toThrow(/refusing/);
  });
});
