/**
 * The consumer side: read a Sentinel report, or refuse it.
 *
 * The enclave's guarantee ends the moment the report leaves it. From there the
 * report is just bytes travelling over an untrusted path, and a consumer that
 * decodes bytes without authenticating them has gained nothing from the TEE at all
 * — it would act on a number anyone could have written. So this module is the other
 * half of the confidentiality claim, and every check below exists because skipping
 * it turns Sentinel into a signal an attacker controls.
 *
 * What a CRE report actually is, taken from the SDK's own `Report` implementation
 * (`@chainlink/cre-sdk/dist/sdk/report.js`) so this stays compatible with the real
 * wire format rather than a convenient invention:
 *
 *   rawReport      109-byte metadata header, then the ABI-encoded body
 *   reportContext  the DON's config digest and sequence number
 *   sigs           ECDSA signatures over keccak256(keccak256(rawReport) ‖ context)
 *
 * The header is what makes the signature meaningful. A valid signature over an
 * anonymous blob proves only that *some* workflow produced it, so a consumer that
 * checks signatures but not `workflowOwner` and `workflowName` will accept any
 * report from any workflow the same DON happens to run — including one an attacker
 * deployed themselves. That is the subtle version of accepting a forgery, and it is
 * why `verifySignalReport` requires both.
 *
 * Deliberately free of the CRE SDK: a downstream consumer must not have to install
 * the workflow toolchain to read a signal. viem only, so this same code runs in a
 * webhook, a CLI, or the app.
 */

import { concatHex, keccak256, recoverAddress, toHex, type Address } from "viem";
import { decodeSignal, type DecodedSignal } from "./report";
import { SIGNAL_VERSION } from "./aggregate";

/** Fixed by the CRE report format. */
export const REPORT_METADATA_HEADER_LENGTH = 109;

const OFFSETS = {
  version: 0,
  executionId: 1,
  timestamp: 33,
  donId: 37,
  donConfigVersion: 41,
  workflowId: 45,
  workflowName: 77,
  workflowOwner: 87,
  reportId: 107,
} as const;

export type ReportHeader = {
  version: number;
  executionId: `0x${string}`;
  /** Seconds. When the DON produced the report, not when the data was read. */
  timestamp: number;
  donId: number;
  donConfigVersion: number;
  workflowId: `0x${string}`;
  /** Ten bytes, right-padded with zeros in the header. */
  workflowName: string;
  workflowOwner: Address;
  reportId: number;
};

export type SignedReport = {
  rawReport: Uint8Array;
  reportContext: Uint8Array;
  /** 65-byte r‖s‖v signatures. v may be 0/1 or 27/28. */
  signatures: Uint8Array[];
};

export type ConsumerPolicy = {
  /**
   * Addresses permitted to sign. The DON's signer set, read from the capabilities
   * registry in production; supplied explicitly here so a consumer can pin it.
   */
  signers: Address[];
  /**
   * Byzantine fault tolerance parameter. `f + 1` distinct known signers are
   * required, matching the DON's own quorum rule.
   */
  f: number;
  /** The workflow owner this consumer trusts. Case-insensitive. */
  workflowOwner: Address;
  /** The workflow name this consumer trusts. */
  workflowName: string;
  /**
   * Maximum age of the signal's own `asOfBlock`, in blocks, against `currentBlock`.
   *
   * Staleness is checked against the block the *data* was read at, not the report's
   * timestamp: a DON can re-sign a stale reading at any time, so the timestamp says
   * when someone last spoke and the block says when the world was last observed.
   */
  maxBlockAge: bigint;
  /** The signal version this consumer knows how to interpret. */
  expectedVersion?: string;
};

export class ReportRejected extends Error {
  constructor(reason: string) {
    super(`report rejected: ${reason}`);
    this.name = "ReportRejected";
  }
}

export function parseReportHeader(rawReport: Uint8Array): ReportHeader {
  if (rawReport.length < REPORT_METADATA_HEADER_LENGTH) {
    throw new ReportRejected(
      `raw report is ${rawReport.length} bytes, below the ${REPORT_METADATA_HEADER_LENGTH}-byte header`,
    );
  }
  const view = new DataView(rawReport.buffer, rawReport.byteOffset, rawReport.byteLength);
  const slice = (from: number, length: number) => rawReport.subarray(from, from + length);
  return {
    version: rawReport[OFFSETS.version],
    executionId: toHex(slice(OFFSETS.executionId, 32)),
    timestamp: view.getUint32(OFFSETS.timestamp, false),
    donId: view.getUint32(OFFSETS.donId, false),
    donConfigVersion: view.getUint32(OFFSETS.donConfigVersion, false),
    workflowId: toHex(slice(OFFSETS.workflowId, 32)),
    // Right-padded with NULs to a fixed ten bytes on the wire.
    workflowName: new TextDecoder().decode(slice(OFFSETS.workflowName, 10)).replace(/\0+$/, ""),
    workflowOwner: toHex(slice(OFFSETS.workflowOwner, 20)),
    reportId: view.getUint16(OFFSETS.reportId, false),
  };
}

/** The body: everything after the metadata header. */
export function reportBody(rawReport: Uint8Array): `0x${string}` {
  return toHex(rawReport.subarray(REPORT_METADATA_HEADER_LENGTH));
}

/** keccak256(keccak256(rawReport) ‖ reportContext), as the DON signs it. */
export function reportHash(report: SignedReport): `0x${string}` {
  return keccak256(
    concatHex([keccak256(toHex(report.rawReport)), toHex(report.reportContext)]),
  );
}

export type VerifiedSignal = {
  header: ReportHeader;
  signal: DecodedSignal;
  /** The distinct known signers whose signatures were accepted. */
  signers: Address[];
};

