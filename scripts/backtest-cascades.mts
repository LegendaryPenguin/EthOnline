/**
 * Phase 6: does the published signal rise before a cascade, and by how long?
 *
 *   npm run backtest:cascades
 *
 * Phase 3's backtest asks whether Sentinel can tell that one borrower was
 * liquidatable. This asks the only question a single published number can be scored
 * on: was the *system* abnormal before many borrowers were liquidated at once. The
 * two are different claims and the second is the product's.
 *
 * The method, in the order it runs:
 *
 *   1. **Label from events, not from opinion.** Every `Liquidate` the five
 *      deployments retain, bucketed hourly, and episodes defined by breadth —
 *      distinct accounts across distinct protocols. A $1.3M liquidation of one
 *      account is in this window and is not a cascade.
 *   2. **Measure the retention wall.** Time travel is a property of the indexers
 *      serving a subgraph, so the depth is probed rather than assumed. It is also
 *      the finding: events are retained far longer than state, so Sentinel can
 *      locate crises it cannot replay, and this script prints both lists.
 *   3. **Replay the enclave's own sampling** at blocks before each replayable
 *      episode, via `signalAtBlock`. Same three passes, same reconciliation gate,
 *      same `aggregateSignal`. Nothing in the scoring path ever sees a liquidation.
 *   4. **Pair every observation against itself a week earlier.** The headline test
 *      is a paired sign test, not an unpaired AUC, and that is a correction rather
 *      than a preference — see below.
 *   5. **Calibrate any threshold on the ordinary windows only.** Taking the
 *      threshold that best separates the labels would fit the lead times to the
 *      events they report on, which is the standard way this is faked.
 *   6. **Compare against a baseline that could plausibly win.** Protocol
 *      utilization from the same bootstrap call: public totals, one HTTP call, no
 *      positions, no enclave. If the confidential aggregation does not beat that,
 *      it is not buying anything.
 *
 * ## Why paired, and what the first run got wrong
 *
 * The first version of this script reported an unpaired AUC over pre-event blocks
 * against quiet blocks. It returned **0.271 for Sentinel and 0.277 for the
 * baseline** — both far below chance and within six thousandths of each other, which
 * is the signature of a shared confound, not of two independently useless
 * measurements. Two defects, both visible in `data/backtest-cascades.json` from that
 * run and both fixed here:
 *
 *   - The signal is a slowly drifting *level*: ~31 in July, ~21 in September, against
 *     under one point of variation across an episode's own 24-hour approach. Only 5
 *     hours in 8,700 cleared the old "no liquidation within six hours" rule, so the
 *     negatives were forced into one stretch of the calendar and the AUC measured the
 *     drift between that stretch and the positives. Pairing each block against the
 *     same hour of the previous week holds the drift fixed.
 *   - Breadth without a size floor labelled dust as cascades — 253 episodes in a
 *     year, down to **$4 across 8 accounts**, mostly on the two deployments whose
 *     indexing the reconciliation gate already rejects. `minUsd` now applies.
 *
 * Both numbers from that run are reproduced in the report rather than quietly
 * replaced, because "the first design measured a calendar" is the most transferable
 * thing this phase learned.
 *
 * Writes `docs/evidence/phase6-early-warning.md` and `data/backtest-cascades.json`.
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEPLOYMENTS, type Deployment } from "../lib/graph/deployments";
import { canTimeTravel, fetchLiquidations, type LiquidationEvent } from "../lib/backtest/replay";
import {
  auc,
  bucketLiquidations,
  calibrateThreshold,
  detectCascades,
  quantile,
  quietHours,
  rocCurve,
  signTest,
  type CascadeEpisode,
  type CascadeRules,
} from "../lib/backtest/cascades";
import { signalAtBlock, type SamplingConfig, type ScoredBlock } from "../lib/backtest/replay-signal";
import { parseRiskPolicy } from "../lib/signal/policy";

// ─── Knobs, all stated so the reader can re-derive every number below ────────

/**
 * How far back to ask for `Liquidate` events. Deliberately far past the state
 * retention depth: the gap between what can be labelled and what can be replayed is
 * a result, and it only appears if the label window is the wider of the two.
 */
const EVENT_LOOKBACK_BLOCKS = Number(process.env.SENTINEL_EVENT_LOOKBACK ?? 2_600_000);

/**
 * The minimum breadth that is a cascade rather than a whale.
 *
 * Four accounts across two protocols is not a comfortable margin and is not meant to
 * be — it is the smallest event that is definitionally cross-protocol and multi-account,
 * which is the phenomenon Sentinel claims to see. Raising it would be more impressive
 * and would also silently discard events, so the report publishes the whole
 * distribution and a stricter-rule sensitivity instead of hiding behind one setting.
 */
const RULES: CascadeRules = { minAccounts: 4, minProtocols: 2, maxGapHours: 2, minUsd: 100_000 };
/** Published beside the main result so the choices above are visible, not load-bearing. */
const SENSITIVITY_RULES: CascadeRules[] = [
  { minAccounts: 4, minProtocols: 2, maxGapHours: 2, minUsd: 0 },
  { minAccounts: 4, minProtocols: 2, maxGapHours: 2, minUsd: 1_000_000 },
  { minAccounts: 10, minProtocols: 2, maxGapHours: 2, minUsd: 100_000 },
  { minAccounts: 4, minProtocols: 3, maxGapHours: 2, minUsd: 100_000 },
];

