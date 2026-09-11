/**
 * npm run snapshot — capture a live snapshot and write it, with provenance, to
 * data/snapshot.json plus the Phase 2 coverage report.
 *
 * Everything printed here comes from a live gateway response. If the run fails,
 * it fails loudly; there is no cached or synthetic path.
 */

import { config } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";

config({ path: ".env.local", quiet: true });

import { captureSnapshot } from "../lib/graph/snapshot";
import { coverageReport, joinByAccount } from "../lib/exposure/join";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

const started = Date.now();
const perMarket = Number(process.env.PER_MARKET ?? 1000);

const snapshot = await captureSnapshot({
  positionsPerMarket: perMarket,
  onProgress: (m) => console.log(`  ${m}`),
});

const exposures = joinByAccount(snapshot.positions);
const reportedDebt = Object.values(snapshot.protocolTotals).reduce(
  (sum, p) => sum + p.borrowUsd,
  0,
);
const report = coverageReport(exposures, reportedDebt, snapshot.protocolTotals);

await mkdir("data", { recursive: true });
await writeFile(
  "data/snapshot.json",
  JSON.stringify({ ...snapshot, coverage: report }, null, 2),
);

const multi = [...exposures.values()]
  .filter((e) => e.protocols.length > 1 && e.debtUsd > 0)
  .sort((a, b) => b.debtUsd - a.debtUsd);

await writeFile(
  "data/multi-protocol-accounts.json",
  JSON.stringify(
    multi.slice(0, 200).map((e) => ({
      account: e.account,
      protocols: e.protocols,
      collateralUsd: e.collateralUsd,
      debtUsd: e.debtUsd,
      healthFactor: e.healthFactor,
    })),
    null,
    2,
  ),
);

const elapsed = ((Date.now() - started) / 1000).toFixed(1);

console.log(`
Snapshot captured in ${elapsed}s
  block aligned      ${snapshot.provenance.blockAligned}
  blocks             ${JSON.stringify(snapshot.provenance.blocks)}
  excluded           ${snapshot.provenance.excluded.length}
${snapshot.provenance.excluded.map((e) => `    - ${e.deployment}: ${e.reason}`).join("\n")}

Per-protocol debt coverage
${Object.entries(report.perProtocol)
  .map(
    ([k, v]) =>
      `  ${k.padEnd(20)} ${usd(v.sampledDebtUsd).padStart(16)} / ${usd(
        v.reportedDebtUsd,
      ).padStart(16)}  = ${pct(v.ratio)}`,
  )
  .join("\n")}

Cross-protocol exposure (sample of ${report.accountsTotal.toLocaleString()} accounts)
  accounts on 2+ protocols          ${report.accountsMultiProtocol.toLocaleString()}
  borrowing on 2+ protocols         ${report.borrowersMultiProtocol.toLocaleString()}
  debt held by those borrowers      ${usd(report.multiProtocolDebtUsd)}
  sampled debt                      ${usd(report.sampledDebtUsd)}
  protocol-reported debt            ${usd(report.reportedDebtUsd)}
  sample covers                     ${pct(report.sampleCoverageOfReported)} of reported debt

HEADLINE: at least ${pct(report.multiProtocolDebtShareOfSample)} of sampled borrowed value
sits with addresses levered across 2 or more protocols.

  protocol-count histogram  ${JSON.stringify(report.protocolCountHistogram)}
  top protocol pairs
${Object.entries(report.pairOverlap)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([k, v]) => `    ${k.replace("|", " + ")}: ${v}`)
  .join("\n")}

Wrote data/snapshot.json and data/multi-protocol-accounts.json
`);
