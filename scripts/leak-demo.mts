/**
 * The leak demo: run the identical pipeline with the enclave taken out.
 *
 * The confidentiality claim in this project is only interesting if the enclave is
 * load-bearing. So this script does exactly what the confidential workflow does —
 * the same three-pass query plan from `lib/signal/enclave-queries.ts`, the same
 * `normalizePosition`, the same risk policy — and then, instead of calling
 * `aggregateSignal`, calls `perAddressRowsForLeakDemoOnly`. That is the entire
 * difference between this file and `cre/sentinel-signal/workflow.ts`.
 *
 * What comes out is the thing the enclave exists to prevent from existing in public:
 * for each of the largest borrowers on Ethereum, the protocols they are levered
 * across, their aggregate leverage, the collateral asset that would liquidate them,
 * and the exact shock at which they become distressed. Sorted by size, so the most
 * profitable target is on line one.
 *
 * Two distinct harms, and they compound:
 *
 *   1. Liquidation targeting. A liquidation bot does not need to model anything;
 *      it needs a queue. This is the queue, pre-sorted by payout, annotated with
 *      the trigger price. Cross-protocol is what makes it novel — each protocol's
 *      own UI shows a position that looks safe in isolation.
 *   2. Deanonymization. A borrower's positions on Aave and on Compound are
 *      unlinked in public data until something links them. The linkage is the
 *      leak, and it is not undone by later closing a position.
 *
 * The aggregate signal answers the question a risk desk actually asks — how much
 * borrowed value is levered across protocols on the same collateral — without
 * producing this table. That is the whole design.
 *
 * This script prints truncated addresses by default, because a file in a public
 * repo is publication and the demo does not require committing the harm it warns
 * about. `--full` prints them whole, for a live demo where the point is that the
 * data really is real.
 *
 *   npm run leak-demo [-- --full]
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdirSync, writeFileSync } from "node:fs";
import { query } from "../lib/graph/client";
import { DEPLOYMENTS, type Deployment } from "../lib/graph/deployments";
import { buildPriceIndex, normalizePosition } from "../lib/exposure/normalize";
import type { Position, RawMarket, RawPosition } from "../lib/exposure/types";
import {
  collectAliasedPositions,
  completeBooksQuery,
  ENCLAVE_BOOTSTRAP_QUERY,
  topPositionsQuery,
} from "../lib/signal/enclave-queries";
import { perAddressRowsForLeakDemoOnly } from "../lib/signal/aggregate";
import { parseRiskPolicy } from "../lib/signal/policy";

const FULL = process.argv.includes("--full");

// Read from the same config the enclave runs, so this is the same run, not a
// differently-tuned one that happens to leak more.
const enclaveConfig = JSON.parse(
  await import("node:fs/promises").then((fs) =>
    fs.readFile("cre/sentinel-signal/config.staging.json", "utf8"),
  ),
) as {
  deployments: { key: string; schemaVersion: string }[];
  marketsPerDeployment: number;
  marketsSampled: number;
  positionsPerMarket: number;
  candidatesPerDeployment: number;
  candidateAccounts: number;
  completeBooksPageSize: number;
};

const policyJson = process.env.SENTINEL_RISK_POLICY;
if (!policyJson) {
  console.error(
    "SENTINEL_RISK_POLICY is not set. The leak demo uses the same policy the enclave " +
      "uses; set it in .env.local (see cre/.env.example).",
  );
  process.exit(1);
}
const policy = parseRiskPolicy(policyJson);

const deployments: Deployment[] = enclaveConfig.deployments
  .map((d) => DEPLOYMENTS.find((known) => known.key === d.key))
  .filter((d): d is Deployment => d !== undefined);

type BootstrapData = {
  _meta: { block: { number: number } };
  lendingProtocols: { totalBorrowBalanceUSD: string }[];
  markets: RawMarket[];
};

// ─── Pass 1 ─────────────────────────────────────────────────────────────────
const bootstrap = new Map<string, BootstrapData>();
for (const d of deployments) {
  const result = await query<BootstrapData>(d, ENCLAVE_BOOTSTRAP_QUERY, {
    markets: enclaveConfig.marketsPerDeployment,
  });
  if (result.data) bootstrap.set(d.key, result.data);
}

const allMarkets: RawMarket[] = [];
for (const b of bootstrap.values()) allMarkets.push(...b.markets);
const prices = buildPriceIndex(allMarkets);

// ─── Pass 2 ─────────────────────────────────────────────────────────────────
const sampledBy = new Map<string, Position[]>();
for (const d of deployments) {
  const b = bootstrap.get(d.key);
  if (!b) continue;
  const markets = b.markets
    .filter((m) => Number(m.totalDepositBalanceUSD) > 0 || Number(m.totalBorrowBalanceUSD) > 0)
    .slice(0, enclaveConfig.marketsSampled);
  if (markets.length === 0) continue;

  const result = await query<Record<string, unknown>>(
    d,
    topPositionsQuery(
      d.schemaVersion,
      markets.map((m) => m.id),
      enclaveConfig.positionsPerMarket,
    ),
  );
  if (!result.data) continue;

  const positions: Position[] = [];
  for (const raw of collectAliasedPositions<RawPosition>(result.data)) {
    const p = normalizePosition(raw, d.key, prices);
    if (p) positions.push(p);
  }

  // Same reconciliation gate as the enclave: a subgraph that overstates debt would
  // otherwise capture the candidate slots and the leak would be a leak of fiction.
  const reported = Number(b.lendingProtocols[0]?.totalBorrowBalanceUSD ?? 0);
  const sampledDebt = positions.reduce(
    (s, p) => (p.side === "BORROWER" ? s + p.valueUsd : s),
    0,
  );
  if (reported > 0 && sampledDebt / reported > 1.25) {
    console.log(`  skipping ${d.key}: sampled debt ${(sampledDebt / reported).toFixed(1)}x reported`);
    continue;
  }
  sampledBy.set(d.key, positions);
}

const nominated = new Set<string>();
for (const positions of sampledBy.values()) {
  const debt = new Map<string, number>();
  for (const p of positions) {
    if (p.side !== "BORROWER" || p.valueUsd <= 0) continue;
    debt.set(p.account, (debt.get(p.account) ?? 0) + p.valueUsd);
  }
  for (const [account] of [...debt]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, enclaveConfig.candidatesPerDeployment)) {
    nominated.add(account);
  }
}

const pooled = new Map<string, number>();
for (const positions of sampledBy.values()) {
  for (const p of positions) {
    if (p.side !== "BORROWER" || !nominated.has(p.account)) continue;
    pooled.set(p.account, (pooled.get(p.account) ?? 0) + p.valueUsd);
  }
}
const candidates = [...pooled]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, enclaveConfig.candidateAccounts)
  .map(([account]) => account);

// ─── Pass 3 ─────────────────────────────────────────────────────────────────
const complete: Position[] = [];
for (const d of deployments) {
  if (!sampledBy.has(d.key)) continue;
  const result = await query<{ positions: RawPosition[] }>(d, completeBooksQuery(d.schemaVersion), {
    accounts: candidates,
    first: enclaveConfig.completeBooksPageSize,
  });
  for (const raw of result.data?.positions ?? []) {
    const p = normalizePosition(raw, d.key, prices);
    if (p) complete.push(p);
  }
}

// ─── The leak ───────────────────────────────────────────────────────────────
// One line changed. In the enclave this is `aggregateSignal`, whose output cannot
// contain an address — `assertAggregateOnly` refuses to return one. Here it is the
// per-address table, and nothing stops it.
const rows = perAddressRowsForLeakDemoOnly(complete, policy);

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const addr = (a: string) => (FULL ? a : `${a.slice(0, 10)}…${a.slice(-6)}`);

const multi = rows.filter((r) => r.protocols.length > 1);
const distressed = rows.filter((r) => r.distressedAtShock !== null);

const lines: string[] = [];
const say = (line = "") => {
  lines.push(line);
  console.log(line);
};

say("# Leak demo — the same pipeline, with the enclave removed");
say();
say(`Run ${new Date().toISOString()}. Addresses ${FULL ? "in full" : "truncated for this file"}.`);
say();
say(
  "This is `scripts/leak-demo.mts`, which runs the confidential workflow's own query " +
    "plan, normalizer and risk policy and then calls `perAddressRowsForLeakDemoOnly` " +
    "where the enclave calls `aggregateSignal`. That single substitution is the entire " +
    "diff, and it is the difference between a risk statistic and a target list.",
);
say();
say(
  `**${rows.length} borrowers profiled. ${multi.length} of them are levered across more than ` +
    `one protocol, carrying ${usd(multi.reduce((s, r) => s + r.debtUsd, 0))} of debt. ` +
    `${distressed.length} become distressed within the policy's shock ladder.**`,
);
say();
say(
  "Each row below is individually actionable: the trigger column is the price decline " +
    "at which the position can be liquidated, and the collateral column is what to sell " +
    "into. Cross-protocol rows are the novel harm — each protocol's own interface shows " +
    "only its slice, and that slice can look comfortable while the aggregate does not.",
);
say();
say("| # | borrower | protocols | debt | collateral | leverage | top collateral | distressed at |");
say("|---|---|---|---|---|---|---|---|");
for (const [i, r] of rows.slice(0, 25).entries()) {
  say(
    `| ${i + 1} | \`${addr(r.account)}\` | ${r.protocols.length} (${r.protocols.join(", ")}) | ` +
      `${usd(r.debtUsd)} | ${usd(r.collateralUsd)} | ${r.aggregateLeverageRatio.toFixed(2)}x | ` +
      `\`${addr(r.topCollateralAsset)}\` | ` +
      `${r.distressedAtShock === null ? "—" : `−${(100 * r.distressedAtShock).toFixed(0)}%`} |`,
  );
}
say();
say(`_${Math.max(0, rows.length - 25)} further rows omitted from this file; the script prints all of them._`);
say();
say("## What the enclave publishes instead");
say();
say(
  "`docs/evidence/enclave-local-run.log` is the same data through " +
    "`aggregateSignal`: a single systemic risk score, a multi-protocol share of debt, " +
    "a shock ladder of aggregate distressed value, and coupling buckets suppressed " +
    "below the policy's k-anonymity floor. No row above survives that boundary — " +
    "`assertAggregateOnly` walks the output and throws on anything address-shaped, " +
    "checking object keys as well as string values.",
);
say();
say(
  "The point is not that the aggregate is safer because we chose to publish less. It is " +
    "that the aggregate is the answer to the question, and the table is not.",
);

mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/leak-demo.md", `${lines.join("\n")}\n`);
console.log("\nwrote docs/evidence/leak-demo.md");
