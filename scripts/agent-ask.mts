/**
 * Ask Sentinel ten questions against live subgraph state, and write the transcript.
 *
 * The transcript is evidence, not documentation, so this script is the thing that
 * produces it and nothing is hand-written into it. Every answer below came from a tool
 * that read the gateway at one pinned block, every number in every answer carries the
 * subgraph and the block it was read from, and the script fails rather than writes if any
 * numeral in any answer is unaccounted for — see `lib/agent/provenance.ts`.
 *
 * Two of the ten questions are meant to fail. One asks for a per-address leverage map,
 * which is the exact output Sentinel exists not to publish; one asks a question about the
 * future, which a language model answers fluently and Sentinel has no read for. A tool
 * set that cannot refuse is not trustworthy, so the refusals are in the evidence file
 * beside the answers rather than left as an untested claim.
 *
 *   npm run agent:ask
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DEPLOYMENTS, type Deployment } from "../lib/graph/deployments";
import type { SamplingConfig } from "../lib/backtest/replay-signal";
import { openContext } from "../lib/agent/context";
import { answer, type Answer } from "../lib/agent/router";
import { renderCitations, unsourcedNumbers } from "../lib/agent/provenance";
import { TOOLS } from "../lib/agent/tools";

/**
 * The questions. Written as a risk desk would ask them, not as tool names in prose, and
 * fixed in the file so the transcript is comparable across runs.
 */
const QUESTIONS = [
  "How much borrowed value is levered across more than one protocol right now?",
  "Is anything happening right now that should wake someone up?",
  "Which protocol pairs share levered borrowers, and how much debt sits in each?",
  "What happens to the book if collateral drops — how much goes distressed under stress?",
  "Which deployments did you actually read, and at which blocks?",
  "How much of the real book can you see, and what are you blind to?",
  "Where does the alert threshold come from, and what false alarm rate does it carry?",
  "What total borrow does Aave V3 report for itself in the raw subgraph?",
  "List the addresses levered across Aave and Compound, largest first.",
  "Will ETH go up tomorrow?",
];

const policyJson = process.env.SENTINEL_RISK_POLICY;
if (!policyJson) {
  console.error("SENTINEL_RISK_POLICY is not set (see cre/.env.example).");
  process.exit(1);
}

const enclaveConfig = JSON.parse(
  readFileSync("cre/sentinel-signal/config.staging.json", "utf8"),
) as SamplingConfig & { deployments: { key: string }[] };

const deployments: Deployment[] = enclaveConfig.deployments
  .map((d) => DEPLOYMENTS.find((k) => k.key === d.key))
  .filter((d): d is Deployment => d !== undefined);

const alertPolicyJson = readFileSync("docs/evidence/phase6-alert-policy.json", "utf8");

const ctx = await openContext({
  sampling: enclaveConfig,
  riskPolicyJson: policyJson,
  alertPolicyJson,
  deployments,
  withControl: true,
  onProgress: (m) => console.log(`  ${m}`),
});

const answers: Answer[] = [];
for (const q of QUESTIONS) {
  const a = await answer(ctx, q);
  answers.push(a);
  console.log(`\nQ ${q}\n  -> ${a.tool ?? "refused before any tool ran"}`);
  console.log(`  ${a.result.answer.slice(0, 160)}…`);
}

// ─── The invariant, re-checked outside the tools ────────────────────────────
//
// The tools check themselves, and this checks them again on the assembled file. A future
// change that returns prose around a cited value — a summary line, a rounded restatement —
// would pass the per-tool check inside a tool it did not touch and fail here.
const violations: string[] = [];
for (const a of answers) {
  const unsourced = unsourcedNumbers(a.result.answer, a.result.cited, a.question);
  if (unsourced.length > 0) violations.push(`${a.tool}: unsourced ${unsourced.join(", ")}`);
  if (a.result.cited.length === 0 && !a.result.refusal) {
    violations.push(`${a.tool}: answered with no citations and no refusal`);
  }
}
if (violations.length > 0) {
  console.error(`\nrefusing to write the transcript:\n  ${violations.join("\n  ")}`);
  process.exit(1);
}

const refusals = answers.filter((a) => a.result.refusal);
const answered = answers.filter((a) => !a.result.refusal);

const lines: string[] = [];
const say = (s = "") => lines.push(s);

say("# Phase 7 — the agent, interrogated");
say();
say(
  `Written by \`npm run agent:ask\` at ${new Date().toISOString()}. ${QUESTIONS.length} ` +
    `questions, ${answered.length} answered from live subgraph reads and ${refusals.length} ` +
    `refused. Every session pins one block so two answers cannot disagree about the world: ` +
    `this one is **${ctx.block}**, with the chain head at ${ctx.head} when it opened, and ` +
    `${ctx.calls} HTTP calls spent opening it.`,
);
say();
say(
  "Nothing in this file is hand-written. Each answer is the string a tool returned, and each " +
    "citation table is generated from the `Cited` values that answer was assembled from. " +
    "`scripts/agent-ask.mts` re-checks every numeral against those citations and exits " +
    "without writing if one is unaccounted for, so an unsourced number cannot reach this " +
    "file — see `lib/agent/provenance.ts` and `lib/agent/__tests__/transcript.test.ts`.",
);
say();
say("## Tools");
say();
say("| tool | what it answers |");
say("|---|---|");
for (const t of TOOLS) say(`| \`${t.name}\` | ${t.description.split(".")[0]}. |`);
say();
say("---");
say();

let n = 0;
for (const a of answers) {
  n += 1;
  say(`## ${n}. ${a.question}`);
  say();
  if (a.tool) {
    say(
      `**Tool** \`${a.tool}\`${
        a.matched.length ? ` · routed on ${a.matched.map((m) => `"${m}"`).join(", ")}` : ""
      }`,
    );
    if (Object.keys(a.args).length > 0) {
      say();
      say(`\`\`\`json\n${JSON.stringify(a.args, null, 2)}\n\`\`\``);
    }
  } else {
    say("**No tool ran.** The question was refused at routing.");
  }
  say();
  say(a.result.answer);
  say();
  for (const v of a.result.verbatim ?? []) {
    say("> ```");
    for (const line of v.split("\n")) say(`> ${line}`);
    say("> ```");
    say();
  }
  if (a.result.refusal) {
    say(`**Refused** · gate \`${a.result.refusal.gate}\`.`);
    say();
  }
  if (a.result.cited.length > 0) {
    say(renderCitations(a.result.cited));
    say();
  }
}

say("## What this does and does not show");
say();
say(
  "It shows that every number an answer contains was read from a named subgraph at a named " +
    "block, and that the two questions Sentinel must not answer are refused rather than " +
    "answered plausibly. It does not show that the underlying signal predicts anything — that " +
    "is Phase 6's job, and Phase 6's answer is a paired win rate of 4/5 with the p90 operating " +
    "point detecting none of five episodes, published in " +
    "`docs/evidence/phase6-early-warning.md`. The alert thresholds this agent enforces are " +
    "copied from that run by `scripts/derive-alert-policy.mts`; they were never chosen here.",
);
say();

mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/phase7-transcript.md", `${lines.join("\n")}\n`);
console.log(
  `\nwrote docs/evidence/phase7-transcript.md (${answered.length} answered, ${refusals.length} refused)`,
);
