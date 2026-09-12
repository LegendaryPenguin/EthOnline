/**
 * Replay the risk engine against real liquidations.
 *
 * Every claim Sentinel makes about who is at risk is worth exactly as much as its
 * score against events that actually happened. So: take a real `Liquidate`, rewind
 * the subgraph to the block *before* it, ask the engine whether that account was
 * liquidatable, and compare.
 *
 * The rewind is the whole method, and it is honest only because of a detail worth
 * stating: the query is a time-travel query at `block: { number: n }`, so the
 * indexer serves state as of that block. Nothing about the future — not the
 * liquidation, not the price that caused it — is visible to the engine. There is no
 * way to leak the answer in, because the answer had not been written yet.
 *
 * Three limits, all measured rather than assumed:
 *   - only some deployments can be replayed at all: time-travel is a property of
 *     the indexers serving a subgraph, not of the chain. See `canTimeTravel`.
 *   - positions carry event-written balances, so a liquidatee's state at block-1 is
 *     as of its last event and accrued interest since then is missing. That
 *     understates debt, which biases *against* flagging, so recall is a floor.
 *   - `normalizePosition` drops any position it cannot price, so dropped rows are
 *     counted per account and reported rather than quietly valued at zero
 */

import { query } from "../graph/client";
import type { Deployment } from "../graph/deployments";
import { MARKETS_QUERY } from "../graph/queries";
import { buildPriceIndex, normalizePosition } from "../exposure/normalize";
import type { Position, RawMarket, RawPosition } from "../exposure/types";

const PAGE_SIZE = 1000;

/** Liquidations inside a block window, paged by id. */
export const LIQUIDATIONS_WINDOW_QUERY = /* GraphQL */ `
  query LiquidationsWindow($first: Int!, $from: BigInt!, $to: BigInt!, $lastId: ID!) {
    _meta {
      block {
        number
      }
    }
    liquidates(
      first: $first
      where: { blockNumber_gte: $from, blockNumber_lte: $to, id_gt: $lastId }
      orderBy: id
      orderDirection: asc
    ) {
      id
      hash
      blockNumber
      timestamp
      amountUSD
      profitUSD
      liquidatee {
        id
      }
      market {
        id
        name
      }
      asset {
        id
        symbol
      }
    }
  }
`;

/**
 * One account's open positions as of a historical block.
 *
 * Deliberately not `accountPositionsQuery` with a block argument bolted on: that
 * one pages by id across a batch of accounts, and here the block is what varies
 * per call. Keeping them separate stops a stray `block` from silently appearing in
 * the live snapshot path, where a historical read would be a correctness bug
 * rather than a feature.
 */
export function accountPositionsAtBlockQuery(schemaVersion: string): string {
  const hasAssetField = !schemaVersion.startsWith("2.");
  return /* GraphQL */ `
    query AccountPositionsAt($first: Int!, $lastId: ID!, $account: String!, $block: Int!) {
      _meta {
        block {
          number
        }
      }
      positions(
        first: $first
        block: { number: $block }
        where: { account: $account, id_gt: $lastId, balance_gt: 0, hashClosed: null }
        orderBy: id
        orderDirection: asc
      ) {
        id
        side
        isCollateral
        balance
        account {
          id
        }
        ${hasAssetField ? "asset { id symbol decimals }" : ""}
        market {
          id
          liquidationThreshold
          maximumLTV
          inputTokenPriceUSD
          inputToken {
            id
            symbol
            decimals
          }
        }
      }
    }
  `;
}

/**
 * `MARKETS_QUERY` with a block argument, derived rather than copied.
 *
 * Derived because the backtest has to price history with the *same* fields the
 * live engine prices the present with; a copy would drift the moment either is
 * edited, and a drifting backtest flatters itself. String surgery earns that only
 * if it fails loudly, so each substitution is asserted — a silent miss here would
 * quietly query head state and score the model against prices from after the
 * liquidation, which is precisely the lookahead this whole file exists to avoid.
 */
export function marketsAtBlockQuery(): string {
  const withBlock = MARKETS_QUERY.replace(
    "markets(first: 500,",
    "markets(first: 500, block: { number: $block },",
  );
  if (withBlock === MARKETS_QUERY) {
    throw new Error("marketsAtBlockQuery: MARKETS_QUERY changed shape, block arg not inserted");
  }

  const named = withBlock.replace("{\n    _meta", "query MarketsAt($block: Int!) {\n    _meta");
  if (named === withBlock) {
    throw new Error("marketsAtBlockQuery: MARKETS_QUERY changed shape, could not name the operation");
  }
  return named;
}