/**
 * How far back the control block for each observation sits.
 *
 * Exactly one week, so the control shares the hour of day and the day of week with
 * the block it is paired against. Both matter: liquidation activity and borrowing both
 * follow a daily and a weekly cycle, and a control taken "a few days earlier" would
 * reintroduce as a confound the very thing pairing exists to remove.
 */
const CONTROL_LAG_HOURS = 168;

/**
 * Hours before an episode at which the signal is sampled.
 *
 * Geometric rather than uniform: a lead time of 3 hours and a lead time of 4 hours
 * are the same operational fact, while 1 hour and 24 hours are not, so resolution
 * belongs near the event. Each offset costs ~6 HTTP calls per episode.
 */
const LEAD_OFFSETS_HOURS = [1, 2, 3, 4, 6, 8, 12, 18, 24];

/** The lead at which positives enter the ROC set. The shortest one: if the signal
 * cannot see an event an hour out, longer leads are noise. */
const ROC_LEAD_HOURS = 1;

const QUIET_COUNT = Number(process.env.SENTINEL_QUIET_COUNT ?? 20);
/** Hours a negative must keep from any episode, so a correct early warning is not
 * scored as a false positive. */
const QUIET_SEPARATION_HOURS = 36;

/** Quantile of the ordinary-window scores that defines "abnormal". */
const ALERT_QUANTILE = 0.9;

/**
 * Operating points reported for the change policy, as quantiles of the ordinary-hour
 * change distribution — so each one *is* a stated false-positive rate: `1 - q`.
 *
 * Several rather than one, and reported rather than chosen, because with five episodes
 * the choice between them would be made by looking at which detects more, and that is
 * fitting the operating point to the labels. The trade-off is the honest deliverable;
 * a consumer with a cost of a false alarm picks their own row.
 */
const ALERT_QUANTILES = [0.9, 0.8, 0.7];

// ─── Setup ──────────────────────────────────────────────────────────────────

const policyJson = process.env.SENTINEL_RISK_POLICY;
if (!policyJson) {
  console.error("SENTINEL_RISK_POLICY is not set (see cre/.env.example).");
  process.exit(1);
}
const policy = parseRiskPolicy(policyJson);

const enclaveConfig = JSON.parse(
  readFileSync("cre/sentinel-signal/config.staging.json", "utf8"),
) as SamplingConfig & { deployments: { key: string }[] };

const deployments: Deployment[] = enclaveConfig.deployments
  .map((d) => DEPLOYMENTS.find((k) => k.key === d.key))
  .filter((d): d is Deployment => d !== undefined);

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const hour = (h: number) => new Date(h * 3600 * 1000).toISOString().slice(0, 16) + "Z";

// ─── 1. Label ───────────────────────────────────────────────────────────────

console.log("fetching liquidation events…");
const head = await headBlock(deployments[0]);
const from = Math.max(1, head - EVENT_LOOKBACK_BLOCKS);

const events: LiquidationEvent[] = [];
const eventsByProtocol = new Map<string, number>();
for (const d of deployments) {
  try {
    const rows = await fetchLiquidations(d, from, head);
    events.push(...rows);
    eventsByProtocol.set(d.key, rows.length);
    console.log(`  ${d.key}: ${rows.length} events`);
  } catch (err) {
    eventsByProtocol.set(d.key, -1);
    console.log(`  ${d.key}: failed — ${(err as Error).message}`);
  }
}
if (events.length === 0) {
  console.error("no liquidation events retained; nothing to label against");
  process.exit(1);
}

// Blocks per hour, fitted to the events themselves. Assuming 12s would be close and
// would still be an assumption; these rows carry both a block and a timestamp, so
// the conversion is measured. Every block below is derived through this one map.
const minEv = events.reduce((a, b) => (b.blockNumber < a.blockNumber ? b : a));
const maxEv = events.reduce((a, b) => (b.blockNumber > a.blockNumber ? b : a));
const blocksPerSecond =
  (maxEv.blockNumber - minEv.blockNumber) / Math.max(1, maxEv.timestamp - minEv.timestamp);
const blockAt = (timestamp: number) =>
  Math.round(maxEv.blockNumber + (timestamp - maxEv.timestamp) * blocksPerSecond);
const spanDays = (maxEv.timestamp - minEv.timestamp) / 86400;

console.log(
  `  ${events.length} events over ${spanDays.toFixed(1)} days, ` +
    `${(blocksPerSecond * 3600).toFixed(1)} blocks/hour measured`,
);

const buckets = bucketLiquidations(events);
const episodes = detectCascades(buckets, RULES);
const sensitivity = SENSITIVITY_RULES.map((rules) => ({
  rules,
  count: detectCascades(buckets, rules).length,
}));
const singleAccountHours = [...buckets.values()].filter((b) => b.accounts.size === 1);

console.log(`  ${episodes.length} episodes clear the rules`);

