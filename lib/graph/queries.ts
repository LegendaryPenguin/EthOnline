/**
 * The query documents.
 *
 * These documents are executed byte-identically against every deployment in the
 * registry. If a change here would need a per-*protocol* variant, that is a
 * signal the standardized schema is not carrying the weight, so resist it.
 *
 * One concession, measured and worth naming: `positionsQuery` varies by *schema
 * version*, because `Position.asset` was added in 3.x and Compound V2 is live on
 * 2.0.1 today. That is a weaker admission than a per-protocol adapter — five
 * protocols still share one query shape, keyed on a version string the subgraph
 * itself reports — but it is the honest limit of the standard as deployed.
 */

/** Protocol-level totals plus sync state. */
export const PROTOCOL_QUERY = /* GraphQL */ `
  {
    _meta {
      block {
        number
        timestamp
      }
    }
    lendingProtocols {
      id
      name
      schemaVersion
      subgraphVersion
      totalValueLockedUSD
      totalBorrowBalanceUSD
      totalDepositBalanceUSD
      cumulativeUniqueUsers
      openPositionCount
    }
  }
`;

/**
 * Markets carry the risk parameters and the only price signal in the schema
 * (Token has no price field), so this doubles as the asset price source.
 */
export const MARKETS_QUERY = /* GraphQL */ `
  {
    _meta {
      block {
        number
      }
    }
    markets(first: 500, orderBy: totalValueLockedUSD, orderDirection: desc) {
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
 * Sentinel value for the first page's descending cursor: larger than any real
 * balance, so page one is unfiltered.
 */
export const BALANCE_CURSOR_START = "1" + "0".repeat(40);

/**
 * Open positions in one market, largest first, paged by a descending balance
 * cursor.
 *
 * Two design decisions here carry the credibility of the headline metric.
 *
 * **Ordered by balance, not id.** Aave V3 alone has far more positions than a
 * hackathon query budget can page, so the sample is always truncated. A sample
 * ordered by `id` is an arbitrary slice of addresses, and any share-of-debt
 * figure computed from it would be meaningless. Ordered by balance, every
 * position dropped is smaller than every position kept, so the resulting share
 * is a lower bound rather than an estimate.
 *
 * **Stratified per market.** `balance` is a raw BigInt, so ranking it across
 * markets would sort by decimal count as much as by value — an 18-decimal token
 * outranks a larger USDC position. Within a single market decimals are constant,
 * so balance order is exactly value order. Sampling market by market is what
 * makes "largest first" mean what it says.
 *
 * Cursoring on `balance_lt` rather than `skip` avoids the gateway's skip cap of
 * 5000. The tradeoff: positions whose balance exactly equals a page boundary are
 * skipped. Exact BigInt collisions are rare, and the effect can only remove
 * value from the sample, never add it, so it preserves the lower-bound
 * direction.
 *
 * `asset` exists only from schema 3.x. On 2.x a position's asset is the market's
 * input token, so the field is requested conditionally and normalized back into
 * one shape downstream.
 */
export function positionsQuery(schemaVersion: string): string {
  const hasAssetField = !schemaVersion.startsWith("2.");
  return /* GraphQL */ `
    query Positions($first: Int!, $lastBalance: BigInt!, $market: String!) {
      _meta {
        block {
          number
        }
      }
      positions(
        first: $first
        where: {
          market: $market
          balance_lt: $lastBalance
          balance_gt: 0
          hashClosed: null
        }
        orderBy: balance
        orderDirection: desc
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
          exchangeRate
          inputToken {
            id
            symbol
            decimals
          }
          outputToken {
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
 * Every open position belonging to a given set of accounts.
 *
 * The stratified market sample is correct for aggregates but wrong for
 * per-account risk: an account's debt can sit in a deep market and be captured
 * while its collateral ranks below the cutoff in another and is dropped, which
 * makes the health factor collapse for no reason but our own sampling. Health
 * factors are only meaningful on a complete position set, so accounts of interest
 * are re-fetched exhaustively here.
 *
 * There is no `orderBy: balance` and no truncation. Paging is by `id` because
 * completeness, not ranking, is the whole point.
 */
export function accountPositionsQuery(schemaVersion: string): string {
  const hasAssetField = !schemaVersion.startsWith("2.");
  return /* GraphQL */ `
    query AccountPositions($first: Int!, $lastId: ID!, $accounts: [String!]!) {
      _meta {
        block {
          number
        }
      }
      positions(
        first: $first
        where: {
          account_in: $accounts
          id_gt: $lastId
          balance_gt: 0
          hashClosed: null
        }
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
          exchangeRate
          inputToken {
            id
            symbol
            decimals
          }
          outputToken {
            id
            symbol
            decimals
          }
        }
      }
    }
  `;
}

/** Historical liquidations — the ground truth the risk model is scored against. */
export const LIQUIDATIONS_QUERY = /* GraphQL */ `
  query Liquidations($first: Int!, $lastId: ID!) {
    _meta {
      block {
        number
      }
    }
    liquidates(
      first: $first
      where: { id_gt: $lastId }
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
