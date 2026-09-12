/**
 * Turn the Phase 6 backtest into the alert policy the Phase 7 agent enforces.
 *
 * This exists so the thresholds an agent alerts on cannot drift away from the run that
 * calibrated them. `data/backtest-cascades.json` is not committed — it is a 100-block
 * network replay and `data/` is gitignored — so the two artifacts this writes are the
 * committed record of it:
 *
 *   docs/evidence/phase6-alert-policy.json   the thresholds, with their calibration
 *   lib/agent/__fixtures__/phase6-replay.json  the labelled scores, so a test can
 *                                              re-run the policy over Phase 6 history
 *
 * Nothing here chooses anything. The quantiles were fixed in Phase 6 before their
 * detection counts were known, and this script copies them across; the severity names
 * are attached in quantile order. If a future backtest changes the thresholds, this is
 * re-run and the test that replays history moves with it.
 *
 *   npm run alert:derive
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AlertPolicy, Severity } from "../lib/agent/alert";
import { parseAlertPolicy } from "../lib/agent/alert";

const BACKTEST = "data/backtest-cascades.json";

/**
 * Quantile -> severity. The strictest operating point is the loudest alert, and the
 * mapping is by construction rather than by which one detected more: Phase 6 publishes
 * all three precisely because picking on detection count would fit five labels.
 */
const SEVERITY_BY_QUANTILE: Record<string, Severity> = {
  "0.7": "watch",
  "0.8": "warn",
  "0.9": "alert",
};

/**
 * Blocks the signal may lag the chain head before an alert is refused.
 *
 * 300 blocks is about an hour at the 298.4 blocks/hour Phase 6 measured from event
 * timestamps. An hour is the grain the episodes themselves were bucketed at, so a
 * reading older than that cannot be said to describe the hour it is alerting about.
 */
const MAX_STALENESS_BLOCKS = 300;

/**
 * Sampled debt as a share of protocol-reported borrow, below which coverage is too thin
 * to alert on. The enclave's 15-call budget buys a stratified sample, not a census, and
 * Phase 5 measured what that sample covers; a fifth of the reported book is the floor
 * below which a change in the score could be a change in what was sampled.
 */
const MIN_COVERAGE = 0.2;

type Backtest = {
  head: number;
  generatedAt: string;
  controlLagHours: number;
  quiet: {
    atHour: number;
    block: number;
    score: number;
    control: { block: number; score: number } | null;
  }[];
  panels: {
    episode: { id: string; accounts: number; protocols: string[]; usd: number };
    control: { block: number; score: number } | null;
    points: { leadHours: number; block: number; score: number; sampled: string[] }[];
  }[];
  sentinel: {
    deltaPolicies: { quantile: number; falsePositiveRate: number; threshold: number }[];
  };
};

let raw: string;
try {
  raw = readFileSync(BACKTEST, "utf8");
} catch {
  console.error(
    `${BACKTEST} not found. It is written by \`npm run backtest:cascades\`, which is a ` +
      `network replay and takes about twenty minutes; the policy cannot be derived without it.`,
  );
  process.exit(1);
}
const bt = JSON.parse(raw) as Backtest;

const ladder = bt.sentinel.deltaPolicies
  .map((p) => {
    const severity = SEVERITY_BY_QUANTILE[String(p.quantile)];
    if (!severity) {
      throw new Error(
        `no severity assigned to quantile ${p.quantile}; the backtest publishes an ` +
          `operating point this policy does not know how to name`,
      );
    }
    return {
      severity,
      quantile: p.quantile,
      falseAlarmRate: p.falsePositiveRate,
      deltaThreshold: p.threshold,
    };
  })
  .sort((a, b) => a.deltaThreshold - b.deltaThreshold);

const policy: AlertPolicy = {
  calibration: {
    generatedAt: bt.generatedAt,
    head: bt.head,
    ordinaryHours: bt.quiet.length,
    episodes: bt.panels.length,
  },
  controlLagHours: bt.controlLagHours,
  ladder,
  gates: {
    maxStalenessBlocks: MAX_STALENESS_BLOCKS,
    minCoverageOfReportedDebt: MIN_COVERAGE,
    minProtocols: 2,
  },
};

// Round-trip through the validator, so an invalid policy fails here rather than in the
// agent at the moment it would have alerted.
const json = `${JSON.stringify(policy, null, 2)}\n`;
parseAlertPolicy(json);
mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/phase6-alert-policy.json", json);

/**
 * The labelled replay, reduced to what the policy reads.
 *
 * Scores only: the backtest recorded the composite and the coverage of the sampled book
 * separately, so the gate on coverage is exercised by unit tests with constructed
 * signals rather than pretended into this fixture.
 */
const episodes = bt.panels
  .map((p) => {
    const at = p.points.find((pt) => pt.leadHours === 1) ?? p.points[0];
    if (!at || !p.control) return null;
    return {
      id: p.episode.id,
      accounts: p.episode.accounts,
      liquidatedUsd: p.episode.usd,
      block: at.block,
      protocols: at.sampled,
      score: at.score,
      controlScore: p.control.score,
    };
  })
  .filter((e): e is NonNullable<typeof e> => e !== null);

const quiet = bt.quiet
  .filter((q) => q.control !== null)
  .map((q) => ({
    hour: q.atHour,
    block: q.block,
    score: q.score,
    controlScore: q.control!.score,
  }));

mkdirSync("lib/agent/__fixtures__", { recursive: true });
writeFileSync(
  "lib/agent/__fixtures__/phase6-replay.json",
  `${JSON.stringify(
    {
      note:
        "Written by scripts/derive-alert-policy.mts from a Phase 6 backtest run. Scores are " +
        "measured; nothing here is constructed. Positives are the hour before a cascade, " +
        "negatives are ordinary hours, both differenced against the same hour a week earlier.",
      generatedAt: bt.generatedAt,
      head: bt.head,
      controlLagHours: bt.controlLagHours,
      episodes,
      quiet,
    },
    null,
    2,
  )}\n`,
);

const detected = (t: number) => episodes.filter((e) => e.score - e.controlScore >= t).length;
const falseAlarms = (t: number) => quiet.filter((q) => q.score - q.controlScore >= t).length;

console.log(`wrote docs/evidence/phase6-alert-policy.json (calibrated at head ${bt.head})`);
for (const row of ladder) {
  console.log(
    `  ${row.severity.padEnd(5)} Δ>=${row.deltaThreshold.toFixed(2)} ` +
      `(p${(100 * row.quantile).toFixed(0)}, stated ${(100 * row.falseAlarmRate).toFixed(0)}% FPR): ` +
      `${detected(row.deltaThreshold)}/${episodes.length} episodes, ` +
      `${falseAlarms(row.deltaThreshold)}/${quiet.length} ordinary hours`,
  );
}
console.log(
  `wrote lib/agent/__fixtures__/phase6-replay.json ` +
    `(${episodes.length} episodes, ${quiet.length} ordinary hours)`,
);