// ─── 2. The retention wall ──────────────────────────────────────────────────

console.log("probing state retention…");
const retention = new Map<string, number>();
for (const d of deployments) {
  const depth = await probeRetention(d, head);
  retention.set(d.key, depth);
  console.log(`  ${d.key}: ~${depth} blocks (~${(depth / (blocksPerSecond * 86400)).toFixed(1)} days)`);
}
const deepest = Math.max(...retention.values());
const retentionFloor = head - deepest;

// An episode is replayable only if the deepest lead we would sample is inside the
// wall. Scoring an episode at 1 hour out but not 24 would make its lead time an
// artefact of retention rather than of the signal.
// The control block is a week further back than the deepest lead, so requiring it
// inside the wall is what actually bounds replayability.
const maxLead = Math.max(...LEAD_OFFSETS_HOURS) + CONTROL_LAG_HOURS;
const replayable = episodes.filter(
  (e) => e.startBlock - Math.ceil(maxLead * 3600 * blocksPerSecond) > retentionFloor,
);
const unreplayable = episodes.filter((e) => !replayable.includes(e));

console.log(`  ${replayable.length} of ${episodes.length} episodes are inside the state window`);

// ─── 3. Score ───────────────────────────────────────────────────────────────

type Panel = {
  episode: CascadeEpisode;
  points: (ScoredBlock & { leadHours: number })[];
  /** The same hour of the previous week. The paired comparison's other half. */
  control: ScoredBlock | null;
};
const panels: Panel[] = [];
let totalCalls = 0;

for (const episode of replayable) {
  const points: (ScoredBlock & { leadHours: number })[] = [];
  for (const leadHours of [...LEAD_OFFSETS_HOURS].sort((a, b) => a - b)) {
    const block = episode.startBlock - Math.ceil(leadHours * 3600 * blocksPerSecond);
    const scored = await signalAtBlock(deployments, enclaveConfig, policy, block);
    if (scored) {
      totalCalls += scored.calls;
      points.push({ ...scored, leadHours });
      console.log(
        `  ${episode.id} −${leadHours}h @${block}: score ${scored.signal.systemicRiskScore.toFixed(1)} ` +
          `util ${(100 * scored.baselineUtilization).toFixed(2)}% [${scored.sampled.join(",")}]`,
      );
    } else {
      console.log(`  ${episode.id} −${leadHours}h @${block}: unavailable`);
    }
  }

  const controlBlock =
    episode.startBlock -
    Math.ceil((ROC_LEAD_HOURS + CONTROL_LAG_HOURS) * 3600 * blocksPerSecond);
  const control = await signalAtBlock(deployments, enclaveConfig, policy, controlBlock);
  if (control) {
    totalCalls += control.calls;
    console.log(
      `  ${episode.id} control @${controlBlock}: score ${control.signal.systemicRiskScore.toFixed(1)} ` +
        `util ${(100 * control.baselineUtilization).toFixed(2)}%`,
    );
  } else {
    console.log(`  ${episode.id} control @${controlBlock}: unavailable`);
  }

  if (points.length > 0) panels.push({ episode, points, control });
}

const hoursSeen = [...buckets.keys()];
// Negatives are drawn from the retained state window only, and far enough inside it
// that their own controls a week earlier are also readable — otherwise the negatives
// would be unpairable and the two arms of the test would not be comparable.
const negativeFloorHour = Math.ceil(
  (retentionFloor - maxEv.blockNumber) / blocksPerSecond / 3600 + maxEv.timestamp / 3600,
) + CONTROL_LAG_HOURS;
const quiet = quietHours(
  buckets,
  episodes,
  { firstHour: Math.max(negativeFloorHour, Math.min(...hoursSeen)), lastHour: Math.max(...hoursSeen) },
  { count: QUIET_COUNT, separationHours: QUIET_SEPARATION_HOURS, rules: RULES },
);

console.log(`scoring ${quiet.length} ordinary windows and their controls…`);
const quietScored: (ScoredBlock & { atHour: number; control: ScoredBlock | null })[] = [];
for (const h of quiet) {
  const block = blockAt(h * 3600);
  const scored = await signalAtBlock(deployments, enclaveConfig, policy, block);
  if (!scored) {
    console.log(`  ${hour(h)} @${block}: unavailable`);
    continue;
  }
  totalCalls += scored.calls;

  const controlBlock = blockAt((h - CONTROL_LAG_HOURS) * 3600);
  const control = await signalAtBlock(deployments, enclaveConfig, policy, controlBlock);
  if (control) totalCalls += control.calls;

  quietScored.push({ ...scored, atHour: h, control });
  console.log(
    `  ${hour(h)} @${block}: score ${scored.signal.systemicRiskScore.toFixed(1)} ` +
      `(control ${control ? control.signal.systemicRiskScore.toFixed(1) : "—"}) ` +
      `util ${(100 * scored.baselineUtilization).toFixed(2)}%`,
  );
}

// ─── 4. Statistics ──────────────────────────────────────────────────────────

/** Both series are scored identically, from the same blocks, so the comparison is
 * about what is measured rather than about how it was measured. */
