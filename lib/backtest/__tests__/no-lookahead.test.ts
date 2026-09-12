/**
 * The one property a backtest cannot be trusted without.
 *
 * A backtest that reads a single field from after the decision point produces a
 * beautiful result and means nothing, and the failure is silent — the numbers look
 * better, not broken. So this is asserted mechanically rather than reviewed: the
 * scoring path builds query documents, and every block argument in every document
 * must equal the block that was asked for, with no `liquidates` selection anywhere.
 *
 * The documents are the right thing to test because they are the entire interface
 * between the scorer and the past. `signalAtBlock` cannot see anything it did not
 * ask for, and what it asks for is these strings.
 */

import { describe, expect, it } from "vitest";
import {
  atBlockArg,
  completeBooksQuery,
  enclaveBootstrapQuery,
  ENCLAVE_BOOTSTRAP_QUERY,
  topPositionsQuery,
} from "../../signal/enclave-queries";
import { LIQUIDATIONS_WINDOW_QUERY } from "../replay";

const BLOCK = 25_500_000;
const MARKETS = ["0xaaaa", "0xbbbb", "market-1:2"];

/** Every `block: { number: N }` in a document, as numbers. */
function blockArgs(document: string): number[] {
  return [...document.matchAll(/block:\s*\{\s*number:\s*(\d+)\s*\}/g)].map((m) => Number(m[1]));
}

const historical = [
  enclaveBootstrapQuery(BLOCK),
  topPositionsQuery("3.1.0", MARKETS, 40, BLOCK),
  completeBooksQuery("3.1.0", BLOCK),
  // 2.0.1 takes a different position selection, so it is a different document and
  // needs the same guarantee rather than the same reasoning.
  topPositionsQuery("2.0.1", MARKETS, 40, BLOCK),
  completeBooksQuery("2.0.1", BLOCK),
];

describe("no lookahead", () => {
  it("pins every pass to exactly the requested block", () => {
    for (const document of historical) {
      const blocks = blockArgs(document);
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) expect(b).toBe(BLOCK);
    }
  });

  it("never selects liquidation events in the scoring path", () => {
    // The labels come from `lib/backtest/replay.ts`. If a `liquidates` selection ever
    // appears in a document the scorer sends, the outcome is inside the input.
    //
    // Matched as an entity name at the start of a selection rather than as a
    // substring: `liquidationThreshold` and `liquidationPenalty` are risk parameters
    // the scorer legitimately needs, and a bare /liquidat/ would reject them and make
    // this test a nuisance instead of a guarantee.
    for (const document of historical) {
      expect(document).not.toMatch(/\bliquidates?\s*[({]/);
      expect(document).not.toMatch(/\bliquidatee\b/);
    }
  });

  it("has a guard that actually catches a lookahead", () => {
    // A negative assertion is only worth what its positive control is worth. The real
    // label query is fed to the same two patterns; if they stop matching it, the test
    // above has quietly become vacuous.
    expect(LIQUIDATIONS_WINDOW_QUERY).toMatch(/\bliquidates?\s*[({]/);
    expect(LIQUIDATIONS_WINDOW_QUERY).toMatch(/\bliquidatee\b/);
  });

  it("asks for no block at all on the live path", () => {
    expect(blockArgs(ENCLAVE_BOOTSTRAP_QUERY)).toEqual([]);
    expect(blockArgs(topPositionsQuery("3.1.0", MARKETS, 40))).toEqual([]);
    expect(blockArgs(completeBooksQuery("3.1.0"))).toEqual([]);
  });

  it("leaves the live documents byte-identical to the no-argument build", () => {
    // The enclave ships these. Adding history to the backtest must not have changed
    // a single byte of what runs in the TEE, or the backtest is measuring something
    // adjacent to the product.
    expect(ENCLAVE_BOOTSTRAP_QUERY).toBe(enclaveBootstrapQuery());
    expect(topPositionsQuery("3.1.0", MARKETS, 40)).toBe(
      topPositionsQuery("3.1.0", MARKETS, 40, undefined),
    );
  });

  it("refuses a block that is not a positive integer", () => {
    // A `NaN` reaching the document renders as `block: { number: NaN }`, which the
    // gateway rejects — but a `0` renders as a valid query for genesis and would
    // silently score every window identically.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => atBlockArg(bad)).toThrow(/refusing/);
    }
  });
});
