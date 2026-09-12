/**
 * The published signal's wire format: one encoder, one decoder, one field list.
 *
 * This lives in `lib/` rather than in the workflow because a consumer must not have
 * to install the CRE toolchain to read a Sentinel report. The workflow imports
 * `encodeSignal` from here; `consume.ts` imports `decodeSignal` from here; and
 * `docs/SIGNAL.md` documents `SIGNAL_ABI_PARAMS`. A second copy of the field list
 * anywhere would eventually disagree with the first, and the failure mode of a
 * disagreeing ABI decoder is not an error — it is plausible numbers in the wrong
 * fields.
 *
 * Shared with the enclave, so no `process`, no `fetch`, no Node built-ins: this has
 * to survive a WASM runtime.
 */

import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters } from "viem";
import type { SentinelSignal } from "./aggregate";

/**
 * The published field list.
 *
 * USD figures are scaled to 6 decimals and carried as integers because a consumer
 * contract cannot do arithmetic on a float, and rounding at the boundary is better
 * than rounding in Solidity. Shares and the score are basis points for the same
 * reason.
 *
 * Order is part of the contract: ABI tuples are positional, so appending is safe
 * and reordering is a breaking change even though the names look unchanged.
 */
export const SIGNAL_ABI_PARAMS =
  "string version, uint64 asOfBlock, uint32 borrowersObserved, uint256 debtUsd6, " +
  "uint256 evaluableDebtUsd6, uint256 multiProtocolDebtUsd6, uint16 multiProtocolShareBps, " +
  "uint16 leveredShareBps, uint16 worstShockBps, uint256 worstShockDistressedDebtUsd6, " +
  "uint16 systemicRiskScoreBps, uint16 couplingBuckets, uint16 suppressedBuckets, " +
  "uint32 emodeInferredBorrowers, uint256 emodeInferredDebtUsd6";

/** The signal as a consumer sees it, in the units the wire actually carries. */
export type DecodedSignal = {
  version: string;
  asOfBlock: bigint;
  borrowersObserved: number;
  debtUsd6: bigint;
  evaluableDebtUsd6: bigint;
  multiProtocolDebtUsd6: bigint;
  multiProtocolShareBps: number;
  leveredShareBps: number;
  worstShockBps: number;
  worstShockDistressedDebtUsd6: bigint;
  systemicRiskScoreBps: number;
  couplingBuckets: number;
  suppressedBuckets: number;
  emodeInferredBorrowers: number;
  emodeInferredDebtUsd6: bigint;
};

export function encodeSignal(signal: SentinelSignal): `0x${string}` {
  const worst = signal.shockLadder[signal.shockLadder.length - 1];
  return encodeAbiParameters(parseAbiParameters(SIGNAL_ABI_PARAMS), [
    signal.version,
    BigInt(asOfBlock(signal)),
    signal.borrowersObserved,
    usd6(signal.debtUsd),
    // The denominator every published share is taken against. Without it a consumer
    // can see `multiProtocolShareBps` but cannot tell what it is a share of, and the
    // obvious guess — `debtUsd6` — is the wrong one: books whose health factor
    // contradicts the chain are observed but not evaluated.
    usd6(signal.evaluableDebtUsd),
    usd6(signal.multiProtocolDebtUsd),
    bps(signal.multiProtocolShareOfDebt),
    bps(signal.leveredShareOfDebt),
    bps(worst?.shock ?? 0),
    usd6(worst?.distressedDebtUsd ?? 0),
    bps(signal.systemicRiskScore / 100),
    signal.coupling.length,
    signal.suppressedBuckets.length,
    // How much of the evaluable book rests on the E-Mode reconstruction rather than on
    // published risk parameters. Live, this is the majority of it, so a consumer that
    // cannot see it is trusting rather than checking.
    signal.emodeInferredBorrowers,
    usd6(signal.emodeInferredDebtUsd),
  ]);
}

export function decodeSignal(payload: `0x${string}`): DecodedSignal {
  // `SIGNAL_ABI_PARAMS` is a runtime concatenation, so viem cannot infer the tuple
  // type from it and the values arrive as `unknown`. The cast is checked by
  // `report.test.ts`, which round-trips a real signal and asserts every field.
  const v = decodeAbiParameters(parseAbiParameters(SIGNAL_ABI_PARAMS), payload) as [
    string,
    bigint,
    number,
    bigint,
    bigint,
    bigint,
    number,
    number,
    number,
    bigint,
    number,
    number,
    number,
    number,
    bigint,
  ];
  return {
    version: v[0],
    asOfBlock: v[1],
    borrowersObserved: v[2],
    debtUsd6: v[3],
    evaluableDebtUsd6: v[4],
    multiProtocolDebtUsd6: v[5],
    multiProtocolShareBps: v[6],
    leveredShareBps: v[7],
    worstShockBps: v[8],
    worstShockDistressedDebtUsd6: v[9],
    systemicRiskScoreBps: v[10],
    couplingBuckets: v[11],
    suppressedBuckets: v[12],
    emodeInferredBorrowers: v[13],
    emodeInferredDebtUsd6: v[14],
  };
}

/**
 * The oldest block any included deployment served.
 *
 * The minimum rather than the maximum: a consumer's staleness check has to be
 * against the least fresh input, or a single lagging deployment would be hidden
 * behind a fresh one.
 */
export function asOfBlock(signal: SentinelSignal): number {
  const numbers = Object.values(signal.blocks);
  return numbers.length === 0 ? 0 : Math.min(...numbers);
}

/** USD to 6 decimals. Guarded, because silently wrapping money is not an option. */
export function usd6(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error(`usd6: refusing to encode ${usd}`);
  const scaled = Math.round(usd * 1e6);
  if (!Number.isSafeInteger(scaled)) {
    throw new Error(`usd6: ${usd} exceeds exact integer range at 6 decimals`);
  }
  return BigInt(scaled);
}

/** A fraction in [0,1] to basis points, saturating rather than wrapping uint16. */
export function bps(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction < 0) throw new Error(`bps: refusing ${fraction}`);
  return Math.min(10_000, Math.round(fraction * 10_000));
}