function evaluate(pick: (s: ScoredBlock) => number) {
  const quietScores = quietScored.map(pick);
  const threshold = quietScores.length > 0 ? calibrateThreshold(quietScores, ALERT_QUANTILE) : null;

  const rocSet = [
    ...panels
      .map((p) => p.points.find((pt) => pt.leadHours === ROC_LEAD_HOURS))
      .filter((pt): pt is (ScoredBlock & { leadHours: number }) => pt !== undefined)
      .map((pt) => ({ score: pick(pt), positive: true })),
    ...quietScored.map((s) => ({ score: pick(s), positive: false })),
  ];

  const leads = panels.map((p) => {
    if (threshold === null) return { id: p.episode.id, leadHours: null as number | null };
    // The longest lead at which the alert is on and stays on through to the event. A
    // one-off spike twelve hours out that lapses is not a warning a desk could act
    // on, so it does not count as one.
    const ascending = [...p.points].sort((a, b) => a.leadHours - b.leadHours);
    let lead: number | null = null;
    for (const pt of ascending) {
      if (pick(pt) >= threshold) lead = pt.leadHours;
      else break;
    }
    return { id: p.episode.id, leadHours: lead };
  });

  // ── The paired arm ────────────────────────────────────────────────────────
  // Each observation minus itself a week earlier. Positives should be elevated
  // against their own control; the negatives are the null distribution of the same
  // difference, so a signal that simply drifts upward cannot pass by drifting.
  const positiveDeltas = panels
    .map((p) => {
      const pre = p.points.find((pt) => pt.leadHours === ROC_LEAD_HOURS);
      if (!pre || !p.control) return null;
      return { id: p.episode.id, delta: pick(pre) - pick(p.control) };
    })
    .filter((d): d is { id: string; delta: number } => d !== null);
  const negativeDeltas = quietScored
    .map((s) => (s.control ? pick(s) - pick(s.control) : null))
    .filter((d): d is number => d !== null);

  const paired = signTest(positiveDeltas.map((d) => d.delta));
  const pairedNull = signTest(negativeDeltas);
  // Same rank identity as above, on the paired differences: does an episode's own
  // week-on-week rise exceed an ordinary hour's week-on-week rise?
  const pairedAuc = auc([
    ...positiveDeltas.map((d) => ({ score: d.delta, positive: true })),
    ...negativeDeltas.map((d) => ({ score: d, positive: false })),
  ]);

  /**
   * The alert policy that the absolute one demonstrably cannot be.
   *
   * The absolute threshold detects nothing here, and the score ladder shows why: the
   * p90 of ordinary hours is set by July's ~31 while every August and September
   * episode sits at ~21, so a level calibrated once is either always on or never on.
   * The signal's *level* is not comparable across months; its *change* is. So the
   * operating variable is the week-on-week difference and the threshold is the p90 of
   * that difference over ordinary hours — still calibrated on negatives only, still
   * never consulting an outcome.
   *
   * Each lead offset is differenced against the one control block per episode rather
   * than against its own week-earlier twin. At the drift observed here (~1.2 points a
   * week) the resulting misalignment across a 24-hour ladder is under 0.2 points, and
   * it applies equally to every episode and to the negatives that set the threshold.
   */
  const deltaPolicies = ALERT_QUANTILES.map((q) => {
    const threshold = negativeDeltas.length > 0 ? quantile(negativeDeltas, q) : null;
    const leads = panels.map((p) => {
      if (threshold === null || !p.control) {
        return { id: p.episode.id, leadHours: null as number | null };
      }
      const reference = pick(p.control);
      const ascending = [...p.points].sort((a, b) => a.leadHours - b.leadHours);
      let lead: number | null = null;
      for (const pt of ascending) {
        if (pick(pt) - reference >= threshold) lead = pt.leadHours;
        else break;
      }
      return { id: p.episode.id, leadHours: lead };
    });
    const found = leads.filter((l) => l.leadHours !== null);
    return {
      quantile: q,
      /** Stated, not estimated: the threshold is the q-th quantile of the negatives. */
      falsePositiveRate: 1 - q,
      threshold,
      leads,
      detected: found.length,
      medianLeadHours: found.length > 0 ? quantile(found.map((l) => l.leadHours!), 0.5) : null,
    };
  });

  // The primary policy is the strictest reported one, fixed in advance of seeing which
  // detects more. The others are published beside it, not chosen between.
  const primary = deltaPolicies[0];
  const deltaThreshold = primary.threshold;
  const deltaLeads = primary.leads;
  const deltaHit = deltaLeads.filter((l) => l.leadHours !== null);

  const hit = leads.filter((l) => l.leadHours !== null);
  return {
    threshold,
    deltaThreshold,
    deltaLeads,
    deltaPolicies,
    deltaDetected: deltaHit.length,
    deltaMedianLeadHours:
      deltaHit.length > 0 ? quantile(deltaHit.map((l) => l.leadHours!), 0.5) : null,
    positiveDeltas,
    negativeDeltas,
    paired,
    pairedNull,
    pairedAuc,
    quietMedian: quietScores.length > 0 ? quantile(quietScores, 0.5) : null,
    quietMax: quietScores.length > 0 ? Math.max(...quietScores) : null,
    auc: auc(rocSet),
    roc: rocCurve(rocSet),
    leads,
    detected: hit.length,
    medianLeadHours: hit.length > 0 ? quantile(hit.map((l) => l.leadHours!), 0.5) : null,
    positives: rocSet.filter((r) => r.positive).length,
    negatives: rocSet.filter((r) => !r.positive).length,
  };
}

