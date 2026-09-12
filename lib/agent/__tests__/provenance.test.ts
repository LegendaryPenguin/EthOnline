/**
 * The citation invariant, on constructed cases.
 *
 * This is the check that makes the transcript evidence rather than prose, so its own
 * failure modes matter: a checker that accepted everything would pass silently forever,
 * and a checker that rejected protocol names would push the tools into paraphrasing them.
 * Both directions are tested.
 */

import { describe, expect, it } from "vitest";
import { cite, pct, renderCitations, unsourcedNumbers, usd } from "../provenance";

const SRC = [{ deployment: "aave-v3-eth", subgraphId: "Qm123", block: 25_000_000 }];

describe("cite", () => {
  it("refuses a citation with no source", () => {
    // A Cited with no provenance is a number with a paper trail that goes nowhere, which
    // is worse than an uncited one because it looks checked.
    expect(() => cite("score", 1, "1", [])).toThrow(/no sources/);
  });
});

describe("unsourcedNumbers", () => {
  it("passes an answer assembled from citations", () => {
    const c = cite("debt", 1_234_567, usd(1_234_567), SRC);
    expect(unsourcedNumbers(`Observed debt is ${c.text}.`, [c])).toEqual([]);
  });

  it("catches a number that was rounded on the way into prose", () => {
    // The specific failure a language model produces without being asked to: the figure is
    // nearly right, reads better, and is not what was measured.
    const c = cite("share", 0.0143, pct(0.0143), SRC);
    expect(unsourcedNumbers("About 1.4% of debt.", [c])).toEqual(["1.4"]);
  });

  it("accepts the block a citation was read at", () => {
    const c = cite("score", 22.01, "22.01", SRC);
    expect(unsourcedNumbers("Score 22.01 at block 25000000.", [c])).toEqual([]);
  });

  it("accepts a number the question supplied", () => {
    // A shock scenario is parameterised by the caller's number, which is sourced — just
    // not from a subgraph.
    const c = cite("distressed", 5, "5", SRC);
    expect(
      unsourcedNumbers("A 15% drop distresses 5 borrowers.", [c], "what if stETH drops 15%"),
    ).toEqual([]);
  });

  it("ignores digits welded to letters, because those are names", () => {
    const c = cite("count", 4, "4", SRC);
    expect(
      unsourcedNumbers("4 deployments: aave-v3-eth, compound-v2-eth, morpho-aave-v2-eth.", [c]),
    ).toEqual([]);
  });

  it("still catches a bare number beside a name", () => {
    // The guard above must not turn into a blanket exemption for anything near a word.
    const c = cite("count", 4, "4", SRC);
    expect(unsourcedNumbers("4 deployments carrying 900 positions.", [c])).toEqual(["900"]);
  });

  it("treats trailing zeros as the same number", () => {
    const c = cite("share", 0.014, "1.40%", SRC);
    expect(unsourcedNumbers("1.4% of debt.", [c])).toEqual([]);
  });

  it("is not vacuous: an empty citation list rejects any number", () => {
    expect(unsourcedNumbers("The score is 22.01.", [])).toEqual(["22.01"]);
  });
});

describe("renderCitations", () => {
  it("names the subgraph and the block for every row", () => {
    const table = renderCitations([cite("debt", 1, "$1", SRC)]);
    expect(table).toContain("aave-v3-eth");
    expect(table).toContain("Qm123");
    expect(table).toContain("25000000");
  });
});

describe("formatters", () => {
  it("renders whole dollars with separators", () => {
    expect(usd(1_234_567.8)).toBe("$1,234,568");
  });

  it("renders a fraction as a percentage", () => {
    expect(pct(0.01432)).toBe("1.43%");
    expect(pct(0.1, 0)).toBe("10%");
  });
});
