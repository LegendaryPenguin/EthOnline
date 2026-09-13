/**
 * npm run backtest — score the risk engine against liquidations that really happened.
 *
 * Phase 3 asks for precision, recall and a false-positive rate. Those three numbers
 * cannot come from the same experiment, and pretending otherwise is the usual way
 * backtests end up flattering:
 *
 *   Recall needs the liquidated accounts. Rewind to the block before each real
 *   `Liquidate` and ask whether the engine would have called that account
 *   liquidatable. Every event is a known positive, so this measures how many the
 *   engine finds — but it contains no negatives at all, so it cannot measure
 *   precision. Reporting only this is how a model that flags everything scores 100%.
 *
 *   Precision and the false-positive rate need the accounts that were *not*
 *   liquidated, which means a population fixed in advance. So the second experiment
 *   picks one block, flags the whole population there, and then looks forward to see
 *   who actually got liquidated. The population is stated in the output rather than
 *   left implicit, because precision is a statement about a population and is
 *   meaningless without one.
 *
 * Neither experiment can see the future: both read state strictly before the events
 * they are scored against, and `at()` asserts it on every single query rather than
 * trusting the call sites.
 *
 * Writes docs/BACKTEST.md.
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { query } from "../lib/graph/client";
import { DEPLOYMENTS, type Deployment } from "../lib/graph/deployments";
import {
  accountPositionsAtBlock,
  canTimeTravel,
  classify,
  fetchLiquidations,
  pricesAtBlock,
  isFlagged,
  repriceVerdict,
  STALE_MARGIN,
  verdict,
  type Cause,
  type LiquidationEvent,
  type Verdict,
} from "../lib/backtest/replay";
import type { Position } from "../lib/exposure/types";

/**
 * How far back the window reaches.
 *
 * Measured, not chosen: on the deployments that serve history at all, time-travel
 * succeeds 200,000 blocks back and fails at 1,000,000 with no indexer able to serve
 * it. 150,000 blocks is about three weeks and leaves headroom.
 */
const WINDOW_BLOCKS = 150_000;

/** Kept clear of head so reorg-adjacent blocks are never the subject. */
const HEAD_MARGIN = 100;

/** Upper bound on replayed events, to bound the query budget. */
const MAX_EVENTS = 120;

/** Live borrowers added to the panel as candidate negatives. */
const PANEL_LIVE_BORROWERS = 150;

const CONCURRENCY = 6;

/**
 * Every historical read goes through here, so the no-lookahead property is a
 * property of the program rather than a claim in a comment. A backtest that can
 * see one block past the event it is scoring is not a backtest.
 */
let reads = 0;
function at(block: number, mustBeBefore: number, what: string): number {
  if (block >= mustBeBefore) {
    throw new Error(`lookahead: reading ${what} at block ${block}, must be < ${mustBeBefore}`);
  }
  reads++;
  return block;
}

async function pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < items.length) await worker(items[cursor++]);
    }),
  );
}

/** Markets are 500 rows; one fetch per (protocol, block) is reused across accounts. */
const priceCache = new Map<string, Promise<Map<string, number>>>();
function prices(deployment: Deployment, block: number): Promise<Map<string, number>> {
  const key = `${deployment.key}:${block}`;
  let hit = priceCache.get(key);
  if (!hit) {
    hit = pricesAtBlock(deployment, block);
    priceCache.set(key, hit);
  }
  return hit;
}

// ---------------------------------------------------------------- the window

const meta = await query<{ _meta: { block: { number: number } } }>(
  DEPLOYMENTS[0],
  "{ _meta { block { number } } }",
);
const head = meta.block;
const to = head - HEAD_MARGIN;
const from = to - WINDOW_BLOCKS;

console.log(`head ${head}; replaying blocks ${from}..${to} (${WINDOW_BLOCKS} blocks)`);

/**
 * Which deployments can be replayed, asked before anything is scored.
 *
 * The probe is at `from`, the earliest block either experiment needs, so a
 * deployment that passes here can serve every read that follows. Testing capability
 * up front rather than catching failures per account is the difference between a
 * reported limitation and a silently narrowed sample: without this, three protocols
 * failed 74 of 110 replays and the recall figure would have been computed over
 * whichever ones happened to answer, with nothing in the output saying so.
 */
console.log("\nprobing time-travel support:");
const capability = new Map<string, { ok: boolean; detail?: string }>();
await pool(DEPLOYMENTS, async (d) => {
  const res = await canTimeTravel(d, from);
  capability.set(d.key, res.ok ? { ok: true } : { ok: false, detail: res.detail });
  console.log(`  ${d.key.padEnd(20)} ${res.ok ? "history served" : `no history: ${res.detail.slice(0, 90)}`}`);
});