/**
 * Whether a deployment can be replayed at all, established by asking rather than
 * assuming.
 *
 * This turned out to be the single most consequential thing the backtest measured,
 * and it is not what it looks like. Three of the five registered deployments refuse
 * every historical query, including one only a thousand blocks back, and the reason
 * the gateway gives is:
 *
 *     Unavailable(missing block: 25963051, latest: 25964051)
 *
 * The indexer's head is a thousand blocks *ahead* of the block being asked for and
 * it still cannot serve it. That is not lag and not pruning of the chain: it is
 * graph-node retaining only current entity versions, so past states were never
 * kept. Time-travel is therefore a property of who is indexing a subgraph, not of
 * the subgraph, the schema or the chain — two deployments of the *same* standardized
 * schema differ on it.
 *
 * So a backtest cannot be written against the standard alone, and the honest
 * response is to probe, report which deployments qualify, and score only those.
 * Silently catching the errors would have reported a recall figure computed over
 * whichever protocols happened to answer.
 */
export async function canTimeTravel(
  deployment: Deployment,
  block: number,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await query<{ markets: RawMarket[] }>(deployment, marketsAtBlockQuery(), { block });
    return { ok: true };
  } catch (err) {
    const e = err as Error & { cause?: unknown };
    const detail = (e.cause as Error | undefined)?.message ?? e.message;
    return { ok: false, detail };
  }
}

export type LiquidationEvent = {
  id: string;
  protocol: string;
  hash: string;
  blockNumber: number;
  timestamp: number;
  amountUsd: number;
  profitUsd: number;
  liquidatee: string;
  marketName: string;
  assetSymbol: string;
};

export async function fetchLiquidations(
  deployment: Deployment,
  from: number,
  to: number,
): Promise<LiquidationEvent[]> {
  type Row = {
    id: string;
    hash: string;
    blockNumber: string;
    timestamp: string;
    amountUSD: string;
    profitUSD: string | null;
    liquidatee: { id: string };
    market: { id: string; name: string | null };
    asset: { id: string; symbol: string } | null;
  };

  const out: LiquidationEvent[] = [];
  let lastId = "";

  for (;;) {
    const res = await query<{ liquidates: Row[] }>(deployment, LIQUIDATIONS_WINDOW_QUERY, {
      first: PAGE_SIZE,
      lastId,
      from: String(from),
      to: String(to),
    });
    const page = res.data.liquidates;
    if (page.length === 0) break;

    for (const r of page) {
      out.push({
        id: `${deployment.key}:${r.id}`,
        protocol: deployment.key,
        hash: r.hash,
        blockNumber: Number(r.blockNumber),
        timestamp: Number(r.timestamp),
        amountUsd: Number(r.amountUSD) || 0,
        profitUsd: Number(r.profitUSD) || 0,
        liquidatee: r.liquidatee.id.toLowerCase(),
        marketName: r.market.name ?? r.market.id,
        assetSymbol: r.asset?.symbol ?? "?",
      });
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE_SIZE) break;
  }

  return out;
}

/** The prices and risk parameters the engine would have read at a given block. */
export async function pricesAtBlock(
  deployment: Deployment,
  block: number,
): Promise<Map<string, number>> {
  const res = await query<{ markets: RawMarket[] }>(deployment, marketsAtBlockQuery(), { block });
  return buildPriceIndex(res.data.markets);
}

export async function accountPositionsAtBlock(
  deployment: Deployment,
  account: string,
  block: number,
  prices: Map<string, number>,
): Promise<{ positions: Position[]; dropped: number }> {
  const positions: Position[] = [];
  let dropped = 0;
  let lastId = "";

  for (;;) {
    const res = await query<{ positions: RawPosition[] }>(
      deployment,
      accountPositionsAtBlockQuery(deployment.schemaVersion),
      { first: PAGE_SIZE, lastId, account, block },
    );
    const page = res.data.positions;
    if (page.length === 0) break;

    for (const raw of page) {
      const p = normalizePosition(raw, deployment.key, prices);
      if (p) positions.push(p);
      else dropped++;
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE_SIZE) break;
  }

  return { positions, dropped };
}

/**
 * The engine's verdict on one book, at one block.
 *
 * `weightedCollateralUsd / debtUsd` — the same ratio the live risk engine
 * computes, over positions from the same normalizer, so a backtest score cannot
 * drift away from what the product actually does.
 */
export type Verdict = {
  collateralUsd: number;
  debtUsd: number;
  weightedCollateralUsd: number;
  unknownThresholdUsd: number;
  healthFactor: number;
  positions: number;
  dropped: number;
};

export function verdict(positions: Position[], dropped = 0): Verdict {
  let collateralUsd = 0;
  let debtUsd = 0;
  let weightedCollateralUsd = 0;
  let unknownThresholdUsd = 0;

  for (const p of positions) {
    if (p.side === "BORROWER") {
      debtUsd += p.valueUsd;
      continue;
    }
    collateralUsd += p.valueUsd;
    if (p.liquidationThreshold > 0) weightedCollateralUsd += p.valueUsd * p.liquidationThreshold;
    else unknownThresholdUsd += p.valueUsd;
  }

  return {
    collateralUsd,
    debtUsd,
    weightedCollateralUsd,
    unknownThresholdUsd,
    healthFactor: debtUsd > 0 ? weightedCollateralUsd / debtUsd : Infinity,
    positions: positions.length,
    dropped,
  };
}

