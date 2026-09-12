/**
 * Tests for the confidential aggregation.
 *
 * Two things are pinned here that nothing else can catch. The privacy guard is
 * the obvious one: it is the only thing standing between a carelessly added field
 * and a published address, and it has to fail on keys as well as values. The other
 * is that the suppression is *lossy in the right direction* — a suppressed bucket
 * must still be counted, or the signal would quietly under-report coupling and
 * look better than the data.
 */

import { describe, expect, it } from "vitest";
import {
  aggregateSignal,
  assertAggregateOnly,
  perAddressRowsForLeakDemoOnly,
  SIGNAL_VERSION,
} from "../aggregate";
import { parseRiskPolicy, type RiskPolicy } from "../policy";
import type { Position } from "../../exposure/types";

const ETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const POLICY_JSON = JSON.stringify({
  shocks: [0.1, 0.2, 0.3],
  assetBeta: { [ETH]: 1, [USDC]: 0.01 },
  defaultBeta: 1,
  kAnonymity: 3,
  weights: { concentration: 0.5, leverage: 0.25, distress: 0.25 },
  leverageWatchLevel: 1.5,
  // No groups: these tests measure the aggregation, not the reconstruction, and a
  // threshold quietly lifted underneath them would make their numbers mean
  // something other than what they say. The reconstruction has its own tests.
  emode: { threshold: 0.95, groups: [] },
});
const policy = parseRiskPolicy(POLICY_JSON);

let seq = 0;
function pos(
  account: string,
  protocol: string,
  side: Position["side"],
  assetId: string,
  valueUsd: number,
  liquidationThreshold = 0.8,
): Position {
  return {
    id: `p${seq++}`,
    protocol,
    account,
    side,
    assetId,
    assetSymbol: assetId === ETH ? "WETH" : "USDC",
    amount: valueUsd,
    valueUsd,
    liquidationThreshold: side === "BORROWER" ? 0 : liquidationThreshold,
    maximumLtv: 0.75,
    marketId: `${protocol}-${assetId}`,
  };
}

/** A book on one protocol: collateral, debt, and a healthy default threshold. */
function book(account: string, protocol: string, collateralUsd: number, debtUsd: number) {
  return [
    pos(account, protocol, "COLLATERAL", ETH, collateralUsd),
    pos(account, protocol, "BORROWER", USDC, debtUsd),
  ];
}

const blocks = { "aave-v3-eth": 100, "compound-v3-eth": 100 };
const reported = { "aave-v3-eth": 1_000_000, "compound-v3-eth": 1_000_000 };
const run = (positions: Position[], p: RiskPolicy = policy) =>
  aggregateSignal({ positions, blocks, reportedDebtUsd: reported, policy: p });

