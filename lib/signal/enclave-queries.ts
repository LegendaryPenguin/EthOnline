/**
 * The query documents the enclave uses, shaped by the enclave's budget.
 *
 * These are separate from `lib/graph/queries.ts` for a reason that is a finding
 * rather than an inconvenience. A CRE workflow gets 15 HTTP calls per execution and
 * 250 KB per response (`cre workflow limits export`), so the app's snapshot
 * strategy — one paged request per market per deployment, hundreds of round trips —
 * does not fit inside a TEE at all. The confidential path has to say the same thing
 * in a fifteenth of the calls.
 *
 * The budget is spent in three passes, five calls each:
 *
 *   1. bootstrap    protocol totals, sync block, and markets (prices + risk
 *                   parameters) — one call per deployment
 *   2. discovery    the largest positions in the deepest markets, several markets
 *                   aliased into a single document — one call per deployment
 *   3. completion   complete books for the candidate accounts — one call per
 *                   deployment
 *
 * Pass 3 is not optional. A health factor computed from a truncated book is not a
 * pessimistic health factor, it is a meaningless one: an account's debt can rank
 * inside the sample while its collateral ranks outside, and the book then reads as
 * insolvent because of our sampling. Phase 2 hit exactly this. So discovery only
 * nominates accounts, and every number the signal publishes comes from a complete
 * book fetched in pass 3.
 *
 * Aliasing is what buys pass 2. `m0: positions(...) m1: positions(...)` in one
 * document is one HTTP call against many markets, and it is still one document
 * shape across every deployment — the standardized schema is what makes the
 * aliases interchangeable.
 *
 * Shared with the app and with the tests, so: no `process`, no `fetch`, no Node.
 */

/** Fields the normalizer needs, and nothing else — bytes are the scarce resource. */
function positionFields(schemaVersion: string): string {
  // Position.asset arrived in 3.x; on 2.0.1 the market's input token is the asset.
  // Same concession as the live path, for the same reason.
  const asset = schemaVersion.startsWith("2.") ? "" : "asset { id symbol decimals }";
  return `
    id
    side
    isCollateral
    balance
    account { id }
    ${asset}
    market {
      id
      liquidationThreshold
      maximumLTV
      inputTokenPriceUSD
      exchangeRate
      inputToken { id symbol decimals }
      outputToken { id symbol decimals }
    }
  `;
}

/**
 * Pass 1: everything that is not a position.
 *
 * Three top-level selections in one call because they are all cheap and all
 * required before any position can be valued: the block for provenance, the
 * protocol totals for the coverage denominator, and the markets for prices and
 * liquidation thresholds.
 */
export const ENCLAVE_BOOTSTRAP_QUERY = /* GraphQL */ `
  query EnclaveBootstrap($markets: Int!) {
    _meta {
      block {
        number
        timestamp
      }
    }
    lendingProtocols {
      name
      schemaVersion
      totalBorrowBalanceUSD
      totalValueLockedUSD
    }
    markets(first: $markets, orderBy: totalValueLockedUSD, orderDirection: desc) {
      id
      name
      isActive
      canUseAsCollateral
      canBorrowFrom
      maximumLTV
      liquidationThreshold
      liquidationPenalty
      inputTokenPriceUSD
      totalValueLockedUSD
      totalBorrowBalanceUSD
      totalDepositBalanceUSD
      inputToken {
        id
        symbol
        decimals
      }
    }
  }
`;

/**
 * Market ids are interpolated as literals rather than passed as variables, because
 * one variable cannot fan out into N aliases. So they are validated first: a
 * subgraph market id is hex or a hyphenated composite, never a quote or a brace.
 * Interpolating an unvalidated string into a query document is an injection, and
 * the fact that the source is a subgraph rather than a user does not change that.
 */
const MARKET_ID = /^[0-9a-zA-Z:_.-]+$/;

/**
 * Pass 2: the largest positions in the deepest markets, aliased into one call.
 *
 * Largest-first, per market, exactly as the live path does — and for the same
 * reason. Every position the budget excludes is smaller than every position it
 * includes, so what the enclave publishes is a lower bound rather than an
 * estimate. Ordering by id instead would make the sample an arbitrary slice of
 * addresses and the resulting share of debt would mean nothing.
 *
 * Per market rather than globally because `balance` is a raw BigInt: ranked across
 * markets it sorts by decimal count as much as by value, so an 18-decimal dust
 * position outranks a large USDC one. Within one market decimals are constant.
 */
export function topPositionsQuery(
  schemaVersion: string,
  marketIds: string[],
  perMarket: number,
): string {
  if (marketIds.length === 0) throw new Error("topPositionsQuery: no markets");
  if (!Number.isInteger(perMarket) || perMarket <= 0) {
    throw new Error(`topPositionsQuery: perMarket must be a positive integer, got ${perMarket}`);
  }

  const aliases = marketIds.map((id, i) => {
    if (!MARKET_ID.test(id)) {
      throw new Error(`topPositionsQuery: refusing to interpolate market id ${JSON.stringify(id)}`);
    }
    return `
    m${i}: positions(
      first: ${perMarket}
      where: { market: "${id}", balance_gt: 0, hashClosed: null }
      orderBy: balance
      orderDirection: desc
    ) {
      ...P
    }`;
  });

  return /* GraphQL */ `
    query EnclaveTopPositions {
      _meta {
        block {
          number
        }
      }
      ${aliases.join("")}
    }
    fragment P on Position {
      ${positionFields(schemaVersion)}
    }
  `;
}

/**
 * Pass 3: every open position of a nominated account.
 *
 * No truncation and no ranking — completeness is the entire point, and the caller
 * must fail loudly if the single page fills rather than quietly scoring partial
 * books. There is no budget left for a second page, which is why the candidate
 * count is capped upstream instead.
 */
export function completeBooksQuery(schemaVersion: string): string {
  return /* GraphQL */ `
    query EnclaveCompleteBooks($accounts: [String!]!, $first: Int!) {
      _meta {
        block {
          number
        }
      }
      positions(
        first: $first
        where: { account_in: $accounts, balance_gt: 0, hashClosed: null }
        orderBy: id
        orderDirection: asc
      ) {
        ${positionFields(schemaVersion)}
      }
    }
  `;
}

/** Collect the aliased pass-2 selections back into one list. */
export function collectAliasedPositions<T>(data: Record<string, unknown>): T[] {
  const out: T[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!/^m\d+$/.test(key)) continue;
    if (Array.isArray(value)) out.push(...(value as T[]));
  }
  return out;
}