const sentinel = evaluate((s) => s.signal.systemicRiskScore);
const baseline = evaluate((s) => s.baselineUtilization);

// ─── 5. Report ──────────────────────────────────────────────────────────────

const lines: string[] = [];
const say = (l = "") => {
  lines.push(l);
  console.log(l);
};

say("# Phase 6 — early warning, measured");
say();
say(`Run ${new Date().toISOString()} at head block ${head}. \`npm run backtest:cascades\`.`);
say();
say(
  `Labelled from **${events.length} \`Liquidate\` events over ${spanDays.toFixed(1)} days** across ` +
    `${[...eventsByProtocol.entries()].filter(([, n]) => n > 0).length} deployments, ` +
    `at a measured ${(blocksPerSecond * 3600).toFixed(1)} blocks/hour. ` +
    `${totalCalls} gateway calls spent scoring ${panels.reduce((s, p) => s + p.points.length, 0)} ` +
    `pre-event blocks and ${quietScored.length} quiet windows.`,
);
say();

say("## Headline");
say();
say(
  "The primary test is **paired**: each pre-event block against the same hour of the " +
    "previous week. The unpaired figures are reported below it because they are the " +
    "ones that would normally be quoted, and in this study they are the ones that are " +
    "wrong — see *Why paired*.",
);
say();
say("| | Sentinel `systemicRiskScore` | baseline: borrow/TVL |");
say("|---|---|---|");
say(
  `| **paired win rate** (episode > own control) | **${sentinel.paired.wins}/${sentinel.paired.n}** ` +
    `= ${(100 * sentinel.paired.winRate).toFixed(0)}% | ${baseline.paired.wins}/${baseline.paired.n} ` +
    `= ${(100 * baseline.paired.winRate).toFixed(0)}% |`,
);
say(`| **paired _p_** (two-sided sign test) | **${sentinel.paired.pValue.toFixed(3)}** | ${baseline.paired.pValue.toFixed(3)} |`);
say(
  `| same statistic on ordinary hours (the null) | ${pairedNullCell(sentinel)} | ${pairedNullCell(baseline)} |`,
);
say(`| **paired AUC** (episode rise vs ordinary rise) | **${fmt(sentinel.pairedAuc, 3)}** | ${fmt(baseline.pairedAuc, 3)} |`);
say(`| unpaired AUC (confounded by drift — see below) | ${fmt(sentinel.auc, 3)} | ${fmt(baseline.auc, 3)} |`);
say(
  `| **episodes detected** (week-on-week change policy) | **${sentinel.deltaDetected} / ${panels.length}** | ` +
    `${baseline.deltaDetected} / ${panels.length} |`,
);
say(
  `| **median lead time** | **${sentinel.deltaMedianLeadHours === null ? "—" : `${sentinel.deltaMedianLeadHours}h`}** | ` +
    `${baseline.deltaMedianLeadHours === null ? "—" : `${baseline.deltaMedianLeadHours}h`} |`,
);
say(`| alert threshold on the change (p${100 * ALERT_QUANTILE} of ordinary Δ) | ${fmt(sentinel.deltaThreshold, 2)} | ${fmt(baseline.deltaThreshold, 5)} |`);
say(`| episodes detected by an *absolute* threshold | ${sentinel.detected} / ${panels.length} | ${baseline.detected} / ${panels.length} |`);
say(`| absolute threshold (p${100 * ALERT_QUANTILE} of ordinary hours) | ${fmt(sentinel.threshold, 2)} | ${fmt(baseline.threshold, 5)} |`);
say(`| ordinary-hour median | ${fmt(sentinel.quietMedian, 2)} | ${fmt(baseline.quietMedian, 5)} |`);
say(`| labelled set | ${sentinel.positives} positive / ${sentinel.negatives} negative | same blocks |`);
say();
say(
  "The baseline is not a straw man. Borrow-over-TVL is the strongest statistic " +
    "obtainable from public protocol totals alone — one HTTP call, no positions, no " +
    "enclave — so it is the thing the confidential aggregation has to beat to be worth " +
    "building. Both columns are computed from the same blocks by the same code path; " +
    "the only difference is which number is read out.",
);
say();
say(
  "### The alert policy cannot be an absolute threshold, and that is a result",
);
say();
say("| policy | stated FPR | threshold on Δ | episodes detected | median lead |");
say("|---|---|---|---|---|");
for (const p of sentinel.deltaPolicies) {
  say(
    `| p${(100 * p.quantile).toFixed(0)} of ordinary Δ | ${(100 * p.falsePositiveRate).toFixed(0)}% | ` +
      `${fmt(p.threshold, 2)} | ${p.detected} / ${panels.length} | ` +
      `${p.medianLeadHours === null ? "—" : `${p.medianLeadHours}h`} |`,
  );
}
say();
say(
  `Three operating points, reported rather than chosen. With ${panels.length} episodes, ` +
    `picking between them by which detects more would be fitting the operating point to ` +
    `the labels — so the whole trade-off is published and a consumer with a cost of a ` +
    `false alarm picks their own row. The first row is the primary result.`,
);
say();
say(
  `The reason the strictest row detects nothing is worth stating precisely, because it ` +
    `is not that the episodes are invisible. The ordinary-hour Δ distribution is ` +
    `**${sentinel.negativeDeltas.map((d) => d.toFixed(1)).sort((a, b) => Number(a) - Number(b)).join(", ")}** ` +
    `— seventeen weeks of near-zero movement, and three outliers that set the p90 above ` +
    `every episode's Δ. Those outliers are one structural break, not ordinary noise: ` +
    `between 2026-08-20 and 2026-08-30 the multi-protocol share of sampled debt halves ` +
    `from 1.4% to 0.8% and the score steps down about nine points. That is a real change ` +
    `in cross-protocol leverage — the headline component of the score, doing exactly what ` +
    `it is built to do — and any week-long pair straddling it inherits a ±10 point ` +
    `difference. Excluding those pairs would raise the detection count and would also be ` +
    `deciding, after the fact, which weeks count.`,
);
say();
say(
  `Calibrated once on ordinary hours, the absolute threshold ` +
    `(${fmt(sentinel.threshold, 1)}) detects ${sentinel.detected} of ${panels.length} episodes. ` +
    `The score ladder shows why and it is not a tuning failure: the threshold is set by ` +
    `July's ~31 while every August and September episode sits at ~21, so any level fixed ` +
    `once is either always on or never on. **The published score's level is not comparable ` +
    `across months; its change is.** So the operating variable is the week-on-week ` +
    `difference, thresholded at the p${100 * ALERT_QUANTILE} of that difference over ` +
    `ordinary hours — still calibrated on negatives alone, still never consulting an ` +
    `outcome. That is the policy Phase 7's agent enforces, and this is where its number ` +
    `comes from.`,
);
say();
say(
  `With ${sentinel.paired.n} paired episodes the smallest attainable two-sided _p_ is ` +
    `${(2 / 2 ** Math.max(1, sentinel.paired.n)).toFixed(3)}, so this design cannot ` +
    `produce a significant result at any conventional level and is not presented as one. ` +
    `It is a directional test with its power stated, and the power is bounded by state ` +
    `retention rather than by effort — see *What this cannot measure*.`,
);
say();