describe("aggregateSignal", () => {
  it("counts debt on 2+ protocols as multi-protocol and one protocol as not", () => {
    const both = [...book("0xa", "aave-v3-eth", 200, 100), ...book("0xa", "compound-v3-eth", 200, 100)];
    const one = book("0xb", "aave-v3-eth", 400, 200);

    const s = run([...both, ...one]);
    expect(s.borrowersObserved).toBe(2);
    expect(s.debtUsd).toBeCloseTo(400, 6);
    expect(s.multiProtocolBorrowers).toBe(1);
    expect(s.multiProtocolDebtUsd).toBeCloseTo(200, 6);
    expect(s.multiProtocolShareOfDebt).toBeCloseTo(0.5, 9);
  });

  it("does not count an address that merely supplies to a second protocol", () => {
    // Supplying on two protocols is not a contagion channel; being levered on two
    // is. The headline metric would be trivially inflated without this.
    const positions = [
      ...book("0xa", "aave-v3-eth", 200, 100),
      pos("0xa", "compound-v3-eth", "COLLATERAL", ETH, 500),
    ];
    expect(run(positions).multiProtocolBorrowers).toBe(0);
  });

  it("excludes a contradicted book from every component but still counts its debt", () => {
    // HF below 1 while alive means the published parameters are wrong, so shocking
    // the book yields a distress number with no units. Dropping it from `debtUsd`
    // too would hide how much of the book Sentinel cannot evaluate.
    const positions = [
      ...book("0xa", "aave-v3-eth", 100, 200),
      ...book("0xa", "compound-v3-eth", 100, 200),
    ];
    const s = run(positions);
    expect(s.debtUsd).toBeCloseTo(400, 6);
    expect(s.evaluableDebtUsd).toBe(0);
    expect(s.multiProtocolDebtUsd).toBe(0);
    expect(s.systemicRiskScore).toBe(0);
  });

  it("is monotone in the shock", () => {
    // Boundary is collateral x (1 - shock) x 0.8 against 100 of debt, so 145 fails
    // at 20% (92.8), 170 fails at 30% (95.2), and 400 survives the ladder.
    const positions = [
      ...book("0xa", "aave-v3-eth", 145, 100),
      ...book("0xb", "aave-v3-eth", 170, 100),
      ...book("0xc", "aave-v3-eth", 400, 100),
    ];
    const ladder = run(positions).shockLadder;
    expect(ladder.map((r) => r.shock)).toEqual([0.1, 0.2, 0.3]);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].distressedDebtUsd).toBeGreaterThanOrEqual(ladder[i - 1].distressedDebtUsd);
      expect(ladder[i].distressedBorrowers).toBeGreaterThanOrEqual(
        ladder[i - 1].distressedBorrowers,
      );
    }
    expect(ladder.map((r) => r.distressedBorrowers)).toEqual([0, 1, 2]);
  });

  it("applies per-asset betas rather than shocking every asset alike", () => {
    // Same dollar collateral, one in ETH and one in a near-zero-beta asset. A
    // uniform shock would distress both and overstate systemic risk.
    const eth = [
      pos("0xa", "aave-v3-eth", "COLLATERAL", ETH, 130),
      pos("0xa", "aave-v3-eth", "BORROWER", USDC, 100),
    ];
    const stable = [
      pos("0xb", "aave-v3-eth", "COLLATERAL", USDC, 130),
      pos("0xb", "aave-v3-eth", "BORROWER", USDC, 100),
    ];
    const s = run([...eth, ...stable]);
    expect(s.shockLadder[2].distressedBorrowers).toBe(1);
  });

  it("does not net a surplus on one protocol against a deficit on another", () => {
    // No protocol liquidates against another's collateral. Pooling the books here
    // would report safety nobody could enforce.
    const positions = [
      ...book("0xa", "aave-v3-eth", 130, 100),
      ...book("0xa", "compound-v3-eth", 10_000, 100),
    ];
    const s = run(positions);
    expect(s.shockLadder[2].distressedDebtUsd).toBeCloseTo(100, 6);
  });
});

describe("the published E-Mode inference counters", () => {
  // The reconstruction recovers most of the observed book, so a consumer has to be
  // able to see how much of the signal rests on inference rather than on published
  // parameters. A signal that hides its own inference is asking to be trusted
  // instead of checked.
  const emodePolicy = parseRiskPolicy(
    JSON.stringify({
      ...JSON.parse(POLICY_JSON),
      emode: { threshold: 0.95, groups: [[ETH, USDC]] },
    }),
  );

  // $100 of ETH collateral at 0.8 secures $85 of debt: contradicted at the published
  // threshold, solvent at 0.95. Both legs are in the group, so it qualifies.
  const contradicted = (account: string) => [
    pos(account, "aave-v3-eth", "COLLATERAL", ETH, 100),
    pos(account, "aave-v3-eth", "BORROWER", USDC, 85),
  ];

  it("counts the borrowers and debt whose numbers were reconstructed", () => {
    const s = run([...contradicted("0xa"), ...book("0xb", "aave-v3-eth", 400, 100)], emodePolicy);
    expect(s.emodeInferredBorrowers).toBe(1);
    expect(s.emodeInferredDebtUsd).toBe(85);
    // And the reconstructed book is now evaluable, which is the point of it.
    expect(s.evaluableDebtUsd).toBe(185);
  });

  it("counts nothing when the policy carries no groups, and drops the book instead", () => {
    const s = run([...contradicted("0xa"), ...book("0xb", "aave-v3-eth", 400, 100)]);
    expect(s.emodeInferredBorrowers).toBe(0);
    expect(s.emodeInferredDebtUsd).toBe(0);
    expect(s.debtUsd).toBe(185);
    expect(s.evaluableDebtUsd).toBe(100);
  });

  it("shocks the reconstructed book against the threshold it was measured at", () => {
    // The inconsistency this pins: establishing solvency at 0.95 and then shocking
    // against 0.8 would report distress the reconstruction had already ruled out. At
    // a 10% ETH shock the boundary is $90 x 0.95 = $85.5 against $85 of debt, so the
    // book survives; against 0.8 it would be $72 and would falsely liquidate.
    const s = run(contradicted("0xa"), emodePolicy);
    expect(s.shockLadder[0].shock).toBe(0.1);
    expect(s.shockLadder[0].distressedDebtUsd).toBe(0);
    // At 20% it genuinely fails: $80 x 0.95 = $76 < $85.
    expect(s.shockLadder[1].distressedDebtUsd).toBe(85);
  });

  it("keeps the inference out of the published signal's shape", () => {
    // The counters are aggregates. Nothing about *which* accounts were reconstructed
    // may reach the output.
    expect(() => assertAggregateOnly(run(contradicted("0xa"), emodePolicy))).not.toThrow();
  });
});

