/**
 * The SDK, which is the second independent consumer of the same schema.
 *
 * Same bytes as the Solidity contract verifies (`contracts/test/fixtures/report.json`,
 * written by `npm run fixture:report`), read here through the TypeScript path. The
 * fixture is loaded rather than rebuilt so a divergence between the two consumers shows
 * up as a test failure in one of them rather than as two implementations agreeing with
 * themselves.
 */

import { readFileSync } from "node:fs";
import { hexToBytes, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { buildRawReport, buildReportContext, devSigningKeys, signerAddress, signReport } from "../dev-sign";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { SIGNAL_ABI_PARAMS } from "../report";
import { SentinelClient, WEEK_BLOCKS } from "../sdk";
import type { SignedReport } from "../consume";

// Resolved from this file rather than from the working directory, so the suite does not
// depend on where it was launched from.
const FIXTURE_PATH = new URL("../../../contracts/test/fixtures/report.json", import.meta.url);

const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
  rawReport: Hex;
  reportContext: Hex;
  signatures: Hex[];
  signers: Address[];
  f: string;
  workflowOwner: Address;
  workflowName: string;
  expected: Record<string, string>;
};

const KEYS = devSigningKeys(4);
const CONFIG_DIGEST: Hex = `0x${"33".repeat(32)}`;

const recorded: SignedReport = {
  rawReport: hexToBytes(FIXTURE.rawReport),
  reportContext: hexToBytes(FIXTURE.reportContext),
  signatures: FIXTURE.signatures.map((s) => hexToBytes(s)),
};

const client = () =>
  new SentinelClient({
    signers: FIXTURE.signers,
    f: Number(FIXTURE.f),
    workflowOwner: FIXTURE.workflowOwner,
    workflowName: FIXTURE.workflowName,
    maxBlockAge: 100n,
  });

const asOfBlock = BigInt(FIXTURE.expected.asOfBlock);

/** A report at a chosen block and score, signed by two of the pinned signers. */
async function report(block: bigint, scoreBps: number): Promise<SignedReport> {
  const body = encodeAbiParameters(parseAbiParameters(SIGNAL_ABI_PARAMS), [
    "sentinel-signal/1",
    block,
    90,
    5_719_318_802_446_351n,
    2_866_777_614_673_399n,
    35_923_754_337_877n,
    125,
    4330,
    3000,
    1_215_514_673_345_420n,
    scoreBps,
    0,
    3,
    6,
    1_036_965_965_190_114n,
  ]);
  return signReport(
    buildRawReport({
      workflowName: FIXTURE.workflowName,
      workflowOwner: FIXTURE.workflowOwner,
      body,
    }),
    buildReportContext(CONFIG_DIGEST, 7n),
    KEYS.slice(0, 2),
  );
}

describe("the recorded report", () => {
  it("verifies through the SDK and decodes what the Solidity consumer decoded", async () => {
    const assessment = await client().consume(recorded, asOfBlock + 10n);
    const s = assessment.verified.signal;
    // The interoperability assertion: these are the same expected values
    // `contracts/test/SentinelConsumer.t.sol` asserts, from the same bytes.
    expect(s.version).toBe(FIXTURE.expected.version);
    expect(s.debtUsd6).toBe(BigInt(FIXTURE.expected.debtUsd6));
    expect(s.evaluableDebtUsd6).toBe(BigInt(FIXTURE.expected.evaluableDebtUsd6));
    expect(s.multiProtocolDebtUsd6).toBe(BigInt(FIXTURE.expected.multiProtocolDebtUsd6));
    expect(s.systemicRiskScoreBps).toBe(Number(FIXTURE.expected.systemicRiskScoreBps));
    expect(s.suppressedBuckets).toBe(Number(FIXTURE.expected.suppressedBuckets));
  });

  it("summarises only what it verified", async () => {
    const assessment = await client().consume(recorded, asOfBlock + 10n);
    expect(assessment.summary).toContain("sentinel-signal/1");
    // The whole product thesis, asserted on the output a consumer would log.
    expect(assessment.summary).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it("is refused once it is past the freshness window", async () => {
    await expect(client().consume(recorded, asOfBlock + 101n)).rejects.toThrow(/blocks old/);
  });

  it("is refused when the pinned signer set does not contain its signers", async () => {
    const wrong = new SentinelClient({
      signers: [signerAddress(devSigningKeys(9)[8])],
      f: 0,
      workflowOwner: FIXTURE.workflowOwner,
      workflowName: FIXTURE.workflowName,
      maxBlockAge: 100n,
    });
    await expect(wrong.consume(recorded, asOfBlock + 10n)).rejects.toThrow(/unknown signer/);
  });
});

describe("stance", () => {
  it("calls the first reading normal whatever its level", async () => {
    // Nothing to compare against yet, and the level is not a threshold.
    const assessment = await client().consume(await report(1000n, 9000), 1010n);
    expect(assessment.stance).toBe("normal");
    expect(assessment.riseBps).toBeNull();
  });

  it("reports each operating point with the false-alarm rate it was calibrated to", async () => {
    for (const [rise, stance, rate] of [
      [60, "normal", null],
      [61, "watch", 0.3],
      [87, "warn", 0.2],
      [239, "alert", 0.1],
    ] as const) {
      const c = client();
      await c.consume(await report(1000n, 2000), 1010n);
      const a = await c.consume(await report(1100n, 2000 + rise), 1110n);
      expect(a.stance, `rise of ${rise} bps`).toBe(stance);
      expect(a.falseAlarmRate, `rise of ${rise} bps`).toBe(rate);
      expect(a.riseBps).toBe(rise);
    }
  });

  it("does not fire on a fall, however large", async () => {
    const c = client();
    await c.consume(await report(1000n, 3000), 1010n);
    const a = await c.consume(await report(1100n, 1000), 1110n);
    expect(a.stance).toBe("normal");
    expect(a.riseBps).toBe(-2000);
  });

  it("holds the baseline for a week, so a slow climb is still visible", async () => {
    // Five reports 50 bps apart: invisible to a consumer comparing consecutive
    // readings, an alert to one holding a week-old baseline.
    const c = client();
    await c.consume(await report(1000n, 2000), 1010n);
    let last;
    for (let i = 1n; i <= 5n; i++) {
      last = await c.consume(await report(1000n + i * 100n, 2000 + Number(i) * 50), 1000n + i * 100n + 10n);
    }
    expect(last!.stance).toBe("alert");
  });

  it("rolls the baseline forward after a week, so an elevated level becomes the new normal", async () => {
    const c = client();
    await c.consume(await report(1000n, 2000), 1010n);
    const later = 1000n + WEEK_BLOCKS;
    expect((await c.consume(await report(later, 2400), later + 10n)).stance).toBe("alert");
    expect((await c.consume(await report(later + 100n, 2400), later + 110n)).stance).toBe("normal");
  });

  it("refuses to rewind to an older report", async () => {
    // The two readings are close together so the older one is still inside the
    // freshness window: this is about monotonicity, and a staleness rejection
    // would hide it.
    const c = client();
    await c.consume(await report(1100n, 2000), 1110n);
    await expect(c.consume(await report(1020n, 2000), 1110n)).rejects.toThrow(/not newer/);
  });
});