/**
 * Authenticate a report and decode the signal, or throw.
 *
 * Order is deliberate: cheap structural checks, then identity, then the expensive
 * signature recovery, then semantics. A consumer should never spend an ecrecover on
 * a report that names the wrong workflow — but more importantly, it must never
 * decode one either. Decoding before authenticating is how an attacker's numbers
 * end up in a log line that somebody later trusts.
 */
export async function verifySignalReport(
  report: SignedReport,
  policy: ConsumerPolicy,
  currentBlock: bigint,
): Promise<VerifiedSignal> {
  if (policy.f < 0) throw new ReportRejected(`consumer policy has f = ${policy.f}`);
  const required = policy.f + 1;
  if (policy.signers.length < required) {
    // Otherwise quorum is unreachable and every report fails for a reason that
    // looks like an attack but is a misconfiguration.
    throw new ReportRejected(
      `consumer policy lists ${policy.signers.length} signers but requires ${required}`,
    );
  }

  const header = parseReportHeader(report.rawReport);

  if (header.workflowOwner.toLowerCase() !== policy.workflowOwner.toLowerCase()) {
    throw new ReportRejected(
      `workflow owner ${header.workflowOwner} is not the trusted ${policy.workflowOwner}`,
    );
  }
  if (header.workflowName !== policy.workflowName) {
    // A correctly signed report from the wrong workflow. The DON signs whatever it
    // runs, so without this check an attacker only needs to deploy their own.
    throw new ReportRejected(
      `workflow name ${JSON.stringify(header.workflowName)} is not the trusted ` +
        JSON.stringify(policy.workflowName),
    );
  }

  const allowed = new Map(policy.signers.map((s) => [s.toLowerCase(), s]));
  const hash = reportHash(report);
  const accepted: Address[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];

  for (const signature of report.signatures) {
    if (signature.length !== 65) {
      problems.push(`signature of ${signature.length} bytes, expected 65`);
      continue;
    }
    // Both encodings appear in the wild: 27/28 from Ethereum tooling, 0/1 from the
    // raw recovery id.
    const normalized = new Uint8Array(signature);
    if (normalized[64] === 27 || normalized[64] === 28) normalized[64] -= 27;

    let recovered: Address;
    try {
      recovered = await recoverAddress({ hash, signature: toHex(normalized) });
    } catch {
      problems.push("signature did not recover");
      continue;
    }

    // Worth knowing when reading the rejection messages: ECDSA recovery over the wrong
    // bytes does not fail, it succeeds and yields an unrelated address. So a tampered
    // report surfaces as "unknown signer", not as "bad signature" — the signer set is
    // what catches it, which is why pinning that set is not optional.
    const key = recovered.toLowerCase();
    if (seen.has(key)) {
      // A quorum of one signer repeated is not a quorum. Counting duplicates would
      // let a single compromised node satisfy f + 1 on its own.
      problems.push(`duplicate signer ${recovered}`);
      continue;
    }
    seen.add(key);

    const known = allowed.get(key);
    if (!known) {
      problems.push(`unknown signer ${recovered}`);
      continue;
    }
    accepted.push(known);
  }

  if (accepted.length < required) {
    throw new ReportRejected(
      `${accepted.length} of ${required} required signatures verified` +
        (problems.length > 0 ? `: ${problems.join("; ")}` : ""),
    );
  }

  const signal = decodeSignal(reportBody(report.rawReport));

  const expectedVersion = policy.expectedVersion ?? SIGNAL_VERSION;
  if (signal.version !== expectedVersion) {
    // Field order is part of the ABI, so a consumer reading a later schema with an
    // earlier decoder gets plausible numbers in the wrong slots rather than an
    // error. Refusing an unknown version is the only safe response.
    throw new ReportRejected(
      `signal version ${JSON.stringify(signal.version)} is not ${JSON.stringify(expectedVersion)}`,
    );
  }

  if (signal.asOfBlock === 0n) {
    throw new ReportRejected("signal carries no block; its provenance is unverifiable");
  }
  if (signal.asOfBlock > currentBlock) {
    // A future block means the report is describing a state the chain has not
    // reached, which is either a clock problem or a fabrication. Either way it is
    // not something to act on.
    throw new ReportRejected(
      `signal is from block ${signal.asOfBlock}, ahead of the current ${currentBlock}`,
    );
  }
  const age = currentBlock - signal.asOfBlock;
  if (age > policy.maxBlockAge) {
    throw new ReportRejected(
      `signal is ${age} blocks old, past the ${policy.maxBlockAge}-block limit`,
    );
  }

  return { header, signal, signers: accepted };
}

/**
 * Human-readable units, for a consumer that reports rather than transacts.
 *
 * Kept separate from verification on purpose: this must be unreachable for a report
 * that has not been verified, and the type system enforces that by only accepting a
 * `VerifiedSignal`.
 */
export function describeSignal({ header, signal }: VerifiedSignal): string {
  const usd = (v: bigint) => `$${(Number(v) / 1e6).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  })}`;
  return [
    `${signal.version} from ${header.workflowName}`,
    `block ${signal.asOfBlock}`,
    `score ${(signal.systemicRiskScoreBps / 100).toFixed(1)}/100`,
    `${signal.borrowersObserved} borrowers`,
    `${usd(signal.evaluableDebtUsd6)} evaluable of ${usd(signal.debtUsd6)} observed`,
    `${(signal.multiProtocolShareBps / 100).toFixed(2)}% multi-protocol`,
    `${usd(signal.worstShockDistressedDebtUsd6)} distressed at a ` +
      `${(signal.worstShockBps / 100).toFixed(0)}% shock`,
    `${signal.emodeInferredBorrowers} borrowers reconstructed via E-Mode`,
  ].join(", ");
}