/**
 * The same book, valued with a different set of oracle prices.
 *
 * This exists to separate the two things a miss can mean, which the health factor
 * alone conflates. Either the engine misread the position, or it read it correctly
 * and the price that triggered the liquidation had not been published yet.
 *
 * The second case is not a defect that a better read at block-1 could fix. Aave
 * liquidations are frequently triggered *by* an oracle update, and that update lands
 * in the liquidation's own block — so the last state any monitor could have observed
 * genuinely showed a solvent account. Re-pricing the block-1 positions at the
 * liquidation block's prices tells the two apart: if the book crosses its boundary
 * on the new prices alone, the position was read right and the price was the news.
 *
 * Strictly a post-hoc diagnostic. It reads state from the liquidation's own block and
 * therefore must never touch a prediction — it exists to explain misses, not to score
 * them, and the scoring above is complete before it runs.
 */
export function repriceVerdict(positions: Position[], prices: Map<string, number>): Verdict {
  const repriced = positions.map((p) => {
    const price = prices.get(p.assetId) ?? 0;
    return { ...p, valueUsd: p.amount * price };
  });
  return verdict(repriced, 0);
}

/**
 * Why the engine reached the verdict it did on a liquidated account.
 *
 * Each cause is a different defect with a different fix, and collapsing them into
 * one "miss" number would hide that most of them are properties of the schema
 * rather than of the engine.
 *
 * `flagged`           health factor below 1 at block-1. A hit.
 * `no-positions`      time-travel returned no rows for the account: the indexer
 *                     has pruned that far back, or every position was written in
 *                     the same block as the liquidation.
 * `no-debt`           rows exist but none is a priced borrow, so no health factor
 *                     is defined. Usually a debt row `normalizePosition` dropped
 *                     for want of a price, which `dropped` makes visible.
 * `unknown-threshold` some collateral published no liquidation threshold, and the
 *                     verdict flips depending on what that collateral is taken to
 *                     be worth. A declined verdict rather than a wrong one.
 * `stale-balance`     solvent by a thin margin. Balances are event-written, so
 *                     interest accrued since the account's last event is missing,
 *                     and it is exactly that accrual that crosses the boundary.
 * `solvent`           comfortably above 1 on the replayed numbers. The real miss,
 *                     and the only category worth arguing about.
 */
export type Cause =
  | "flagged"
  | "no-positions"
  | "no-debt"
  | "unknown-threshold"
  | "stale-balance"
  | "solvent";

/**
 * How close to 1 counts as `stale-balance` rather than `solvent`.
 *
 * 5% is chosen against a measurement, not by taste: Phase 3's on-chain
 * reconciliation put the median collateral disagreement at 0.04%, so 5% is two
 * orders of magnitude outside oracle noise. A book inside it is one the engine
 * called nearly right; a book outside it is one it called wrong.
 */
export const STALE_MARGIN = 1.05;

export function classify(v: Verdict): Cause {
  if (v.positions === 0) return "no-positions";
  if (v.debtUsd <= 0) return "no-debt";

  // Collateral with no published threshold contributes 0 to the weighted total,
  // which means an unweighted book computes to a health factor of 0 and would be
  // reported as flagged — flagged for the reason that it could not be evaluated,
  // which is a false positive dressed as a hit. A property test caught exactly
  // that, on a book whose *only* collateral had no threshold.
  //
  // So the unknown collateral is bracketed rather than valued. Worth nothing it
  // gives the lower bound already in `healthFactor`; worth its full value at a
  // threshold of 1 gives the upper bound, since no real threshold exceeds 1. The
  // verdict stands only where both bounds agree.
  if (isFlagged(v)) return "flagged";

  // Anything reaching here with unknown collateral is indeterminate: with none, the
  // upper bound equals the health factor and the line above already decided.
  if (v.unknownThresholdUsd > 0) return "unknown-threshold";

  if (v.healthFactor < STALE_MARGIN) return "stale-balance";
  return "solvent";
}

/**
 * Whether the engine asserts this book is past its boundary.
 *
 * The *upper* bound on the health factor, so a book is flagged only when it is
 * liquidatable however the unknown-threshold collateral is valued. Exported so the
 * panel and the threshold sweep flag exactly the way the classifier does — two
 * definitions of "flagged" would put precision and recall on different footings.
 */
export function isFlagged(v: Verdict, threshold = 1): boolean {
  if (v.debtUsd <= 0) return false;
  return (v.weightedCollateralUsd + v.unknownThresholdUsd) / v.debtUsd < threshold;
}