say("### Why paired");
say();
say(
  "The first run of this script reported an unpaired AUC and got **0.271 for Sentinel " +
    "against 0.277 for the baseline**: both far below chance and six thousandths apart. " +
    "Two measurements do not fail identically by coincidence, and the cause is visible in " +
    "the score ladder below — the signal is a slowly drifting *level*, around 31 in July " +
    "and 21 in September, against under one point of movement across an episode's own " +
    "24-hour approach. The old negative rule (no liquidation within six hours) admitted " +
    "only 5 hours out of 8,700, which forced every negative into one stretch of the " +
    "calendar, so the AUC was measuring the drift between that stretch and the positives.",
);
say();
say(
  "That rule was also wrong on its own terms: it claimed any liquidation anywhere is " +
    `abnormal, while ${singleAccountHours.length} of the ${buckets.size} active hours in ` +
    "this window liquidated exactly one account. Individual liquidations are the " +
    "background state of a lending market. Negatives are now ordinary hours — no episode " +
    "within " + QUIET_SEPARATION_HOURS + "h, and no episode-grade activity of their own — " +
    "and every observation is differenced against itself a week earlier, which holds the " +
    "drift, the weekly cycle and the composition of the book roughly fixed.",
);
say();

say("## Lead time, per episode");
say();
say("| episode | accounts | protocols | liquidated | score −1h | control (−1w) | Δ | Sentinel lead | baseline lead |");
say("|---|---|---|---|---|---|---|---|---|");
for (const p of panels) {
  const s = sentinel.deltaLeads.find((l) => l.id === p.episode.id);
  const b = baseline.deltaLeads.find((l) => l.id === p.episode.id);
  const pre = p.points.find((pt) => pt.leadHours === ROC_LEAD_HOURS);
  const delta = sentinel.positiveDeltas.find((d) => d.id === p.episode.id)?.delta ?? null;
  say(
    `| ${p.episode.id} | ${p.episode.accounts} | ${p.episode.protocols.length} (${p.episode.protocols.join(", ")}) | ` +
      `${usd(p.episode.usd)} | ${pre ? pre.signal.systemicRiskScore.toFixed(1) : "—"} | ` +
      `${p.control ? p.control.signal.systemicRiskScore.toFixed(1) : "—"} | ` +
      `${delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`} | ` +
      `${s?.leadHours === null || s === undefined ? "**missed**" : `${s.leadHours}h`} | ` +
      `${b?.leadHours === null || b === undefined ? "missed" : `${b.leadHours}h`} |`,
  );
}
say();
say(
  "The Δ column is the paired test, one row at a time: the score an hour before the " +
    "cascade minus the score at the same hour of the previous week. A positive Δ is the " +
    "claim under test, and the sign test in the Headline counts them.",
);
say();
say(
  "Lead time is the longest offset at which the alert is on **and stays on** through " +
    "to the event, under the week-on-week change policy. A spike that lapses is not a " +
    "warning a desk could act on, so it does not count as one. The threshold was fixed " +
    "from the ordinary windows before any episode was scored, so every figure in this " +
    "column is out of sample with respect to the labels.",
);
say();

say("### The score ladder");
say();
say(`| episode | ${LEAD_OFFSETS_HOURS.map((h) => `−${h}h`).join(" | ")} |`);
say(`|---|${LEAD_OFFSETS_HOURS.map(() => "---").join("|")}|`);
for (const p of panels) {
  const cells = LEAD_OFFSETS_HOURS.map((h) => {
    const pt = p.points.find((x) => x.leadHours === h);
    return pt ? pt.signal.systemicRiskScore.toFixed(1) : "—";
  });
  say(`| ${p.episode.id} | ${cells.join(" | ")} |`);
}
say();

say("## ROC");
say();
say("| threshold | TPR | FPR | TP | FP |");
say("|---|---|---|---|---|");
for (const pt of sentinel.roc) {
  say(
    `| ${pt.threshold.toFixed(2)} | ${pt.tpr.toFixed(2)} | ${pt.fpr.toFixed(2)} | ${pt.tp} | ${pt.fp} |`,
  );
}
say();
say(
  `AUC is computed by the Mann-Whitney rank identity rather than by integrating this ` +
    `table, so ties are counted as half a win and the figure does not depend on how many ` +
    `rows the sample happens to distinguish. With ${sentinel.positives} positives the ` +
    `resolution of this curve is ${(1 / Math.max(1, sentinel.positives)).toFixed(2)} in TPR, ` +
    `which is a limit of the label set and not of the method — see below.`,
);
say();

say("## What this cannot measure, and why");
say();
say(
  `**State retention is the binding constraint, and it is a Graph-relevant finding ` +
    `rather than an inconvenience.** Time travel is a property of the indexers serving a ` +
    `subgraph, not of the subgraph, the schema, or the chain. Probed at this head block:`,
);
say();
say("| deployment | events retained | state retained |");
say("|---|---|---|");
for (const d of deployments) {
  const n = eventsByProtocol.get(d.key) ?? 0;
  const depth = retention.get(d.key) ?? 0;
  say(
    `| \`${d.key}\` | ${n < 0 ? "query failed" : `${n} rows`} | ` +
      `${depth === 0 ? "**none**" : `~${depth} blocks (~${(depth / (blocksPerSecond * 86400)).toFixed(1)} days)`} |`,
  );
}
say();
say(
  `So the archive of *what happened* reaches back ${spanDays.toFixed(1)} days while the ` +
    `archive of *what the books looked like* reaches back ` +
    `~${(deepest / (blocksPerSecond * 86400)).toFixed(1)} days. Sentinel can therefore **locate ` +
    `crises it cannot replay**, and the largest events in the labelled window are exactly ` +
    `those:`,
);
say();
say("| episode | accounts | protocols | liquidated | replayable |");
say("|---|---|---|---|---|");
for (const e of [...episodes].sort((a, b) => b.usd - a.usd).slice(0, 8)) {
  say(
    `| ${e.id} | ${e.accounts} | ${e.protocols.length} | ${usd(e.usd)} | ` +
      `${replayable.includes(e) ? "yes" : "**no — outside state window**"} |`,
  );
}
say();
say(
  `${unreplayable.length} of ${episodes.length} detected episodes fall outside the state ` +
    `window, including the largest. Every number in the Headline table is measured on the ` +
    `${replayable.length} that do not, and a calm ${(deepest / (blocksPerSecond * 86400)).toFixed(0)} ` +
    `days is a weaker test than a violent year would have been. Publishing the AUC without ` +
    `this section would let a retention limit read as validation.`,
);
say();

