/**
 * The agent's tools. Eight of them, each one a real read with real provenance.
 *
 * The design rule is that the model never does arithmetic and never holds a number.
 * Tools compute, tools cite, and the model's job is to choose which tool to call and to
 * relay the sentence it returns. That is why every result carries `cited` alongside
 * `answer`: `unsourcedNumbers` re-reads the answer and fails the build if any numeral in
 * it is not accounted for by a citation. A model that paraphrases a figure into a
 * rounder one fails that check, which is the point.
 *
 * Two tools exist mainly to be *refusals*:
 *
 *   - `sentinel_alert` refuses when the book is stale, thin, or has no control reading,
 *     because an alert derived from a book the enclave could not read looks exactly like
 *     one derived from a book it could.
 *   - `sentinel_query_subgraph` refuses per-address selections. It is the composable
 *     escape hatch onto any Messari-schema subgraph — the same shape of access The
 *     Graph's own Subgraph MCP server offers — and it deliberately will not serve the
 *     one query whose *output* is the harm Sentinel exists to avoid publishing: a map of
 *     who is levered where. Per-address rows are read inside the TEE and leave it only
 *     as aggregates. An agent that would print them on request has undone the product.
 */

import { query } from "../graph/client";
import { deploymentByKey, DEPLOYMENTS, REJECTED_CANDIDATES } from "../graph/deployments";
import { assertAggregateOnly } from "../signal/aggregate";
import { decideAlert, type AlertDecision } from "./alert";
import { allSources, sourcesFor, type SentinelContext } from "./context";
import { cite, pct, unsourcedNumbers, usd, type Cited } from "./provenance";

export type ToolResult = {
  /** Prose the model relays. Every numeral in it is accounted for by `cited`. */
  answer: string;
  cited: Cited[];
  /**
   * Quoted output that is evidence rather than a claim: a subgraph's own JSON, an
   * indexer's own error string. Excluded from the numeral check on purpose — these are
   * not figures Sentinel is asserting, they are the raw material, and rewriting them to
   * satisfy a citation rule would destroy exactly the property that makes them useful.
   * Rendered as quoted blocks so a reader can see the boundary.
   */
  verbatim?: string[];
  /** Set when the tool declined. A refusal is a successful outcome, not an error. */
  refusal?: { gate: string; reason: string };
};

