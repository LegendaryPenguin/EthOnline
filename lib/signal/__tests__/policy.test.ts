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

const valid = {
  shocks: [0.1, 0.2, 0.3],
  assetBeta: { [ETH]: 1.2 },
  defaultBeta: 1,
  kAnonymity: 5,
  weights: { concentration: 0.5, leverage: 0.2, distress: 0.3 },
  leverageWatchLevel: 1.5,
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
    for (const field of ["shocks", "assetBeta", "defaultBeta", "kAnonymity", "weights", "leverageWatchLevel"]) {
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