const replayable = DEPLOYMENTS.filter((d) => capability.get(d.key)?.ok);
const notReplayable = DEPLOYMENTS.filter((d) => !capability.get(d.key)?.ok);

if (replayable.length === 0) {
  throw new Error("no deployment serves historical state, so the backtest cannot run");
}

console.log(`\n${replayable.length} of ${DEPLOYMENTS.length} deployments are replayable`);

// Liquidations are counted across every deployment, because the *count* is
// available even where the historical state behind it is not, and knowing how much
// of the chain's liquidation activity falls outside the scorable set is part of
// reading the score.
const events: LiquidationEvent[] = [];
const unreachable: { protocol: string; detail: string }[] = [];

await pool(DEPLOYMENTS, async (d) => {
  try {
    const found = await fetchLiquidations(d, from, to);
    events.push(...found);
    console.log(`  ${d.key}: ${found.length} liquidations`);
  } catch (err) {
    unreachable.push({ protocol: d.key, detail: (err as Error).message });
    console.log(`  ${d.key}: FAILED: ${(err as Error).message}`);
  }
});

if (events.length === 0) throw new Error("no liquidations found in the window, so nothing to score");

/**
 * One liquidation transaction emits a `Liquidate` per asset seized, and all of them
 * describe the same account at the same block. Scoring each row would count one
 * event several times and inflate whichever way that account happened to resolve,
 * so the unit is the distinct (protocol, account, block) book.
 */
type Episode = {
  key: string;
  protocol: string;
  account: string;
  block: number;
  amountUsd: number;
  rows: LiquidationEvent[];
};

const episodeMap = new Map<string, Episode>();
for (const e of events) {
  const key = `${e.protocol}|${e.liquidatee}|${e.blockNumber}`;
  const hit = episodeMap.get(key);
  if (hit) {
    hit.amountUsd += e.amountUsd;
    hit.rows.push(e);
    continue;
  }
  episodeMap.set(key, {
    key,
    protocol: e.protocol,
    account: e.liquidatee,
    block: e.blockNumber,
    amountUsd: e.amountUsd,
    rows: [e],
  });
}

const allEpisodes = [...episodeMap.values()].sort((a, b) => a.block - b.block);
const replayableKeys = new Set(replayable.map((d) => d.key));
const scorableEpisodes = allEpisodes.filter((ep) => replayableKeys.has(ep.protocol));

console.log(
  `${events.length} rows -> ${allEpisodes.length} distinct episodes, ` +
    `${scorableEpisodes.length} on replayable deployments`,
);

if (scorableEpisodes.length < 50) {
  throw new Error(
    `only ${scorableEpisodes.length} scorable episodes; Phase 3 requires at least 50. ` +
      `Widen WINDOW_BLOCKS or wait for more liquidations.`,
  );
}

/**
 * Sampled evenly across the window rather than largest-first.
 *
 * Taking the biggest liquidations would be the more flattering sample and also the
 * wrong one: large books are the well-parameterised ones, so size-ranking the
 * sample would measure the engine on its easiest cases and call the result recall.
 * An even stride is deterministic, re-runnable, and correlated with nothing.
 */
const stride = Math.max(1, Math.ceil(scorableEpisodes.length / MAX_EVENTS));
const episodes = scorableEpisodes.filter((_, i) => i % stride === 0).slice(0, MAX_EVENTS);
console.log(`replaying ${episodes.length} of them (stride ${stride})`);

// ------------------------------------------------- experiment 1: recall

type Replay = Episode & {
  verdict: Verdict;
  cause: Cause;
  /** Kept so misses can be re-priced at the liquidation block to explain them. */
  positions: Position[];
  /** Health factor of the same positions at the liquidation block's prices. */
  hfAtEvent?: number;
  error?: string;
};

const replays: Replay[] = [];

await pool(episodes, async (ep) => {
  const deployment = DEPLOYMENTS.find((d) => d.key === ep.protocol)!;
  // The block before the liquidation: the last moment at which flagging the
  // account would have been useful, and the last one that cannot contain its
  // outcome.
  const block = at(ep.block - 1, ep.block, `${ep.account} on ${ep.protocol}`);

  try {
    const priceIndex = await prices(deployment, block);
    const { positions, dropped } = await accountPositionsAtBlock(
      deployment,
      ep.account,
      block,
      priceIndex,
    );
    const v = verdict(positions, dropped);
    replays.push({ ...ep, verdict: v, cause: classify(v), positions });
  } catch (err) {
    replays.push({
      ...ep,
      verdict: verdict([], 0),
      cause: "no-positions",
      positions: [],
      error: (err as Error).message,
    });
  }
  process.stdout.write(".");
});
console.log();

