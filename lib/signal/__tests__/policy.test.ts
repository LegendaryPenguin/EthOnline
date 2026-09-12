/**
 * Tests for the confidential risk policy parser.
 *
 * The policy arrives as an opaque string from a Vault DON secret, so it is the one
 * input to the enclave that no compiler checked. Everything here is a case where a
 * quietly accepted policy would publish a signal under weights nobody chose —
 * which is worse than a failed run, because a failed run is visible.
 */

import { describe, expect, it } from "vitest";
import { betaFor, parseRiskPolicy } from "../policy";

const ETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const WSTETH = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";

const valid = {
  shocks: [0.1, 0.2, 0.3],
  assetBeta: { [ETH]: 1.2 },
  defaultBeta: 1,
  kAnonymity: 5,
  weights: { concentration: 0.5, leverage: 0.2, distress: 0.3 },
  leverageWatchLevel: 1.5,
  emode: { threshold: 0.95, groups: [[ETH, WSTETH]] },
};
const withOverride = (patch: Record<string, unknown>) =>
  JSON.stringify({ ...valid, ...patch });

describe("parseRiskPolicy", () => {
  it("accepts a well-formed policy", () => {
    const p = parseRiskPolicy(JSON.stringify(valid));
    expect(p.shocks).toEqual([0.1, 0.2, 0.3]);
    expect(p.kAnonymity).toBe(5);
    expect(betaFor(p, ETH)).toBe(1.2);
    expect(betaFor(p, "0x0000000000000000000000000000000000000000")).toBe(1);
    expect(p.emode).toEqual({ threshold: 0.95, groups: [[ETH, WSTETH]] });
  });

  it("accepts an empty group list, which turns the reconstruction off", () => {
    // Explicitly supported, and explicitly not the same as omitting the field: a
    // signal published with E-Mode disabled is a different signal, and nobody
    // should arrive there by forgetting to write it down.
    const p = parseRiskPolicy(withOverride({ emode: { threshold: 0.95, groups: [] } }));
    expect(p.emode.groups).toEqual([]);
  });

  it("rejects an emode threshold that is not below 1", () => {
    // At or above 1 a book could borrow more than its collateral is worth and still
    // read as solvent. That is not a lenient risk parameter, it is a broken one.
    expect(() =>
      parseRiskPolicy(withOverride({ emode: { threshold: 1, groups: [[ETH, WSTETH]] } })),
    ).toThrow(/not below 1/);
    expect(() =>
      parseRiskPolicy(withOverride({ emode: { threshold: 0, groups: [] } })),
    ).toThrow(/must be positive/);
  });

  it("rejects a one-asset emode group", () => {
    // A group of one cannot express a correlated *pair*; it would silently lift the
    // threshold on every single-asset book, the opposite of what E-Mode means.
    expect(() =>
      parseRiskPolicy(withOverride({ emode: { threshold: 0.95, groups: [[ETH]] } })),
    ).toThrow(/at least two assets/);
  });

  it("rejects an emode asset that is not a lowercased address", () => {
    expect(() =>
      parseRiskPolicy(
        withOverride({
          emode: { threshold: 0.95, groups: [[ETH, "0x7F39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"]] },
        }),
      ),
    ).toThrow(/non-lowercased address/);
  });

  it("rejects an asset appearing in two emode groups", () => {
    // Otherwise the threshold applied depends on group order, and a silently
    // order-dependent risk parameter is not a risk parameter.
    expect(() =>
      parseRiskPolicy(
        withOverride({ emode: { threshold: 0.95, groups: [[ETH, WSTETH], [ETH, WBTC]] } }),
      ),
    ).toThrow(/appears in emode.groups\[0\] and \[1\]/);
  });

  it("rejects weights that do not sum to 1", () => {
    // Without this the composite score is unbounded and its units are undefined,
    // so a published "42" would not mean 42% of anything.
    expect(() =>
      parseRiskPolicy(withOverride({ weights: { concentration: 1, leverage: 1, distress: 1 } })),
    ).toThrow(/sum to 3, not 1/);
  });

  it("rejects unordered shocks, because the published ladder claims monotonicity", () => {
    expect(() => parseRiskPolicy(withOverride({ shocks: [0.3, 0.1] }))).toThrow(/ascending/);
  });

  it("rejects a shock outside (0,1)", () => {
    expect(() => parseRiskPolicy(withOverride({ shocks: [1.5] }))).toThrow(/outside \(0,1\)/);
    expect(() => parseRiskPolicy(withOverride({ shocks: [0] }))).toThrow(/outside \(0,1\)/);
  });

  it("rejects k below 2, which would suppress nothing while claiming to", () => {
    expect(() => parseRiskPolicy(withOverride({ kAnonymity: 1 }))).toThrow(/suppresses nothing/);
  });

  it("rejects a non-integer k", () => {
    expect(() => parseRiskPolicy(withOverride({ kAnonymity: 2.5 }))).toThrow(/integer/);
  });

  it("rejects a beta key that is not a lowercased address", () => {
    // Betas are looked up by the normalizer's lowercased assetId, so a checksummed
    // key would silently never match and every asset would take the default.
    expect(() =>
      parseRiskPolicy(withOverride({ assetBeta: { "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": 1 } })),
    ).toThrow(/not a lowercased address/);
    expect(() => parseRiskPolicy(withOverride({ assetBeta: { WETH: 1 } }))).toThrow(
      /not a lowercased address/,
    );
  });

  it("supplies no defaults for a missing field", () => {
    for (const field of [
      "shocks",
      "assetBeta",
      "defaultBeta",
      "kAnonymity",
      "weights",
      "leverageWatchLevel",
      "emode",
    ]) {
      const partial: Record<string, unknown> = { ...valid };
      delete partial[field];
      expect(() => parseRiskPolicy(JSON.stringify(partial)), field).toThrow();
    }
  });

  it("fails loudly on malformed JSON rather than yielding an empty policy", () => {
    expect(() => parseRiskPolicy("not json")).toThrow(/not valid JSON/);
    expect(() => parseRiskPolicy("[]")).toThrow();
    expect(() => parseRiskPolicy("null")).toThrow(/must be a JSON object/);
  });
});