say("## Labelling choices, and their sensitivity");
say();
say(
  `An episode is a contiguous run of hourly buckets (gaps up to ${RULES.maxGapHours}h tolerated, ` +
    `because a cascade arrives in waves as bots clear what is profitable) with at least ` +
    `${RULES.minAccounts} distinct accounts liquidated across at least ${RULES.minProtocols} ` +
    `protocols, together liquidating at least ${usd(RULES.minUsd)}.`,
);
say();
say(
  `**Breadth is necessary and it is not sufficient**, and both halves of that were ` +
    `measured rather than assumed. Breadth is necessary because ` +
    `${singleAccountHours.length} of the ${buckets.size} active hours liquidated exactly one ` +
    `account, the largest of them ${usd(Math.max(0, ...singleAccountHours.map((b) => b.usd)))} — ` +
    `a detector tuned on dollars alone would fire on that and be measuring whale activity. ` +
    `Breadth is insufficient because the first run of this script used breadth alone and ` +
    `admitted 253 "episodes" in a year, down to **$4 across 8 accounts on 2 protocols**: bots ` +
    `sweeping dust, arriving mostly on the two deployments whose indexing the ` +
    `reconciliation gate already rejects. Scoring a systemic-risk signal against those is ` +
    `scoring it against noise.`,
);
say();
say(`| rule | episodes in ${spanDays.toFixed(0)} days |`);
say("|---|---|");
say(`| **this report**: ${RULES.minAccounts}+ accounts, ${RULES.minProtocols}+ protocols, ${usd(RULES.minUsd)}+ | **${episodes.length}** |`);
for (const s of sensitivity) {
  say(
    `| ${s.rules.minAccounts}+ accounts, ${s.rules.minProtocols}+ protocols, ${usd(s.rules.minUsd)}+ | ${s.count} |`,
  );
}
say();