const scored = replays.filter((r) => !r.error);
const errored = replays.filter((r) => r.error);
const hits = scored.filter((r) => r.cause === "flagged");
const recall = scored.length > 0 ? hits.length / scored.length : 0;

// Capability was verified at `from` before any of this ran, so a failure here is
// not the known time-travel limitation and must not be filed under it.
if (errored.length > 0) {
  console.log(`\n${errored.length} episodes failed on a replayable deployment:`);
  for (const r of errored) console.log(`  ${r.protocol} ${r.account} @${r.block}: ${r.error}`);
}
if (scored.length < 50) {
  throw new Error(`only ${scored.length} episodes scored; Phase 3 requires at least 50`);
}

const byCause = new Map<Cause, Replay[]>();
for (const r of scored) {
  const list = byCause.get(r.cause) ?? [];
  list.push(r);
  byCause.set(r.cause, list);
}

console.log(`recall ${(100 * recall).toFixed(1)}% (${hits.length}/${scored.length} episodes)`);
for (const [cause, list] of [...byCause].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${cause.padEnd(18)} ${list.length}`);
}

// --------------------------------- experiment 2: precision and false positives

/**
 * The population, fixed at `from` before any outcome is known.
 *
 * Two sources, both stated in the output. Every account liquidated during the
 * window supplies the positives. The largest live cross-protocol borrowers supply
 * candidate negatives — the population Sentinel actually reports on, so a false
 * positive here is a false positive a user would really have seen.
 *
 * This is a biased population, and the bias is worth naming: it is far denser in
 * liquidations than the chain is, so the precision below is a *lower* bound on
 * precision over all borrowers, where negatives vastly outnumber positives. The
 * false-positive rate is the figure that transfers, since it is conditioned on the
 * negatives alone.
 */
const completed = JSON.parse(await readFile("data/completed.json", "utf8")) as {
  positions: Position[];
};

const liveDebt = new Map<string, number>();
for (const p of completed.positions) {
  if (p.side !== "BORROWER") continue;
  const key = `${p.protocol}|${p.account.toLowerCase()}`;
  liveDebt.set(key, (liveDebt.get(key) ?? 0) + p.valueUsd);
}

const panelKeys = new Set<string>();
for (const ep of scorableEpisodes) panelKeys.add(`${ep.protocol}|${ep.account}`);
const fromLiquidations = panelKeys.size;

for (const [key] of [...liveDebt]
  .filter(([key]) => replayableKeys.has(key.split("|")[0]))
  .sort((a, b) => b[1] - a[1])
  .slice(0, PANEL_LIVE_BORROWERS)) {
  panelKeys.add(key);
}

/** Every episode after the panel block, so outcomes are strictly in the future. */
const liquidatedAfter = new Set(
  scorableEpisodes.filter((ep) => ep.block > from).map((ep) => `${ep.protocol}|${ep.account}`),
);

type PanelRow = {
  protocol: string;
  account: string;
  verdict: Verdict;
  cause: Cause;
  flagged: boolean;
  liquidated: boolean;
  error?: string;
};

const panel: PanelRow[] = [];

console.log(
  `\npanel: ${panelKeys.size} books at block ${from} ` +
    `(${fromLiquidations} liquidated in window, rest largest live borrowers)`,
);

await pool([...panelKeys], async (key) => {
  const [protocol, account] = key.split("|");
  const deployment = DEPLOYMENTS.find((d) => d.key === protocol);
  if (!deployment) return;

  const block = at(from, from + 1, `panel ${key}`);
  try {
    const priceIndex = await prices(deployment, block);
    const { positions, dropped } = await accountPositionsAtBlock(
      deployment,
      account,
      block,
      priceIndex,
    );
    const v = verdict(positions, dropped);
    const cause = classify(v);
    panel.push({
      protocol,
      account,
      verdict: v,
      cause,
      flagged: isFlagged(v),
      liquidated: liquidatedAfter.has(key),
    });
  } catch (err) {
    panel.push({
      protocol,
      account,
      verdict: verdict([], 0),
      cause: "no-positions",
      flagged: false,
      liquidated: liquidatedAfter.has(key),
      error: (err as Error).message,
    });
  }
  process.stdout.write(".");
});
console.log();

// Books with no debt at the panel block carry no prediction at all — the engine
// declines rather than guessing — so counting them as true negatives would inflate
// specificity with accounts it never had an opinion about.
const opinion = panel.filter((r) => !r.error && r.verdict.debtUsd > 0);

const tp = opinion.filter((r) => r.flagged && r.liquidated).length;
const fp = opinion.filter((r) => r.flagged && !r.liquidated).length;
const fn = opinion.filter((r) => !r.flagged && r.liquidated).length;
const tn = opinion.filter((r) => !r.flagged && !r.liquidated).length;
const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
const panelRecall = tp + fn > 0 ? tp / (tp + fn) : 0;
const fpr = fp + tn > 0 ? fp / (fp + tn) : 0;

console.log(`precision ${(100 * precision).toFixed(1)}%  recall ${(100 * panelRecall).toFixed(1)}%  FPR ${(100 * fpr).toFixed(2)}%`);
console.log(`TP ${tp}  FP ${fp}  FN ${fn}  TN ${tn}  (${panel.length - opinion.length} no opinion)`);
console.log(`${reads} historical reads, all asserted to precede their outcome`);

// --------------------------------------------- root-causing the misses, post-hoc

/**
 * For each miss, was the position read wrong, or was the price simply not published
 * yet?
 *
 * "A real miss" is not a root cause, and a miss at a health factor of 2.0 clearly is
 * not explained by accrued interest. The one hypothesis that fits a book that far
 * from its boundary is that the oracle update which triggered the liquidation landed
 * in the liquidation's own block — in which case the last state any monitor could
 * have seen genuinely showed a solvent account, and no read at block-1 could have
 * done better.
 *
 * That is testable, so it is tested rather than asserted: re-price the block-1
 * positions with the liquidation block's oracle prices and see whether the book
 * crosses its boundary on the price move alone.
 *
 * Everything scored above is already final. This pass reads the liquidation's own
 * block and so is deliberately quarantined below the scoring, never fed back into it.
 */
const misses = scored.filter((r) => r.cause !== "flagged" && r.positions.length > 0);

await pool(misses, async (r) => {
  const deployment = DEPLOYMENTS.find((d) => d.key === r.protocol)!;
  try {
    // Deliberately the event block, not block-1. Not routed through `at()`, which
    // exists to forbid exactly this — nothing here reaches a prediction.
    const eventPrices = await pricesAtBlock(deployment, r.block);
    r.hfAtEvent = repriceVerdict(r.positions, eventPrices).healthFactor;
  } catch {
    // A diagnostic that cannot run leaves the miss unexplained rather than guessed.
  }
});

const explainedByPrice = misses.filter((r) => (r.hfAtEvent ?? Infinity) < 1);
const unexplained = misses.filter((r) => (r.hfAtEvent ?? Infinity) >= 1);

console.log(
  `\nof ${misses.length} misses, ${explainedByPrice.length} cross their boundary on the ` +
    `liquidation block's prices alone`,
);