export type Tool = {
  name: string;
  /** Shown to the model. States what the tool answers and what it will not answer. */
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  run: (ctx: SentinelContext, args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
};

const NO_ARGS = { type: "object" as const, properties: {} };

/** The invariant, enforced at the boundary rather than trusted. */
function checked(result: ToolResult, question = ""): ToolResult {
  const unsourced = unsourcedNumbers(result.answer, result.cited, question);
  if (unsourced.length > 0) {
    throw new Error(
      `tool answer contains unsourced number(s): ${unsourced.join(", ")} — every figure ` +
        `must come from a Cited value`,
    );
  }
  return result;
}

const signalTool: Tool = {
  name: "sentinel_signal",
  description:
    "The current systemic-risk signal: the composite score, how much borrowed value sits " +
    "with addresses levered across two or more protocols, and how much of the reported book " +
    "the sample covers. Aggregates only — never a per-address figure.",
  inputSchema: NO_ARGS,
  run(ctx) {
    const s = ctx.scored.signal;
    // Cheap here, and it is the one assertion whose failure would be a disclosure rather
    // than a bug: the signal must contain no per-address row.
    assertAggregateOnly(s);

    const sources = allSources(ctx);
    const score = cite("systemic risk score", s.systemicRiskScore, s.systemicRiskScore.toFixed(2), sources);
    const share = cite(
      "multi-protocol share of observed debt",
      s.multiProtocolShareOfDebt,
      pct(s.multiProtocolShareOfDebt),
      sources,
    );
    const mpDebt = cite(
      "multi-protocol debt",
      s.multiProtocolDebtUsd,
      usd(s.multiProtocolDebtUsd),
      sources,
    );
    const mpBorrowers = cite(
      "multi-protocol borrowers",
      s.multiProtocolBorrowers,
      String(s.multiProtocolBorrowers),
      sources,
    );
    const debt = cite("observed debt", s.debtUsd, usd(s.debtUsd), sources);
    const coverage = cite(
      "coverage of reported borrow",
      s.coverageOfReportedDebt,
      pct(s.coverageOfReportedDebt, 1),
      sources,
    );
    const protocols = cite(
      "deployments read",
      s.protocols.length,
      String(s.protocols.length),
      sources,
    );

    return checked({
      answer:
        `The systemic risk score is ${score.text} on a scale bounded at a hundred. Of ${debt.text} in observed ` +
        `borrowing, ${mpDebt.text} (${share.text}) is held by ${mpBorrowers.text} addresses ` +
        `levered across two or more of the ${protocols.text} deployments read, at block ` +
        `${ctx.block}. The sample covers ${coverage.text} of the borrowing those protocols ` +
        `report for themselves, so every figure is a measured lower bound rather than a total.`,
      cited: [score, debt, mpDebt, share, mpBorrowers, protocols, coverage],
    });
  },
};

const alertTool: Tool = {
  name: "sentinel_alert",
  description:
    "Decide whether current conditions warrant an alert, and at what severity, under the " +
    "policy calibrated in Phase 6 (docs/evidence/phase6-alert-policy.json). The operating " +
    "variable is the week-on-week change in the score, not its level. Refuses when the " +
    "reading is stale, coverage is too thin, or no control reading exists.",
  inputSchema: NO_ARGS,
  run(ctx) {
    const decision: AlertDecision = decideAlert({
      signal: ctx.scored.signal,
      control: ctx.control?.signal ?? null,
      headBlock: ctx.head,
      policy: ctx.alertPolicy,
    });
    const sources = allSources(ctx);

    if (decision.kind === "refused") {
      // The reason is quoted verbatim: its numbers are the gate's own, stated beside the
      // limit they failed, and paraphrasing them into a citation would make a refusal
      // read like an answer.
      return checked({
        answer: `No alert decision. Sentinel refuses this one rather than guessing.`,
        cited: [],
        verbatim: [`${decision.gate}: ${decision.reason}`],
        refusal: { gate: decision.gate, reason: decision.reason },
      });
    }

    const delta = cite(
      "week-on-week change in score",
      decision.delta,
      decision.delta.toFixed(2),
      sources,
    );
    const now = cite(
      "score now",
      ctx.scored.signal.systemicRiskScore,
      ctx.scored.signal.systemicRiskScore.toFixed(2),
      sources,
    );
    const before = cite(
      "score one week earlier",
      ctx.control!.signal.systemicRiskScore,
      ctx.control!.signal.systemicRiskScore.toFixed(2),
      [
        ...sources.map((s) => ({ ...s, block: ctx.control!.block })),
      ],
    );

    if (decision.kind === "quiet") {
      const weakest = [...ctx.alertPolicy.ladder].sort(
        (a, b) => a.deltaThreshold - b.deltaThreshold,
      )[0];
      const threshold = cite(
        `${weakest.severity} threshold`,
        weakest.deltaThreshold,
        weakest.deltaThreshold.toFixed(2),
        sources,
      );
      return checked({
        answer:
          `No alert. The score moved ${delta.text} points against the same hour last week ` +
          `(${before.text} to ${now.text}), below the weakest calibrated threshold of ` +
          `${threshold.text}.`,
        cited: [delta, before, now, threshold],
      });
    }

    const rate = cite(
      "stated false-alarm rate",
      decision.falseAlarmRate,
      pct(decision.falseAlarmRate, 0),
      sources,
    );
    const row = ctx.alertPolicy.ladder.find((r) => r.severity === decision.severity)!;
    const threshold = cite(
      `${decision.severity} threshold`,
      row.deltaThreshold,
      row.deltaThreshold.toFixed(2),
      sources,
    );
    return checked({
      answer:
        `Severity **${decision.severity}**. The score rose ${delta.text} points against the ` +
        `same hour last week (${before.text} to ${now.text}), clearing the ${decision.severity} ` +
        `threshold of ${threshold.text}. That threshold was calibrated on ordinary hours ` +
        `alone and carries a stated false-alarm rate of ${rate.text}; it was never fitted to ` +
        `an outcome.`,
      cited: [delta, before, now, threshold, rate],
    });
  },
};

const couplingTool: Tool = {
  name: "sentinel_coupling",
  description:
    "Which pairs of protocols share levered borrowers, and how much debt each pair carries. " +
    "Buckets thinner than the policy's k-anonymity floor are withheld and reported as " +
    "withheld rather than rounded.",
  inputSchema: NO_ARGS,
  run(ctx) {
    const s = ctx.scored.signal;
    const cited: Cited[] = [];
    const rows: string[] = [];
    for (const b of [...s.coupling].sort((x, y) => y.debtUsd - x.debtUsd)) {
      const pair = b.pair.split("|");
      const sources = sourcesFor(ctx, pair);
      const debt = cite(`${b.pair} debt`, b.debtUsd, usd(b.debtUsd), sources.length ? sources : allSources(ctx));
      const n = cite(
        `${b.pair} borrowers`,
        b.borrowers,
        String(b.borrowers),
        sources.length ? sources : allSources(ctx),
      );
      cited.push(debt, n);
      rows.push(`${pair.join(" + ")}: ${n.text} borrowers carrying ${debt.text}`);
    }

    const withheld = cite(
      "withheld buckets",
      s.suppressedBuckets.length,
      String(s.suppressedBuckets.length),
      allSources(ctx),
    );
    cited.push(withheld);

    const body =
      rows.length > 0
        ? `Pairs that clear the anonymity floor, largest first — ${rows.join("; ")}.`
        : `No protocol pair clears the anonymity floor at this block, so nothing is published.`;

    return checked({
      answer:
        `${body} A further ${withheld.text} pair(s) were withheld for having too few ` +
        `borrowers to publish without narrowing the set to identifiable addresses. The ` +
        `underlying per-address joins exist only inside the enclave; this tool cannot ` +
        `return them and no version of it will.`,
      cited,
    });
  },
};

const shockTool: Tool = {
  name: "sentinel_shock_ladder",
  description:
    "How much borrowed value goes distressed at each collateral shock the confidential " +
    "policy evaluates, and how many borrowers that is. The shock magnitudes are published; " +
    "the per-asset betas and composite weights that produce them are not.",
  inputSchema: NO_ARGS,
  run(ctx) {
    const s = ctx.scored.signal;
    const sources = allSources(ctx);
    const cited: Cited[] = [];
    const rows: string[] = [];
    for (const step of s.shockLadder) {
      const shock = cite(`shock ${pct(step.shock, 0)}`, step.shock, pct(step.shock, 0), sources);
      const debt = cite(
        `distressed debt at ${pct(step.shock, 0)}`,
        step.distressedDebtUsd,
        usd(step.distressedDebtUsd),
        sources,
      );
      const n = cite(
        `distressed borrowers at ${pct(step.shock, 0)}`,
        step.distressedBorrowers,
        String(step.distressedBorrowers),
        sources,
      );
      cited.push(shock, debt, n);
      rows.push(`${shock.text}: ${debt.text} across ${n.text} borrowers`);
    }
    const evaluable = cite(
      "evaluable debt",
      s.evaluableDebtUsd,
      usd(s.evaluableDebtUsd),
      sources,
    );
    cited.push(evaluable);

    return checked({
      answer:
        `Against ${evaluable.text} of debt on books whose risk parameters are ` +
        `self-consistent, the ladder at block ${ctx.block} is — ${rows.join("; ")}. Each row ` +
        `applies per-asset betas from the confidential policy, so a uniform headline shock ` +
        `is not a uniform shock per asset.`,
      cited,
    });
  },
};

const compareTool: Tool = {
  name: "sentinel_compare_protocols",
  description:
    "Per-deployment comparison at the pinned block: which answered, at what block, how much " +
    "borrowing each reports, and which were excluded with the reason.",
  inputSchema: NO_ARGS,
  run(ctx) {
    const s = ctx.scored.signal;
    const cited: Cited[] = [];
    const rows: string[] = [];
    for (const key of s.protocols) {
      const src = sourcesFor(ctx, [key]);
      const block = s.blocks[key];
      if (!src.length || block === undefined) continue;
      const b = cite(`${key} block`, block, String(block), src);
      cited.push(b);
      rows.push(`${key} at block ${b.text}`);
    }
    const read = cite("deployments read", s.protocols.length, String(s.protocols.length), allSources(ctx));
    const registered = cite(
      "deployments registered",
      DEPLOYMENTS.length,
      String(DEPLOYMENTS.length),
      allSources(ctx),
    );
    cited.push(read, registered);

    // Indexer refusals are quoted, not summarised: "Unavailable(missing block N, latest M)"
    // is the finding, and the two block numbers in it are the evidence for it.
    const excluded = ctx.scored.missing.map((m) => `${m.key}: ${m.reason.slice(0, 200)}`);

    return checked({
      answer:
        `${read.text} of ${registered.text} registered deployments answered all three passes: ` +
        `${rows.join(", ")}. ` +
        (excluded.length > 0
          ? `The rest were excluded, with the indexers' own words quoted below. `
          : `Nothing was excluded at this block. `) +
        `Exclusions are published rather than smoothed over, because a signal that quietly ` +
        `drops a book reports a different market from the one it names.`,
      cited,
      verbatim: excluded,
    });
  },
};

const coverageTool: Tool = {
  name: "sentinel_coverage",
  description:
    "What the signal can and cannot see: sample coverage of reported borrowing, how much of " +
    "the book rests on inferred E-Mode parameters, and which registered deployments are " +
    "rejected by the reconciliation gate rather than by choice.",
  inputSchema: NO_ARGS,
  run(ctx) {
    const s = ctx.scored.signal;
    const sources = allSources(ctx);
    const coverage = cite(
      "coverage of reported borrow",
      s.coverageOfReportedDebt,
      pct(s.coverageOfReportedDebt, 1),
      sources,
    );
    const observed = cite("observed debt", s.debtUsd, usd(s.debtUsd), sources);
    const reported = cite("reported borrow", s.reportedDebtUsd, usd(s.reportedDebtUsd), sources);
    const inferred = cite(
      "debt resting on inferred E-Mode parameters",
      s.emodeInferredDebtUsd,
      usd(s.emodeInferredDebtUsd),
      sources,
    );
    const rejected = cite(
      "candidate subgraphs rejected on inspection",
      REJECTED_CANDIDATES.length,
      String(REJECTED_CANDIDATES.length),
      sources,
    );

    return checked({
      answer:
        `The sample sees ${observed.text} of the ${reported.text} these protocols report ` +
        `borrowing, or ${coverage.text}, because the enclave's query budget buys a ` +
        `largest-first stratified sample rather than a census. ${inferred.text} of it rests on ` +
        `reconstructed E-Mode parameters rather than published ones, which is published so a ` +
        `consumer can discount it. Separately, ${rejected.text} candidate subgraphs were ` +
        `rejected before use, and any deployment whose sampled debt exceeds its own reported ` +
        `total is dropped at runtime by the reconciliation gate — Aave V2's positions overstate ` +
        `outstanding debt because its mappings handle Borrow and not Repay.`,
      cited: [observed, reported, coverage, inferred, rejected],
    });
  },
};

/** Selections that would return a per-address leverage map. Refused, by design. */
const PER_ADDRESS_SELECTIONS = /\b(positions?|accounts?|borrows?|repays?|liquidates?)\s*[({]/;

const querySubgraphTool: Tool = {
  name: "sentinel_query_subgraph",
  description:
    "Run a GraphQL document against one of Sentinel's registered Messari-schema subgraphs and " +
    "return the response with the block it was served at. Aggregate and market-level " +
    "selections only: per-address selections (positions, accounts, borrows, repays, " +
    "liquidates) are refused, because publishing who is levered where is the harm Sentinel " +
    "exists to avoid.",
  inputSchema: {
    type: "object",
    properties: {
      deployment: {
        type: "string",
        description: `Deployment key. One of: ${DEPLOYMENTS.map((d) => d.key).join(", ")}.`,
      },
      document: { type: "string", description: "A GraphQL query document." },
    },
    required: ["deployment", "document"],
  },
  async run(_ctx, args) {
    const key = String(args.deployment ?? "");
    const document = String(args.document ?? "");
    const d = deploymentByKey(key);
    if (!d) {
      return {
        answer: `No deployment named ${key}. Registered keys: ${DEPLOYMENTS.map((x) => x.key).join(", ")}.`,
        cited: [],
        refusal: { gate: "unknown-deployment", reason: `no deployment ${key}` },
      };
    }
    if (PER_ADDRESS_SELECTIONS.test(document)) {
      return {
        answer:
          `Refused. That document selects per-address rows, and this tool does not return ` +
          `them at any size. Per-address positions are read inside the enclave and leave it ` +
          `only as aggregates. Ask sentinel_signal or sentinel_coupling for the aggregate ` +
          `form of the same question.`,
        cited: [],
        refusal: { gate: "per-address", reason: "document selects per-address rows" },
      };
    }

    const res = await query<Record<string, unknown>>(d, document);
    const body = JSON.stringify(res.data);
    const provenance = { deployment: d.key, subgraphId: d.subgraphId, block: res.block };
    const served = cite("block served", res.block, String(res.block), [provenance]);
    const bytes = cite("bytes returned", body.length, String(body.length), [provenance]);
    // The response is the subgraph's own data, quoted: it is evidence, not a Sentinel claim.
    return checked({
      answer:
        `\`${d.key}\` (subgraph \`${d.subgraphId}\`) served block ${served.text}, ` +
        `${bytes.text} bytes of JSON, quoted below.`,
      cited: [served, bytes],
      verbatim: [body.length > 4000 ? `${body.slice(0, 4000)}…` : body],
    });
  },
};

const calibrationTool: Tool = {
  name: "sentinel_alert_calibration",
  description:
    "Where the alert thresholds come from: the Phase 6 backtest that calibrated them, the " +
    "three operating points with their stated false-alarm rates, and what each detected on " +
    "replayed history.",
  inputSchema: NO_ARGS,
  run(ctx) {
    const p = ctx.alertPolicy;
    const sources = allSources(ctx);
    const cited: Cited[] = [];
    const rows: string[] = [];
    for (const row of [...p.ladder].sort((a, b) => a.deltaThreshold - b.deltaThreshold)) {
      const t = cite(
        `${row.severity} threshold`,
        row.deltaThreshold,
        row.deltaThreshold.toFixed(2),
        sources,
      );
      const r = cite(
        `${row.severity} false-alarm rate`,
        row.falseAlarmRate,
        pct(row.falseAlarmRate, 0),
        sources,
      );
      cited.push(t, r);
      rows.push(`${row.severity} at a rise of ${t.text} points (${r.text} of ordinary weeks)`);
    }
    const hours = cite(
      "ordinary hours behind the calibration",
      p.calibration.ordinaryHours,
      String(p.calibration.ordinaryHours),
      sources,
    );
    const episodes = cite(
      "replayable episodes scored",
      p.calibration.episodes,
      String(p.calibration.episodes),
      sources,
    );
    const lag = cite("control lag hours", p.controlLagHours, String(p.controlLagHours), sources);
    cited.push(hours, episodes, lag);

    return checked({
      answer:
        `Thresholds are quantiles of the week-on-week change over ${hours.text} ordinary ` +
        `hours: ${rows.join(", ")}. The control is the same hour ${lag.text} hours earlier, so ` +
        `hour-of-day and day-of-week cancel. They were calibrated on ordinary hours only — ` +
        `never on an outcome — and then scored against ${episodes.text} replayable cascade ` +
        `episodes, which is the whole set that falls inside the couple of months of state ` +
        `history indexers retain. The level of the score is not comparable across months and its ` +
        `change is; an absolute threshold detected none of the episodes, which is why the ` +
        `policy is a difference.`,
      cited,
    });
  },
};

export const TOOLS: Tool[] = [
  signalTool,
  alertTool,
  couplingTool,
  shockTool,
  compareTool,
  coverageTool,
  calibrationTool,
  querySubgraphTool,
];

export function toolByName(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
