/**
 * What the consumer refuses.
 *
 * The value of the enclave is entirely conditional on this: a signal nobody
 * authenticates is a signal anybody can write, and then the TEE protected the
 * computation while the output stayed forgeable. So each test below takes a report
 * that verifies, changes exactly one thing, and asserts the change is caught. One
 * mutation at a time is the point — a fixture that is wrong in two ways can pass for
 * the wrong reason.
 */

import { describe, expect, it } from "vitest";
import { toHex, type Address, type Hex } from "viem";
import { aggregateSignal, SIGNAL_VERSION } from "../aggregate";
import { parseRiskPolicy } from "../policy";
import { encodeSignal } from "../report";
import {
  buildRawReport,
  buildReportContext,
  devSigningKeys,
  signerAddress,
  signReport,
} from "../dev-sign";
import {
  describeSignal,
  parseReportHeader,
  REPORT_METADATA_HEADER_LENGTH,
  reportBody,
  verifySignalReport,
  type ConsumerPolicy,
  type SignedReport,
} from "../consume";
import type { Position } from "../../exposure/types";

const ETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const WORKFLOW_NAME = "sentinel";
const OWNER: Address = "0x00000000000000000000000000000000000000a1";
const CONFIG_DIGEST: Hex = `0x${"33".repeat(32)}`;

/** Four DON keys with f = 1, so quorum is two and there is slack to test against. */
const KEYS = devSigningKeys(4);
const SIGNERS = KEYS.map(signerAddress);

const BLOCK = 1_000_000n;

const riskPolicy = parseRiskPolicy(
  JSON.stringify({
    shocks: [0.1, 0.2, 0.3],
    assetBeta: { [ETH]: 1, [USDC]: 0.01 },
    defaultBeta: 1,
    kAnonymity: 3,
    weights: { concentration: 0.5, leverage: 0.25, distress: 0.25 },
    leverageWatchLevel: 1.5,
    emode: { threshold: 0.95, groups: [] },
  }),
);

let seq = 0;
function pos(account: string, protocol: string, side: Position["side"], assetId: string, v: number) {
  return {
    id: `p${seq++}`,
    protocol,
    account,
    side,
    assetId,
    assetSymbol: assetId === ETH ? "WETH" : "USDC",
    amount: v,
    valueUsd: v,
    liquidationThreshold: side === "BORROWER" ? 0 : 0.8,
    maximumLtv: 0.75,
    marketId: `${protocol}-${assetId}`,
  } satisfies Position;
}

function signalBody(block: number): Hex {
  const positions: Position[] = [];
  for (let i = 0; i < 3; i++) {
    positions.push(
      pos(`0xa${i}`, "aave-v3-eth", "COLLATERAL", ETH, 400),
      pos(`0xa${i}`, "aave-v3-eth", "BORROWER", USDC, 100),
      pos(`0xa${i}`, "compound-v3-eth", "COLLATERAL", ETH, 400),
      pos(`0xa${i}`, "compound-v3-eth", "BORROWER", USDC, 100),
    );
  }
  return encodeSignal(
    aggregateSignal({
      positions,
      blocks: { "aave-v3-eth": block, "compound-v3-eth": block },
      reportedDebtUsd: { "aave-v3-eth": 1_000_000, "compound-v3-eth": 1_000_000 },
      policy: riskPolicy,
    }),
  );
}

const consumerPolicy: ConsumerPolicy = {
  signers: SIGNERS,
  f: 1,
  workflowOwner: OWNER,
  workflowName: WORKFLOW_NAME,
  maxBlockAge: 100n,
};

type Overrides = {
  workflowName?: string;
  workflowOwner?: Address;
  body?: Hex;
  block?: number;
  keys?: Hex[];
};

async function report(overrides: Overrides = {}): Promise<SignedReport> {
  const rawReport = buildRawReport({
    workflowName: overrides.workflowName ?? WORKFLOW_NAME,
    workflowOwner: overrides.workflowOwner ?? OWNER,
    body: overrides.body ?? signalBody(overrides.block ?? Number(BLOCK)),
  });
  return signReport(
    rawReport,
    buildReportContext(CONFIG_DIGEST, 7n),
    overrides.keys ?? KEYS.slice(0, 2),
  );
}

const verify = (r: SignedReport, p: ConsumerPolicy = consumerPolicy, block = BLOCK) =>
  verifySignalReport(r, p, block);