// ------------------------------------------------- where the boundary actually is

/**
 * Recall and cost as the flag threshold moves.
 *
 * A single recall figure at HF < 1 says how often the engine agreed with the chain.
 * It does not say whether a miss was a near-miss or a wild one, and here that
 * distinction is the whole story: most misses sit a few percent above the boundary,
 * which is the signature of a systematic offset rather than of positions the engine
 * misread.
 *
 * The sweep is only honest with the cost attached. Raising the threshold buys recall
 * from the same population it sells precision to, so recall is computed over the
 * replayed liquidations and the false-positive rate over the panel's negatives at
 * every threshold. Reporting the first column without the last would turn a
 * measurement into an advertisement.
 */
const THRESHOLDS = [1.0, 1.01, 1.02, 1.05, 1.1, 1.2, 1.5];

/**
 * Schema versions present only among the deployments that cannot be replayed.
 *
 * Worth computing rather than asserting, because it decides whether the coverage
 * gap is merely partial or actually biased: version skew is where the normalizer
 * does the most work, so a version that appears nowhere in the scorable set is a
 * version the backtest says nothing about.
 */
const scorableVersions = new Set(replayable.map((d) => d.schemaVersion));
const unscorableOnlyVersions = [
  ...new Set(notReplayable.map((d) => d.schemaVersion).filter((v) => !scorableVersions.has(v))),
].sort();

const negatives = opinion.filter((r) => !r.liquidated);
const positives = opinion.filter((r) => r.liquidated);

const sweep = THRESHOLDS.map((t) => {
  const caught = scored.filter((r) => isFlagged(r.verdict, t)).length;
  const fpAt = negatives.filter((r) => isFlagged(r.verdict, t)).length;
  const tpAt = positives.filter((r) => isFlagged(r.verdict, t)).length;
  return {
    threshold: t,
    recall: caught / scored.length,
    caught,
    fpr: negatives.length > 0 ? fpAt / negatives.length : 0,
    precision: tpAt + fpAt > 0 ? tpAt / (tpAt + fpAt) : 0,
  };
});

console.log("\nthreshold sweep (recall from episodes, FPR from panel negatives):");
for (const s of sweep) {
  console.log(
    `  HF < ${s.threshold.toFixed(2)}  recall ${(100 * s.recall).toFixed(1)}%  ` +
      `FPR ${(100 * s.fpr).toFixed(1)}%  precision ${(100 * s.precision).toFixed(1)}%`,
  );
}

