/**
 * Assemble and sign a report the way the DON does — for tests and the local demo.
 *
 * This is not part of the product. The real signer is a Chainlink DON: `f + 1` nodes
 * each holding a key Sentinel never sees, signing inside the enclave attestation.
 * Nothing here can substitute for that, and nothing here should ever run in
 * production — which is why it lives in its own file with this paragraph at the top
 * rather than as a helper inside `consume.ts`, where it would sit one careless import
 * away from being used to "verify" reports the consumer signed itself.
 *
 * What it is for: `consume.ts` makes claims about which reports it refuses, and those
 * claims are only worth something if they are tested against reports that are byte-
 * correct in every respect but one. Building those requires being able to produce a
 * valid one first.
 *
 * The layout is the CRE report format, read from the SDK's own implementation
 * (`@chainlink/cre-sdk/dist/sdk/report.js`). See `consume.ts` for the offsets.
 */

import { hexToBytes, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REPORT_METADATA_HEADER_LENGTH, reportHash, type SignedReport } from "./consume";

export type ReportFields = {
  version?: number;
  executionId?: Hex;
  /** Seconds. */
  timestamp?: number;
  donId?: number;
  donConfigVersion?: number;
  workflowId?: Hex;
  /** Truncated or NUL-padded to ten bytes, as the header requires. */
  workflowName: string;
  workflowOwner: Address;
  reportId?: number;
  /** The ABI-encoded signal, from `encodeSignal`. */
  body: Hex;
};

/** Build the 109-byte metadata header followed by the body. */
export function buildRawReport(fields: ReportFields): Uint8Array {
  const body = hexToBytes(fields.body);
  const raw = new Uint8Array(REPORT_METADATA_HEADER_LENGTH + body.length);
  const view = new DataView(raw.buffer);

  const put = (offset: number, bytes: Uint8Array, length: number) => {
    if (bytes.length !== length) {
      throw new Error(`report field at offset ${offset} is ${bytes.length} bytes, need ${length}`);
    }
    raw.set(bytes, offset);
  };

  raw[0] = fields.version ?? 1;
  put(1, hexToBytes(fields.executionId ?? `0x${"11".repeat(32)}`), 32);
  view.setUint32(33, fields.timestamp ?? Math.floor(Date.now() / 1000), false);
  view.setUint32(37, fields.donId ?? 1, false);
  view.setUint32(41, fields.donConfigVersion ?? 1, false);
  put(45, hexToBytes(fields.workflowId ?? `0x${"22".repeat(32)}`), 32);

  // Fixed ten bytes, NUL-padded. The workflow name is part of what a consumer
  // authenticates, so a name that does not fit is an error rather than something to
  // silently shorten.
  const name = new TextEncoder().encode(fields.workflowName);
  if (name.length > 10) {
    throw new Error(`workflow name ${JSON.stringify(fields.workflowName)} exceeds ten bytes`);
  }
  raw.set(name, 77);

  put(87, hexToBytes(fields.workflowOwner), 20);
  view.setUint16(107, fields.reportId ?? 1, false);
  raw.set(body, REPORT_METADATA_HEADER_LENGTH);
  return raw;
}

/** A DON's config digest and sequence number, in the shape the signature covers. */
export function buildReportContext(configDigest: Hex, seqNr: bigint): Uint8Array {
  const context = new Uint8Array(64);
  context.set(hexToBytes(configDigest), 0);
  new DataView(context.buffer).setBigUint64(56, seqNr, false);
  return context;
}

export type SigningKey = Hex;

/**
 * Sign a report with each key, producing the `f + 1` attributed signatures a real
 * report carries.
 *
 * Signs the same hash `consume.ts` recomputes, by calling the same function: if the
 * two ever disagreed, the tests would pass against a hash nobody else produces.
 */
export async function signReport(
  rawReport: Uint8Array,
  reportContext: Uint8Array,
  keys: SigningKey[],
): Promise<SignedReport> {
  const hash = reportHash({ rawReport, reportContext, signatures: [] });
  const signatures = await Promise.all(
    keys.map(async (key) => hexToBytes(await privateKeyToAccount(key).sign({ hash }))),
  );
  return { rawReport, reportContext, signatures };
}

/** The address a signing key will recover to. */
export function signerAddress(key: SigningKey): Address {
  return privateKeyToAccount(key).address;
}

/**
 * A deterministic key set, so a test's expected signers can be written down.
 *
 * Test keys with no funds and no purpose beyond this file. They are printed in test
 * output and committed to git, which is exactly why they must never be reused.
 */
export function devSigningKeys(count: number): SigningKey[] {
  return Array.from({ length: count }, (_, i) =>
    keccak256(toHex(`sentinel-dev-signer-${i}`)),
  );
}