describe("k-anonymity suppression", () => {
  const pair = (n: number) => {
    const out: Position[] = [];
    for (let i = 0; i < n; i++) {
      out.push(
        ...book(`0xacct${i}`, "aave-v3-eth", 400, 100),
        ...book(`0xacct${i}`, "compound-v3-eth", 400, 100),
      );
    }
    return out;
  };

  it("publishes a bucket at exactly k", () => {
    const s = run(pair(3));
    expect(s.coupling).toEqual([
      { pair: "aave-v3-eth|compound-v3-eth", borrowers: 3, debtUsd: 600 },
    ]);
    expect(s.suppressedBuckets).toEqual([]);
  });

  it("suppresses below k but still reports that it suppressed", () => {
    // Silent suppression would understate coupling and read as good news. The
    // count is published because the reader needs to know a channel exists.
    const s = run(pair(2));
    expect(s.coupling).toEqual([]);
    expect(s.suppressedBuckets).toEqual([
      { pair: "aave-v3-eth|compound-v3-eth", borrowers: 2 },
    ]);
    // The headline aggregate is unaffected: it is not per-pair, so it does not
    // re-identify, and suppressing it would throw away the finding.
    expect(s.multiProtocolBorrowers).toBe(2);
  });
});

describe("assertAggregateOnly", () => {
  it("passes on a real signal", () => {
    expect(() => run(book("0xa", "aave-v3-eth", 400, 100))).not.toThrow();
  });

  it("rejects an address-shaped value anywhere in the tree", () => {
    expect(() => assertAggregateOnly({ nested: [{ worst: `whale ${ETH}` }] })).toThrow(
      /address-shaped value at signal.nested\[0\].worst/,
    );
  });

  it("rejects an address-shaped key, because a Record keyed by account still leaks", () => {
    expect(() => assertAggregateOnly({ debtByAccount: { [ETH]: 1_000_000 } })).toThrow(
      /address-shaped key/,
    );
  });

  it("is case-insensitive, so a checksummed address does not slip past", () => {
    const checksummed = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    expect(() => assertAggregateOnly({ a: checksummed })).toThrow(/address-shaped/);
  });

  it("guards the real output, not just a hand-built object", () => {
    const s = run(book("0xa", "aave-v3-eth", 400, 100));
    expect(s.version).toBe(SIGNAL_VERSION);
    expect(JSON.stringify(s)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

describe("the leak demo surface", () => {
  it("emits exactly what the enclave withholds, so the demo is not a mock-up", () => {
    // If this ever stops returning addresses, the leak demo has stopped
    // demonstrating anything and the enclave claim loses its evidence.
    const positions = [
      ...book("0xdeadbeef", "aave-v3-eth", 170, 100),
      ...book("0xdeadbeef", "compound-v3-eth", 170, 100),
    ];
    const rows = perAddressRowsForLeakDemoOnly(positions, policy);
    expect(rows).toHaveLength(1);
    expect(rows[0].account).toBe("0xdeadbeef");
    expect(rows[0].protocols).toEqual(["aave-v3-eth", "compound-v3-eth"]);
    expect(rows[0].topCollateralAsset).toBe(ETH);
    expect(rows[0].distressedAtShock).toBe(0.3);
    // And the guard would have stopped this from being published.
    expect(() => assertAggregateOnly(rows)).toThrow(/address-shaped/);
  });
});