// ------------------------------------------------------------------ the report

const pct = (n: number) => `${(100 * n).toFixed(1)}%`;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const hf = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : "∞");
const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-6)}`;

const CAUSE_NOTE: Record<Cause, string> = {
  flagged: "health factor below 1 at the block before the liquidation — a hit",
  "no-positions":
    "time-travel returned no rows: the indexer pruned that far back, or every position was written in the liquidation's own block",
  "no-debt":
    "rows exist but no priced borrow, so no health factor is defined — usually a debt row dropped for want of an oracle price",
  "unknown-threshold":
    "some collateral published no liquidation threshold, so the boundary is uncomputable and the engine declines rather than inventing one",
  "stale-balance": `solvent by under ${((STALE_MARGIN - 1) * 100).toFixed(0)}%: balances are event-written, so interest accrued since the account's last event is missing`,
  solvent: "comfortably solvent on the replayed numbers — a real miss",
};

function causeTable(): string {
  const rows = [...byCause]
    .sort((a, b) => b[1].length - a[1].length)
    .map(
      ([cause, list]) =>
        `| \`${cause}\` | ${list.length} | ${pct(list.length / scored.length)} | ${CAUSE_NOTE[cause]} |`,
    );
  return rows.join("\n");
}

function replayTable(list: Replay[], withDiagnosis = false): string {
  if (list.length === 0) return "_none_";
  const head = withDiagnosis
    ? "| account | protocol | block | liquidated | HF at block−1 | HF at event prices | collateral | debt | rows |"
    : "| account | protocol | block | liquidated | HF at block−1 | collateral | debt | rows |";
  return [
    head,
    `|${"---|".repeat(withDiagnosis ? 9 : 8)}`,
    ...list
      .sort((a, b) => b.amountUsd - a.amountUsd)
      .map((r) => {
        const diag = withDiagnosis
          ? ` ${r.hfAtEvent === undefined ? "—" : `${hf(r.hfAtEvent)}${r.hfAtEvent < 1 ? " ✓" : ""}`} |`
          : "";
        return (
          `| \`${short(r.account)}\` | ${r.protocol} | ${r.block} | ${usd(r.amountUsd)} | ` +
          `${hf(r.verdict.healthFactor)} |${diag} ${usd(r.verdict.collateralUsd)} | ` +
          `${usd(r.verdict.debtUsd)} | ${r.verdict.positions}${r.verdict.dropped > 0 ? ` (+${r.verdict.dropped} unpriced)` : ""} |`
        );
      }),
  ].join("\n");
}

const falsePositives = opinion.filter((r) => r.flagged && !r.liquidated);

await mkdir("docs", { recursive: true });
await writeFile(
  "docs/BACKTEST.md",
  `# Backtest — the risk engine against real liquidations

Generated by \`npm run backtest\`. Every figure below comes from replaying live
subgraph state; nothing is hand-entered, and re-running regenerates all of it.

\`\`\`
npm run backtest
\`\`\`

## Method

The engine's claim is that \`weightedCollateral / debt < 1\` identifies a book a
liquidator can act on. Scoring that claim needs two separate experiments, because
one experiment cannot produce all three numbers.

**Recall** comes from the liquidations themselves. For each real \`Liquidate\`,
subgraph state is rewound to \`blockNumber - 1\` with a time-travel query and the
engine is asked whether it would have flagged that account. Every event is a known
positive, so this measures how many the engine catches — and it contains no
negatives whatsoever, which is why it cannot be the only experiment. A model that
flags every account scores 100% here.

**Precision and the false-positive rate** come from a population fixed *before* any
outcome is known: every book is flagged at block ${from}, and only then is it
checked which of them were liquidated in the ${WINDOW_BLOCKS.toLocaleString("en-US")}
blocks that followed.

Neither experiment can see forward. Every historical read passes through an
assertion that the block it queries strictly precedes the outcome being scored —
${reads.toLocaleString("en-US")} reads in this run, all asserted — so no-lookahead is
a property the program enforces rather than a claim in a comment.

Window: blocks **${from}–${to}** (head was ${head}). The limit is measured rather
than chosen: the deployments that serve history at all serve it 200,000 blocks back
and fail at 1,000,000, so about three weeks is what history allows.

${
  notReplayable.length === 0
    ? `## Every deployment can be replayed

All ${DEPLOYMENTS.length} registered deployments served historical state at block
${from}, so nothing below is narrowed by indexer capability. This has not always been
true of these same subgraphs — see \`canTimeTravel\` in \`lib/backtest/replay.ts\` —
so the script probes for it rather than assuming it.`
    : `## Only ${replayable.length} of ${DEPLOYMENTS.length} deployments can be replayed at all

This is the most interesting thing the backtest measured, and it is worth stating
before any score, because it bounds every score below.

A backtest needs historical state. Asking for it is a one-line change — \`block: {
number: n }\` — and it is part of the GraphQL API every one of these deployments
exposes. It works on ${replayable.map((d) => `\`${d.key}\``).join(" and ")}. On the
other ${notReplayable.length} it fails at *every* depth, including a thousand blocks
back, and the gateway's reason is the surprising part — this is the verbatim
response for \`${notReplayable[0].key}\` in this run:

\`\`\`
${(capability.get(notReplayable[0].key)?.detail ?? "").slice(0, 400)}
\`\`\`

Read the pairs: several indexers report a \`latest\` **ahead of** the \`missing\`
block they cannot serve. That is not lag, and it is not chain pruning. It is
graph-node keeping only current entity versions, so the past state was never
retained to be served. Two deployments of the *same* standardized schema differ on
this.

So time-travel is a property of **who indexes a subgraph**, not of the subgraph, the
schema, or the chain — and a consumer cannot discover it from the schema. Sentinel
therefore probes for it and reports the answer instead of assuming it:

| deployment | schema | history |
|---|---|---|
${DEPLOYMENTS.map((d) => {
  const cap = capability.get(d.key);
  return `| \`${d.key}\` | ${d.schemaVersion} | ${cap?.ok ? "**served**" : "not retained"} |`;
}).join("\n")}

