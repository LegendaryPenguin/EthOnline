/**
 * The downstream half of the confidentiality claim: consume a Sentinel report, then
 * fail to consume tampered versions of the same one.
 *
 * A TEE that protects a computation and then emits a signal nobody authenticates has
 * protected nothing that matters — the output would be forgeable by anyone who can
 * reach the consumer. So this script demonstrates the other side: `lib/signal/consume.ts`
 * verifying a report, and then refusing seven mutations of it, one mutation each.
 *
 * What is real here and what is not, stated plainly because the difference matters:
 *
 *   REAL   the payload. It is the base64 ABI block from `docs/evidence/enclave-local-run.log`,
 *          produced by the workflow running against live subgraph data. The numbers
 *          printed below were measured, not written.
 *   REAL   the wire format, the hash construction, the quorum rule, and every check —
 *          all read from the CRE SDK's own `Report` implementation.
 *   NOT    the signatures. A production report is signed by `f + 1` DON nodes holding
 *          keys Sentinel never sees. Here they are signed by throwaway keys from
 *          `lib/signal/dev-sign.ts`, because the DON cannot sign a report for a
 *          workflow that has not been deployed. The verifier does not know the
 *          difference, which is the point: swapping in the DON's registry-published
 *          signer set is a config change, not a code change.
 *
 *   npm run consume-signal
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { toHex, type Address, type Hex } from "viem";
import {
  buildRawReport,
  buildReportContext,
  devSigningKeys,
  signerAddress,
  signReport,
} from "../lib/signal/dev-sign";
import {
  describeSignal,
  ReportRejected,
  verifySignalReport,
  type ConsumerPolicy,
  type SignedReport,
} from "../lib/signal/consume";

const LOG = "docs/evidence/enclave-local-run.log";
const OUT = "docs/evidence/consume-signal.md";

/** Pull the base64 ABI payload out of the local run's log. */
function payloadFromLog(path: string): Hex {
  const lines = readFileSync(path, "utf8").split("\n");
  const marker = lines.findIndex((l) => l.includes("report that would cross the enclave boundary"));
  if (marker < 0) throw new Error(`no report payload in ${path}; re-run the enclave harness first`);
  const base64 = lines[marker + 1]?.trim();
  if (!base64) throw new Error(`report payload line is empty in ${path}`);
  return toHex(Buffer.from(base64, "base64"));
}

// f = 1 with four signers: quorum is two, and there is slack to demonstrate that a
// short quorum is refused rather than rounded down.
const KEYS = devSigningKeys(4);
const WORKFLOW_NAME = "sentinel";
const OWNER: Address = "0x00000000000000000000000000000000000000a1";
const CONFIG_DIGEST: Hex = `0x${"33".repeat(32)}`;

const policy: ConsumerPolicy = {
  signers: KEYS.map(signerAddress),
  f: 1,
  workflowOwner: OWNER,
  workflowName: WORKFLOW_NAME,
  // ~20 minutes of Ethereum blocks. A systemic-risk reading older than that describes
  // a book that has since moved.
  maxBlockAge: 100n,
};

const lines: string[] = [];
function say(line = "") {
  console.log(line);
  lines.push(line);
}

async function main() {
  const body = payloadFromLog(LOG);

  const build = async (
    overrides: { name?: string; owner?: Address; body?: Hex; keys?: Hex[]; seqNr?: bigint } = {},
  ): Promise<SignedReport> =>
    signReport(
      buildRawReport({
        workflowName: overrides.name ?? WORKFLOW_NAME,
        workflowOwner: overrides.owner ?? OWNER,
        body: overrides.body ?? body,
      }),
      buildReportContext(CONFIG_DIGEST, overrides.seqNr ?? 7n),
      overrides.keys ?? KEYS.slice(0, 2),
    );

  const genuine = await build();

  // The recorded run's block is whatever the live subgraphs served at the time, and
  // this script has no chain access to learn the current head from. So the accepted
  // case is verified as if the head were that block — the staleness check still runs,
  // and the refusal list below exercises it for real by moving the head past the
  // window rather than by loosening it.
  const UNBOUNDED = 2n ** 48n;
  const seen = await verifySignalReport(genuine, { ...policy, maxBlockAge: UNBOUNDED }, UNBOUNDED);
  const accepted = await verifySignalReport(genuine, policy, seen.signal.asOfBlock);

  say("Sentinel report consumption: accept, then refuse");
  say("");
  say(`payload         ${LOG}, base64 ABI block (real, from live subgraph data)`);
  say(`signatures      ${KEYS.length} throwaway dev keys, f = 1 (the DON has not signed this yet)`);
  say(`consumer        lib/signal/consume.ts, viem only, no CRE toolchain`);
  say("");
  say("ACCEPTED");
  say(`  ${describeSignal(accepted)}`);
  say(`  quorum ${accepted.signers.length} of ${policy.f + 1} required, distinct signers`);
  say(`  workflow ${accepted.header.workflowName} owned by ${accepted.header.workflowOwner}`);
  say("");

  const head = accepted.signal.asOfBlock;

  const cases: { name: string; report: () => Promise<SignedReport>; at?: bigint }[] = [
    {
      name: "one byte of the signal body flipped after signing",
      report: async () => {
        const r = await build();
        const raw = new Uint8Array(r.rawReport);
        raw[raw.length - 1] ^= 0x01;
        return { ...r, rawReport: raw };
      },
    },
    {
      name: "the header's DON id rewritten after signing",
      report: async () => {
        const r = await build();
        const raw = new Uint8Array(r.rawReport);
        raw[37] ^= 0xff;
        return { ...r, rawReport: raw };
      },
    },
    {
      name: "replayed under a different DON sequence number",
      report: async () => {
        const r = await build();
        return { ...r, reportContext: buildReportContext(CONFIG_DIGEST, 8n) };
      },
    },
    {
      name: "signed by a key outside the DON's signer set",
      report: () => build({ keys: devSigningKeys(6).slice(4) }),
    },
    {
      name: "one signer's signature repeated to fake a quorum",
      report: async () => {
        const r = await build({ keys: [KEYS[0]] });
        return { ...r, signatures: [r.signatures[0], r.signatures[0]] };
      },
    },
    {
      name: "correctly signed, but by a different workflow the same DON runs",
      report: () => build({ name: "attacker" }),
    },
    {
      name: "genuine but stale: the reading is older than the consumer's window",
      report: () => build(),
      at: head + policy.maxBlockAge + 1n,
    },
  ];

  say("REFUSED");
  let refused = 0;
  for (const c of cases) {
    try {
      await verifySignalReport(await c.report(), policy, c.at ?? head);
      say(`  NOT REFUSED  ${c.name}`);
      process.exitCode = 1;
    } catch (error) {
      if (!(error instanceof ReportRejected)) throw error;
      refused++;
      say(`  ${c.name}`);
      say(`      ${error.message}`);
    }
  }
  say("");
  say(`${refused} of ${cases.length} mutations refused; 1 genuine report accepted`);

  mkdirSync("docs/evidence", { recursive: true });
  writeFileSync(
    OUT,
    [
      "# Downstream consumption of an attested signal",
      "",
      "Generated by `npm run consume-signal`. The payload is the real one from",
      "`enclave-local-run.log`; the signatures are throwaway dev keys, because the DON",
      "cannot sign a workflow that is not yet deployed. Every check is the real one.",
      "",
      "```",
      ...lines,
      "```",
      "",
    ].join("\n"),
  );
  console.log(`\nwrote ${OUT}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