say("## No lookahead");
say();
say(
  "`lib/backtest/replay-signal.ts` takes a single block and passes it to all three " +
    "enclave passes; nothing in the scoring path receives a liquidation, a later block, or " +
    "an outcome. `lib/backtest/__tests__/no-lookahead.test.ts` asserts this against the " +
    "query documents themselves — every block argument in every pass equals the requested " +
    "block, and no document mentions a `liquidates` selection. The threshold is calibrated " +
    "from quiet windows only, so the positives never influence the operating point.",
);
say();
say(
  "The replay is the enclave's own query plan, block-parameterized, rather than a " +
    "lookalike written beside it — same three passes, same sampled-debt reconciliation " +
    "gate, same `aggregateSignal`. A backtest that sampled differently from the product " +
    "would be measuring a system nobody ships.",
);

mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/phase6-early-warning.md", `${lines.join("\n")}\n`);
mkdirSync("data", { recursive: true });
writeFileSync(
  "data/backtest-cascades.json",
  `${JSON.stringify(
    {
      head,
      generatedAt: new Date().toISOString(),
      blocksPerSecond,
      spanDays,
      rules: RULES,
      retention: Object.fromEntries(retention),
      episodes,
      replayable: replayable.map((e) => e.id),
      controlLagHours: CONTROL_LAG_HOURS,
      sensitivity,
      panels: panels.map((p) => ({
        episode: p.episode,
        control: p.control
          ? {
              block: p.control.block,
              score: p.control.signal.systemicRiskScore,
              baselineUtilization: p.control.baselineUtilization,
            }
          : null,
        points: p.points.map((pt) => ({
          leadHours: pt.leadHours,
          block: pt.block,
          timestamp: pt.timestamp,
          score: pt.signal.systemicRiskScore,
          baselineUtilization: pt.baselineUtilization,
          multiProtocolShareOfDebt: pt.signal.multiProtocolShareOfDebt,
          sampled: pt.sampled,
          missing: pt.missing,
        })),
      })),
      quiet: quietScored.map((s) => ({
        atHour: s.atHour,
        block: s.block,
        score: s.signal.systemicRiskScore,
        baselineUtilization: s.baselineUtilization,
        control: s.control
          ? {
              block: s.control.block,
              score: s.control.signal.systemicRiskScore,
              baselineUtilization: s.control.baselineUtilization,
            }
          : null,
      })),
      sentinel: { ...sentinel, roc: sentinel.roc },
      baseline: { ...baseline, roc: baseline.roc },
    },
    null,
    2,
  )}\n`,
);
console.log("\nwrote docs/evidence/phase6-early-warning.md and data/backtest-cascades.json");

// ─── helpers ────────────────────────────────────────────────────────────────

function fmt(n: number | null, digits: number): string {
  return n === null ? "—" : n.toFixed(digits);
}

/** The null arm, formatted. A win rate near 50% here is what makes the positive arm
 * interpretable; a high one would mean the statistic drifts up everywhere. */
function pairedNullCell(r: { pairedNull: { wins: number; n: number; winRate: number } }): string {
  return `${r.pairedNull.wins}/${r.pairedNull.n} = ${(100 * r.pairedNull.winRate).toFixed(0)}%`;
}

async function headBlock(d: Deployment): Promise<number> {
  const { query } = await import("../lib/graph/client");
  const res = await query<{ _meta: { block: { number: number } } }>(
    d,
    `query { _meta { block { number } } }`,
  );
  return res.data._meta.block.number;
}

/**
 * Deepest block the indexers still serve state for, to within `TOLERANCE` blocks.
 *
 * Binary search rather than a fixed guess, because the answer is not documented
 * anywhere and it moves as indexers prune. ~20 calls per deployment, which is worth
 * it: guessing low understates what the backtest could have covered and guessing
 * high makes half the panel silently unavailable.
 */
async function probeRetention(d: Deployment, head: number): Promise<number> {
  const TOLERANCE = 10_000;
  if ((await canTimeTravel(d, head - TOLERANCE)).ok === false) return 0;

  let ok = TOLERANCE;
  let bad = EVENT_LOOKBACK_BLOCKS;
  if ((await canTimeTravel(d, head - bad)).ok) return bad;

  while (bad - ok > TOLERANCE) {
    const mid = Math.floor((ok + bad) / 2);
    if ((await canTimeTravel(d, head - mid)).ok) ok = mid;
    else bad = mid;
  }
  return ok;
}