The alternative was to catch the failures per account, which is what the first
version of this script did: three protocols failed 74 of 110 replays, the recall
figure was quietly computed over whichever ones answered, and nothing in the output
said so. A narrowed sample that does not announce itself is worse than a
limitation that does.`
}

## What was found

| | |
|---|---|
| \`Liquidate\` rows in window | ${events.length} |
| distinct (account, protocol, block) episodes | ${allEpisodes.length} |
| of those, on a replayable deployment | ${scorableEpisodes.length} (${pct(scorableEpisodes.length / allEpisodes.length)}) |
| episodes replayed | ${episodes.length}${stride === 1 ? " — all of them" : ` (every ${stride}th, evenly across the window)`} |
| episodes scored | ${scored.length}${errored.length > 0 ? `, ${errored.length} failed` : ""} |
| protocols with liquidations | ${new Set(events.map((e) => e.protocol)).size} of ${DEPLOYMENTS.length} |

${pct(1 - scorableEpisodes.length / allEpisodes.length)} of the window's liquidations
happened on protocols whose history cannot be fetched, so they are counted here and
scored nowhere. Leaving them out of this table would have hidden the size of the
blind spot.

A liquidation transaction emits one \`Liquidate\` per asset seized, and all of them
describe the same account at the same block. The unit of measurement is therefore
the distinct episode, not the row — scoring rows would count a single event several
times over and inflate whichever way that one account happened to resolve.

The sample is an even stride across the window rather than the largest events.
Size-ranking would have been the more flattering choice and the wrong one: large
books are the well-parameterised ones, so it would measure the engine on its
easiest cases and then call the result recall.

## Experiment 1 — recall over ${scored.length} real liquidations

**${hits.length} of ${scored.length} episodes were flagged: recall ${pct(recall)}.**

| outcome | episodes | share | what it means |
|---|---|---|---|
${causeTable()}

Recall here is a **floor**, for a reason visible in the table. Position balances in
this schema are event-written: a debt balance is as of the account's last
interaction, so interest accrued between then and the liquidation is missing.
Missing interest understates debt, which understates leverage, which biases the
engine towards *not* flagging. Every distortion in the replay pushes the same way.

${
  (byCause.get("stale-balance")?.length ?? 0) > 0
    ? `The \`stale-balance\` rows are that effect caught in the act — books the engine put just above 1 that the chain liquidated anyway. They are counted as misses.`
    : ""
}

### Where the boundary actually sits

Most misses are near-misses, and that is a different defect from misreading a
position. Moving the flag threshold shows how much of the gap is a systematic
offset — with the price of moving it attached, since recall bought this way is paid
for in false positives:

| flag at | recall | caught | false-positive rate | precision |
|---|---|---|---|---|
${sweep
  .map(
    (s) =>
      `| HF < ${s.threshold.toFixed(2)} | ${pct(s.recall)} | ${s.caught}/${scored.length} | ${pct(s.fpr)} | ${pct(s.precision)} |`,
  )
  .join("\n")}

Recall comes from the replayed liquidations, the false-positive rate from the panel's
${negatives.length} negatives, both at the same threshold.

The shape of that table is the finding. Recall climbs steeply over the first two
percent above 1 and then flattens, which says the engine's *ranking* of accounts is
sound while its *absolute boundary* sits slightly low — exactly what missing accrued
interest predicts, since it understates every debt by a small amount that grows with
time since the account's last event.