describe("verifySignalReport", () => {
  it("accepts a well-formed report and returns the decoded signal", async () => {
    const verified = await verify(await report());
    expect(verified.header.workflowName).toBe(WORKFLOW_NAME);
    expect(verified.header.workflowOwner.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(verified.signal.version).toBe(SIGNAL_VERSION);
    expect(verified.signal.asOfBlock).toBe(BLOCK);
    expect(verified.signal.borrowersObserved).toBe(3);
    expect(verified.signers).toHaveLength(2);
    // And it names *which* signers, so a consumer can log the quorum it accepted.
    expect(new Set(verified.signers.map((s) => s.toLowerCase())).size).toBe(2);
  });

  it("accepts more signatures than quorum requires", async () => {
    const verified = await verify(await report({ keys: KEYS }));
    expect(verified.signers).toHaveLength(4);
  });

  it("rejects a report body altered after signing", async () => {
    // The tampered-attestation case. One byte of the body is flipped, leaving the
    // signatures valid over the original bytes and therefore invalid over these.
    const original = await report();
    const tampered = new Uint8Array(original.rawReport);
    tampered[tampered.length - 1] ^= 0x01;
    await expect(verify({ ...original, rawReport: tampered })).rejects.toThrow(
      /0 of 2 required signatures verified/,
    );
  });

  it("rejects a header altered after signing", async () => {
    // Not just the numbers: the provenance is signed too, so an attacker cannot
    // relabel a genuine report as coming from a different workflow.
    const original = await report();
    const tampered = new Uint8Array(original.rawReport);
    tampered[37] ^= 0xff; // donId
    await expect(verify({ ...original, rawReport: tampered })).rejects.toThrow(
      /required signatures verified/,
    );
  });

  it("rejects a report signed under a different report context", async () => {
    // The context carries the config digest and sequence number, so a replay into a
    // different DON configuration — or at a different sequence — fails.
    const original = await report();
    await expect(
      verify({ ...original, reportContext: buildReportContext(CONFIG_DIGEST, 8n) }),
    ).rejects.toThrow(/required signatures verified/);
  });

  it("rejects signatures from keys outside the DON's signer set", async () => {
    const outsiders = devSigningKeys(6).slice(4);
    await expect(verify(await report({ keys: outsiders }))).rejects.toThrow(/unknown signer/);
  });

  it("does not count one signer twice toward quorum", async () => {
    // Otherwise a single compromised node reaches f + 1 alone, which is the whole
    // fault-tolerance assumption gone.
    const one = await report({ keys: [KEYS[0]] });
    const doubled = { ...one, signatures: [one.signatures[0], one.signatures[0]] };
    await expect(verify(doubled)).rejects.toThrow(/duplicate signer/);
    await expect(verify(doubled)).rejects.toThrow(/1 of 2 required/);
  });

  it("rejects a quorum short by one", async () => {
    await expect(verify(await report({ keys: [KEYS[0]] }))).rejects.toThrow(/1 of 2 required/);
  });

  it("rejects a report with no signatures at all", async () => {
    const unsigned = await report();
    await expect(verify({ ...unsigned, signatures: [] })).rejects.toThrow(/0 of 2 required/);
  });

  it("rejects a malformed signature without letting it stop the others", async () => {
    const valid = await report({ keys: KEYS.slice(0, 3) });
    const withJunk = { ...valid, signatures: [new Uint8Array(10), ...valid.signatures] };
    // Quorum is still reached, so a bad signature is noted rather than fatal.
    expect((await verify(withJunk)).signers).toHaveLength(3);
  });

  it("normalizes a v of 27/28, because both encodings are in use", async () => {
    const signed = await report();
    // viem signs with v = 27/28; assert that is what we are actually normalizing,
    // so this test cannot pass vacuously.
    expect(signed.signatures.every((s) => s[64] === 27 || s[64] === 28)).toBe(true);
    const raw01 = signed.signatures.map((s) => {
      const copy = new Uint8Array(s);
      copy[64] -= 27;
      return copy;
    });
    expect((await verify({ ...signed, signatures: raw01 })).signers).toHaveLength(2);
  });

  it("rejects a correctly signed report from the wrong workflow", async () => {
    // The subtle forgery: the DON signs whatever it runs, so without this check an
    // attacker deploys their own workflow and gets a real signature on their numbers.
    await expect(verify(await report({ workflowName: "attacker" }))).rejects.toThrow(
      /workflow name "attacker" is not the trusted "sentinel"/,
    );
  });

  it("rejects a report from an untrusted workflow owner", async () => {
    const other: Address = "0x00000000000000000000000000000000000000b2";
    await expect(verify(await report({ workflowOwner: other }))).rejects.toThrow(
      /is not the trusted/,
    );
  });

  it("accepts a differently-cased owner, because case is not identity", async () => {
    const upper = OWNER.toUpperCase().replace("0X", "0x") as Address;
    await expect(verify(await report(), { ...consumerPolicy, workflowOwner: upper })).resolves
      .toBeDefined();
  });

  it("rejects a stale signal", async () => {
    const stale = await report({ block: Number(BLOCK) - 500 });
    await expect(verify(stale)).rejects.toThrow(/500 blocks old, past the 100-block limit/);
  });

  it("accepts a signal exactly at the age limit", async () => {
    const edge = await report({ block: Number(BLOCK) - 100 });
    await expect(verify(edge)).resolves.toBeDefined();
  });

  it("rejects a signal from a block the chain has not reached", async () => {
    const ahead = await report({ block: Number(BLOCK) + 1 });
    await expect(verify(ahead)).rejects.toThrow(/ahead of the current/);
  });

  it("rejects a signal carrying no block", async () => {
    // `asOfBlock` is the minimum over an empty set when no deployment reported, which
    // encodes as 0. Unverifiable provenance is not a small defect.
    const blockless = encodeSignal(
      aggregateSignal({
        positions: [],
        blocks: {},
        reportedDebtUsd: {},
        policy: riskPolicy,
      }),
    );
    await expect(verify(await report({ body: blockless }))).rejects.toThrow(/carries no block/);
  });

  it("rejects a signal version it does not know how to read", async () => {
    // Field order is the ABI, so an unknown version decoded anyway yields plausible
    // numbers in the wrong slots — worse than an error, because it looks like data.
    await expect(
      verify(await report(), { ...consumerPolicy, expectedVersion: "sentinel-signal/2" }),
    ).rejects.toThrow(/is not "sentinel-signal\/2"/);
  });

  it("refuses a consumer policy whose quorum is unreachable", async () => {
    // A misconfiguration that would otherwise present as every report being forged.
    await expect(
      verify(await report(), { ...consumerPolicy, signers: [SIGNERS[0]], f: 3 }),
    ).rejects.toThrow(/lists 1 signers but requires 4/);
  });

  it("rejects a report too short to hold a header", async () => {
    const short = await report();
    await expect(verify({ ...short, rawReport: short.rawReport.slice(0, 50) })).rejects.toThrow(
      /below the 109-byte header/,
    );
  });
});

describe("parseReportHeader", () => {
  it("reads the fields back at the offsets the DON writes them", async () => {
    const raw = buildRawReport({
      version: 2,
      executionId: `0x${"ab".repeat(32)}`,
      timestamp: 1_700_000_000,
      donId: 42,
      donConfigVersion: 9,
      workflowId: `0x${"cd".repeat(32)}`,
      workflowName: WORKFLOW_NAME,
      workflowOwner: OWNER,
      reportId: 513,
      body: "0x1234",
    });
    const header = parseReportHeader(raw);
    expect(header).toEqual({
      version: 2,
      executionId: `0x${"ab".repeat(32)}`,
      timestamp: 1_700_000_000,
      donId: 42,
      donConfigVersion: 9,
      workflowId: `0x${"cd".repeat(32)}`,
      workflowName: WORKFLOW_NAME,
      workflowOwner: OWNER,
      reportId: 513,
    });
    // The body begins right after the header and is not part of it.
    expect(reportBody(raw)).toBe("0x1234");
    expect(raw.length).toBe(REPORT_METADATA_HEADER_LENGTH + 2);
  });

  it("strips the NUL padding from a short workflow name", async () => {
    // Ten fixed bytes on the wire. Left in place, the padding would make every name
    // comparison fail and the failure would look like an attack.
    const raw = buildRawReport({ workflowName: "abc", workflowOwner: OWNER, body: "0x" });
    expect(parseReportHeader(raw).workflowName).toBe("abc");
    expect(toHex(raw.subarray(77, 87))).toBe("0x61626300000000000000");
  });
});

describe("describeSignal", () => {
  it("reports in human units, and only for a verified signal", async () => {
    const line = describeSignal(await verify(await report()));
    expect(line).toContain(SIGNAL_VERSION);
    expect(line).toContain("block 1000000");
    expect(line).toContain("$600 evaluable of $600 observed");
    expect(line).toContain("100.00% multi-protocol");
    // No address reaches a log line, same as everywhere else in the signal path.
    expect(line).not.toMatch(/0x[0-9a-f]{40}/i);
  });
});
