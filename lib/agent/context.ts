/**
 * One session, one block.
 *
 * Every tool in `tools.ts` reads from a context opened once and pinned to a single
 * block, for three reasons that all showed up in practice:
 *
 *   1. Consistency. A conversation that asks "how much cross-protocol debt is there"
 *      and then "which pairs carry it" must not get answers from two different blocks,
 *      because the follow-up would silently fail to add up and no one would notice.
 *   2. Cost. The enclave's query plan is 15 HTTP calls; re-running it per question
 *      would spend the Graph budget on re-deriving a number already in hand.
 *   3. Provenance. A pinned block is a citation. `lib/agent/provenance.ts` stamps every
 *      figure with the deployment, the subgraph id and this block, so an answer can be
 *      re-derived by anyone with the same key.
 *
 * The signal itself is computed by the *product's* query plan — `signalAtBlock` from
 * `lib/backtest/replay-signal.ts`, which is the enclave's three passes with a block
 * argument — rather than by a second implementation written for the agent. An agent
 * answering from a lookalike pipeline would be describing a system nobody ships.
 */

import { DEPLOYMENTS, type Deployment } from "../graph/deployments";
import { query } from "../graph/client";
import { signalAtBlock, type SamplingConfig, type ScoredBlock } from "../backtest/replay-signal";
import { parseRiskPolicy, type RiskPolicy } from "../signal/policy";
import { parseAlertPolicy, type AlertPolicy } from "./alert";
import type { Provenance } from "./provenance";

/**
 * Blocks per hour on mainnet, measured in Phase 6 from event `blockNumber`/`timestamp`
 * pairs rather than assumed from the 12-second target. Used only to locate the control
 * block a week back; every published block number is one an indexer actually served.
 */
export const BLOCKS_PER_HOUR = 298.4;

/**
 * How far behind the head the pinned block sits.
 *
 * Not zero. Indexers disagree about the last few blocks, and a query at a block one
 * indexer has not reached yet fails with "missing block" rather than returning slightly
 * old data — so asking for the exact head trades a small staleness for an intermittent
 * refusal. Ten blocks is about two minutes, well inside the policy's staleness gate.
 */
export const HEAD_SAFETY_BLOCKS = 10;

const HEAD_QUERY = `{ _meta { block { number timestamp } } }`;

export type SentinelContext = {
  /** Chain head as reported by the furthest-ahead deployment that answered. */
  head: number;
  /** The block every answer in this session is derived at. */
  block: number;
  /** The signal at `block`, by the enclave's own query plan. */
  scored: ScoredBlock;
  /**
   * The signal one control lag earlier, or null when no indexer serves that block.
   * Null is the normal case beyond ~67 days of state retention (Phase 6), and the
   * alert policy refuses rather than falling back to a level comparison.
   */
  control: ScoredBlock | null;
  alertPolicy: AlertPolicy;
  deployments: Deployment[];
  /** Deployment key -> provenance stamp, so tools cite without re-deriving. */
  provenance: Record<string, Provenance>;
  /** Total HTTP calls spent opening the context, for the query-cost budget. */
  calls: number;
};

export type OpenContextOptions = {
  sampling: SamplingConfig;
  riskPolicyJson: string;
  alertPolicyJson: string;
  deployments?: Deployment[];
  /**
   * Skip the control read. The control costs a second full query plan, and a question
   * about the current book does not need it — only the alert decision does.
   */
  withControl?: boolean;
  onProgress?: (msg: string) => void;
};

/** The chain head, from whichever deployment is furthest ahead. */
async function headBlock(deployments: Deployment[]): Promise<number> {
  type HeadData = { _meta: { block: { number: number } } };
  const results = await Promise.allSettled(
    deployments.map((d) => query<HeadData>(d, HEAD_QUERY)),
  );
  const heads: number[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") heads.push(r.value.data._meta.block.number);
  }
  if (heads.length === 0) {
    // No mock mode, here or anywhere: an agent that answers from no data is the failure
    // this whole phase is built to make impossible.
    throw new Error("no deployment answered a head query; refusing to answer from nothing");
  }
  return Math.max(...heads);
}

export async function openContext({
  sampling,
  riskPolicyJson,
  alertPolicyJson,
  deployments = DEPLOYMENTS,
  withControl = true,
  onProgress = () => {},
}: OpenContextOptions): Promise<SentinelContext> {
  const policy: RiskPolicy = parseRiskPolicy(riskPolicyJson);
  const alertPolicy = parseAlertPolicy(alertPolicyJson);

  const head = await headBlock(deployments);
  const block = head - HEAD_SAFETY_BLOCKS;
  onProgress(`head ${head}, pinning ${block}`);

  const scored = await signalAtBlock(deployments, sampling, policy, block);
  if (!scored) {
    throw new Error(`no deployment served block ${block}; nothing to answer from`);
  }
  onProgress(
    `signal at ${block}: score ${scored.signal.systemicRiskScore.toFixed(2)}, ` +
      `${scored.sampled.length} deployment(s), ${scored.calls} calls`,
  );

  let control: ScoredBlock | null = null;
  if (withControl) {
    const controlBlock = Math.round(block - alertPolicy.controlLagHours * BLOCKS_PER_HOUR);
    control = await signalAtBlock(deployments, sampling, policy, controlBlock);
    onProgress(
      control
        ? `control at ${controlBlock}: score ${control.signal.systemicRiskScore.toFixed(2)}`
        : `control at ${controlBlock}: not served — alerts will refuse`,
    );
  }

  const provenance: Record<string, Provenance> = {};
  for (const key of scored.sampled) {
    const d = deployments.find((x) => x.key === key);
    if (!d) continue;
    provenance[key] = {
      deployment: d.key,
      subgraphId: d.subgraphId,
      block: scored.signal.blocks[key] ?? block,
    };
  }

  return {
    head,
    block,
    scored,
    control,
    alertPolicy,
    deployments,
    provenance,
    calls: scored.calls + (control?.calls ?? 0) + deployments.length,
  };
}

/** Every sampled deployment's stamp, which is what an aggregate figure rests on. */
export function allSources(ctx: SentinelContext): Provenance[] {
  return Object.values(ctx.provenance).sort((a, b) => a.deployment.localeCompare(b.deployment));
}

/** The stamps for named deployments, dropping any that did not answer. */
export function sourcesFor(ctx: SentinelContext, keys: string[]): Provenance[] {
  return keys.map((k) => ctx.provenance[k]).filter((p): p is Provenance => Boolean(p));
}