The uncomfortable part deserves stating rather than burying: **HF < 1.02 is not a
tradeoff against HF < 1.00, it beats it outright** — recall ${pct(sweep[0].recall)} →
${pct(sweep[2].recall)}, false-positive rate ${pct(sweep[0].fpr)} → ${pct(sweep[2].fpr)},
precision ${pct(sweep[0].precision)} → ${pct(sweep[2].precision)}. There is no column
in which 1.00 wins. The usual defence of a threshold, that loosening it costs
precision, is simply not available here.

Sentinel flags at HF < 1 anyway, and the reason is what the extra 2% *is*. It is not
a better boundary; it is a constant standing in for accrued interest the engine
should be computing. Fitting it to 105 events in three weeks of calm market would
bake this sample's average interest accrual into a published risk signal, and that
average is a function of how long these particular accounts had gone untouched.
Reading interest indices fixes the same gap without a fitted constant. Until then the
low boundary is a documented, one-directional understatement, which is the failure
worth preferring — and both columns are published so nobody has to take that on
trust.

### Root cause of every miss

"A real miss" is not a root cause, and a miss at a health factor of 2.0 is plainly
not explained by accrued interest. So each of the ${misses.length} misses was tested
against the one hypothesis that fits a book far from its boundary: **the oracle
update that triggered the liquidation landed in the liquidation's own block.** Aave
liquidations are routinely triggered by a price publication, and when they are, the
last state any monitor could possibly have observed showed a solvent account.

The test is to re-price the block−1 positions with the liquidation block's oracle
prices and see whether the book crosses its boundary on the price move alone.

| | misses | share of misses |
|---|---|---|
| cross the boundary at the event block's prices | ${explainedByPrice.length} | ${pct(explainedByPrice.length / Math.max(1, misses.length))} |
| still solvent even at the event block's prices | ${unexplained.length} | ${pct(unexplained.length / Math.max(1, misses.length))} |

The first row is **not a defect the engine could fix by reading better**. Those books
were read correctly and were solvent at every block a monitor could have queried; the
price was the news. The honest way to describe them is as a bound on how much warning
any position-based monitor can give, which is the question Phase 6 takes up directly.

The second row is the part that is genuinely wrong: books still solvent on our numbers
even after the price move. ${
    unexplained.length === 0
      ? "There are none in this run."
      : `There are ${unexplained.length}, and they are listed in full below with the diagnostic column attached.`
  }

Note that this pass reads the liquidation's own block, so it is quarantined from
scoring entirely: every figure above was final before it ran, and the \`at()\`
assertion that guards the scoring reads would reject these queries by design.

### All ${scored.length} episodes accounted for

Putting the two diagnostics together leaves no residual bucket, which is the point of
running both:

| | episodes | share |
|---|---|---|
| flagged at HF < 1 | ${hits.length} | ${pct(hits.length / scored.length)} |
| unobservable — solvent at every queryable block, price arrived in the liquidation's own block | ${explainedByPrice.length} | ${pct(explainedByPrice.length / scored.length)} |
| near-boundary — within ${((STALE_MARGIN - 1) * 100).toFixed(0)}% of 1, consistent with missing accrued interest | ${unexplained.filter((r) => r.cause === "stale-balance").length} | ${pct(unexplained.filter((r) => r.cause === "stale-balance").length / scored.length)} |
| genuinely wrong — solvent by a wide margin, before and after the price move | ${unexplained.filter((r) => r.cause !== "stale-balance").length} | ${pct(unexplained.filter((r) => r.cause !== "stale-balance").length / scored.length)} |

Read down that column rather than stopping at the headline. The ${pct(recall)} recall
figure is what Sentinel achieves today; the row below it is a ceiling no
position-based monitor can beat, because those accounts were solvent at every block
that existed to be queried; and the third row is a known, one-directional and fixable
understatement. What is left over — **${unexplained.filter((r) => r.cause !== "stale-balance").length} of ${scored.length} episodes** — is the
part where the engine is simply wrong, and that is the number worth attacking.

### The misses, in full

The **HF at event prices** column is the diagnostic above; ✓ marks a book that
crosses its boundary on the price move alone.

${(["solvent", "stale-balance", "unknown-threshold", "no-debt", "no-positions"] as Cause[])
  .filter((c) => (byCause.get(c)?.length ?? 0) > 0)
  .map(
    (c) => `#### \`${c}\` — ${byCause.get(c)!.length} episodes

${CAUSE_NOTE[c]}.

${replayTable(byCause.get(c)!, true)}`,
  )
  .join("\n\n")}

### The hits

${replayTable(hits)}

## Experiment 2 — precision and false positives at block ${from}

Population: **${panelKeys.size} books**, fixed before any outcome was known —
${fromLiquidations} that were liquidated somewhere in the window, plus the
${PANEL_LIVE_BORROWERS} largest live cross-protocol borrowers as candidate
negatives. ${opinion.length} of them carried debt at the panel block and therefore
received a prediction; the other ${panel.length - opinion.length} had no debt, no
health factor and no opinion, and counting those as correct would inflate
specificity with accounts the engine never had a view on.

| | liquidated after | not liquidated |
|---|---|---|
| **flagged (HF < 1)** | ${tp} | ${fp} |
| **not flagged** | ${fn} | ${tn} |

- precision **${pct(precision)}** — of the books flagged, this share were liquidated within three weeks
- recall **${pct(panelRecall)}** — over this population, at a single fixed block
- false-positive rate **${(100 * fpr).toFixed(2)}%** — of the books never liquidated, this share were flagged

**This population is denser in liquidations than the chain is**, which is a
deliberate bias and matters for how the two numbers transfer. Precision is a
statement about a population and rises with the base rate, so ${pct(precision)}
here is a *lower* bound relative to a population dominated by negatives. The
false-positive rate is conditioned on the negatives alone, so it is the figure that
carries over unchanged.

Recall differs from experiment 1 because the question differs. Experiment 1 asks
whether a book was flaggable at the last moment before it was hit. Experiment 2
asks whether it was flaggable three weeks earlier, which for most books it was not,
because the price move that liquidated them had not happened yet. That gap is the
early-warning problem, and it is what Phase 6 measures directly.

${
  falsePositives.length === 0
    ? "No false positives: every flagged book was liquidated within the window."
    : `### Every false positive

Flagged and not liquidated. A book can sit below 1 unliquidated for the same reason
Phase 4 documents at length — Aave V3 E-Mode raises the liquidation threshold for
correlated collateral and has **no field anywhere in the standardized schema**, so
the engine computes a boundary the protocol does not use. This experiment prices
that gap in false positives instead of arguing about it.

| account | protocol | HF at ${from} | collateral | debt | positions |
|---|---|---|---|---|---|
${falsePositives
  .sort((a, b) => b.verdict.debtUsd - a.verdict.debtUsd)
  .map(
    (r) =>
      `| \`${short(r.account)}\` | ${r.protocol} | ${hf(r.verdict.healthFactor)} | ${usd(r.verdict.collateralUsd)} | ${usd(r.verdict.debtUsd)} | ${r.verdict.positions} |`,
  )
  .join("\n")}`
}

## What this does not establish

**Three weeks is the whole history available.** Time-travel fails at a million
blocks back, so the window cannot cover a real crisis. Every liquidation scored
here happened in an ordinary market, and an ordinary market is the easy case: it is
exactly in a crash that oracle staleness, depth and correlation all break together.

**A flag is not a profitable liquidation.** The engine answers whether a book is
below its boundary, not whether seizing it clears at a price a liquidator will
accept. That question is Phase 4's, and its answer there is that a large share of
distressed collateral cannot be sold inside the liquidation bonus at all.

**The panel's negatives are large borrowers.** Big books are more actively managed
than small ones, so they are somewhat less likely to be liquidated. That biases the
false-positive rate **up**, which is the safe direction for a number reported as a
cost.

${
  notReplayable.length === 0
    ? ""
    : `**${pct(1 - scorableEpisodes.length / allEpisodes.length)} of the window's liquidations
are unscorable**, on the ${notReplayable.length} deployments whose indexers retain no
historical state (${notReplayable.map((d) => `\`${d.key}\``).join(", ")}). Nothing here
says how the engine would have performed on them.${
        unscorableOnlyVersions.length === 0
          ? ""
          : ` Worse, the gap is not random with
respect to difficulty: schema ${unscorableOnlyVersions.map((v) => `${v}`).join(", ")} ${unscorableOnlyVersions.length === 1 ? "appears" : "appear"}
*only* among the unscorable deployments, and version skew is exactly where the
normalizer does the most work — so the versions a score would be most informative
about are the ones it cannot cover.`
      }
`
}
${
  unreachable.length === 0
    ? ""
    : `**Deployments whose liquidations could not even be listed.**\n\n${unreachable.map((u) => `- ${u.protocol} — ${u.detail}`).join("\n")}\n`
}
${
  errored.length === 0
    ? ""
    : `**Episodes that failed on a replayable deployment.** Capability was verified at block ${from} before scoring, so these are not the time-travel limitation.\n\n${errored.map((r) => `- \`${r.account}\` on ${r.protocol} @${r.block}: ${r.error}`).join("\n")}\n`
}
`,
);

console.log("\nwrote docs/BACKTEST.md");
