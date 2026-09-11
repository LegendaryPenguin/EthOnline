/**
 * Registry and capture for the Messari DEX AMM standardized schema.
 *
 * This is Sentinel's *second* standardized schema. The lending schema says who
 * is levered and on what collateral; this one says whether that collateral can
 * actually be sold. Neither question is answerable from the other, and both are
 * answered by one query document per schema.
 *
 * The two schemas are also each other's audit. The DEX schema publishes its own
 * `totalValueLockedUSD`, and on mainnet today it is unusable: ordering Uniswap
 * V3 pools by it returns a "Wrapped Ether/Yescoin 0.3%" pool claiming $94
 * billion, because the pool's own reserve ratio is taken as the price of a token
 * nobody quotes. Sentinel therefore never reads a USD figure from this schema.
 * It reads token *balances* — a fact about the chain, not a derived valuation —
 * and prices them with the lending schema's oracle feeds.
 *
 * That single decision is what makes the fake-pool class disappear, without a
 * denylist and without a magic threshold: a pool is usable only if every one of
 * its tokens is quoted by a lending oracle. Yescoin is not lending collateral,
 * so it never enters. See docs/evidence/phase4-cascade.md.
 */

import { query, requireApiKey, type QueryResult } from "./client";
import type { Deployment } from "./deployments";

/**
 * DEX AMM deployments on Ethereum mainnet that answer this schema.
 *
 * Four, for the same reason the lending registry has four: that is what
 * publishes the schema on the decentralized network. Balancer and Maverick both
 * have mainnet subgraphs, and neither exposes `dexAmmProtocols` — checked, and
 * recorded in REJECTED_DEX_CANDIDATES rather than quietly omitted, because
 * Balancer's absence is the direct cause of a gap in the results.
 */
export const DEX_DEPLOYMENTS: Deployment[] = [
  {
    key: "uniswap-v3",
    label: "Uniswap V3",
    subgraphId: "4cKy6QQMc5tpfdx8yxfYeb9TLZmgLQe44ddW1G7NwkA6",
    network: "mainnet",
    schemaVersion: "4.0.0",
  },
  {
    key: "sushiswap-v2",
    label: "SushiSwap",
    subgraphId: "77jZ9KWeyi3CJ96zkkj5s1CojKPHt6XJKjLFzsDCd8Fd",
    network: "mainnet",
    schemaVersion: "1.3.2",
  },
  {
    key: "sushiswap-v3",
    label: "SushiSwap V3",
    subgraphId: "2tGWMrDha4164KkFAfkU3rDCtuxGb4q1emXmFdLLzJ8x",
    network: "mainnet",
    schemaVersion: "4.0.0",
  },
  {
    key: "curve",
    label: "Curve Finance",
    subgraphId: "3fy93eAT56UJsRCEht8iFhfi6wjHWXtZ9dnnbQmvFopF",
    network: "mainnet",
    schemaVersion: "1.3.0",
  },
];

/** Mainnet DEX subgraphs evaluated that do not publish the standardized schema. */
export const REJECTED_DEX_CANDIDATES = [
  {
    label: "Balancer V2",
    subgraphId: "C4ayEZP2yTXRAB8vSaTrgN4m9anTe9Mdm2ViyiAuV9TV",
    reason:
      "no dexAmmProtocols field; Balancer's own schema. Its absence is load-bearing: " +
      "rsETH's real liquidity is a Balancer pool, which is why rsETH resolves to zero " +
      "measurable depth here",
  },
  {
    label: "maverick-mainnet",
    subgraphId: "H4KMc3uRaRqKrM8dq8GKCt9gwmMQsRRiQRThZCM16KtB",
    reason: "no dexAmmProtocols field; not the Messari DEX AMM schema",
  },
  {
    label: "Uniswap V3 Mainnet (uniswap-labs)",
    subgraphId: "9fWsevEC9Yz4WdW9QyUvu2JXsxyXAxc1X4HaEkmyyc75",
    reason: "Uniswap's own schema, not Messari's; superseded by the standardized deployment",
  },
] as const;

/**
 * One query document, every DEX deployment.
 *
 * `inputTokens_contains` with *two* tokens is what makes this tractable. Asking
 * for every pool holding WETH means paging thousands of rows in no trustworthy
 * order — `totalValueLockedUSD` is the fake number, so there is no safe
 * `orderBy`. Asking for pools holding both legs of a pair returns a handful, so
 * the result set is bounded and complete rather than sampled, and no ordering is
 * needed at all.
 *
 * Fields consumed, all of them present on schema 1.3.0 through 4.0.0:
 *   inputTokens{id,symbol,decimals}  pool composition
 *   inputTokenBalances               reserves, raw — the only quantity trusted
 *   isSingleSided                    excludes staking-style pools, which cannot swap
 * Deliberately not consumed: totalValueLockedUSD, inputTokenBalancesUSD.
 */
export const POOLS_QUERY = /* GraphQL */ `
  query Pools($tokens: [String!]!, $first: Int!) {
    _meta {
      block {
        number
      }
    }
    liquidityPools(first: $first, where: { inputTokens_contains: $tokens, isSingleSided: false }) {
      id
      name
      inputTokenBalances
      inputTokens {
        id
        symbol
        decimals
      }
    }
  }
`;

type RawPool = {
  id: string;
  name: string;
  inputTokenBalances: string[];
  inputTokens: { id: string; symbol: string; decimals: number }[];
};

/** One pool's usable reserve of one asset. */
export type PoolReserve = {
  dex: string;
  poolId: string;
  name: string;
  /** Reserve of the asset in token units. */
  reserveTokens: number;
  /** That reserve valued at the lending oracle price. */
  reserveUsd: number;
  /** Other tokens in the pool, for the audit trail. */
  pairedWith: string[];
};

export type AssetLiquidity = {
  assetId: string;
  symbol: string;
  /** Summed across usable pools. See lib/cascade/impact.ts for why summing is valid. */
  reserveTokens: number;
  reserveUsd: number;
  pools: PoolReserve[];
};

export type LiquidityIndex = {
  byAsset: Map<string, AssetLiquidity>;
  blocks: Record<string, number>;
  /** Rejections by cause, so a thin result is explainable rather than mysterious. */
  rejected: { unpricedToken: number; impliedPriceOutOfBand: number; dust: number };
  /**
   * Asset-side value the implied-price gate threw away, per asset.
   *
   * Reported rather than spot-checked once, because this gate is the one place a
   * bug would quietly understate depth and so overstate the cascade. If a
   * rejected pool ever holds a material share of an asset's liquidity, that shows
   * up here instead of in nobody's console.
   */
  rejectedUsdByAsset: Record<string, number>;
  /** Pairs whose query failed outright, per deployment. */
  failures: { deployment: string; detail: string }[];
  queryCount: number;
};

/**
 * How far a pool's reserve-implied price may sit from the lending oracle price.
 *
 * Deliberately loose — a factor of ten — because a reserve ratio is *not* a spot
 * price for either of the two dominant venue types here. Uniswap V3 concentrates
 * liquidity in a tick range, so its total balances imply a price that can sit
 * far from spot; the four live WETH/USDC pools imply $1,504 to $6,851 against an
 * oracle $2,520, all four of them perfectly healthy. Curve's amplified invariant
 * distorts it in the other direction. Tightening this band would delete real
 * venues. It exists to catch a reserve ratio that is nonsense by orders of
 * magnitude, and the unpriced-token gate above is what does the real work.
 */
export const MAX_IMPLIED_PRICE_DEVIATION = 10;

/** Pools holding less than this of the asset are noise, not exit liquidity. */
export const MIN_POOL_RESERVE_USD = 10_000;

export type LiquidityOptions = {
  /** Assets to measure exit liquidity for. */
  assets: { id: string; symbol: string }[];
  /** Assets to pair them against. Both directions of a pair are the same query. */
  quotes: { id: string; symbol: string }[];
  /** Oracle prices from the lending schema, keyed by lowercased address. */
  prices: Map<string, number>;
  concurrency?: number;
  poolsPerPair?: number;
  deployments?: Deployment[];
  onProgress?: (msg: string) => void;
};

/**
 * Measure exit liquidity for a set of assets across every DEX deployment.
 *
 * Pools are deduplicated by `dex:poolId`, which matters more than it sounds:
 * Curve's tricrypto pool holds WBTC, WETH and USDC at once, so it is returned by
 * the (WBTC,WETH), (WBTC,USDC) and (WETH,USDC) pair queries alike. Summing
 * without dedupe triple-counted its reserves.
 */
export async function captureLiquidity({
  assets,
  quotes,
  prices,
  concurrency = 10,
  poolsPerPair = 500,
  deployments = DEX_DEPLOYMENTS,
  onProgress = () => {},
}: LiquidityOptions): Promise<LiquidityIndex> {
  requireApiKey();

  // Unordered pairs: (A,B) and (B,A) are the same `contains` filter.
  const pairs: [string, string][] = [];
  const seenPair = new Set<string>();
  for (const a of assets) {
    for (const q of quotes) {
      const [x, y] = [a.id.toLowerCase(), q.id.toLowerCase()].sort();
      if (x === y) continue;
      const key = `${x}|${y}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      pairs.push([x, y]);
    }
  }

  const jobs: { deployment: Deployment; pair: [string, string] }[] = [];
  for (const deployment of deployments) {
    for (const pair of pairs) jobs.push({ deployment, pair });
  }
  onProgress(`liquidity: ${pairs.length} pairs x ${deployments.length} deployments`);

  const wanted = new Set(assets.map((a) => a.id.toLowerCase()));
  const byAsset = new Map<string, AssetLiquidity>();
  const seenPool = new Set<string>();
  const blocks: Record<string, number> = {};
  const rejected = { unpricedToken: 0, impliedPriceOutOfBand: 0, dust: 0 };
  const rejectedUsdByAsset: Record<string, number> = {};
  const failures: { deployment: string; detail: string }[] = [];
  let queryCount = 0;
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const job = jobs[cursor++];
      if (!job) return;

      let res: QueryResult<{ liquidityPools: RawPool[] }>;
      try {
        res = await query<{ liquidityPools: RawPool[] }>(job.deployment, POOLS_QUERY, {
          tokens: job.pair,
          first: poolsPerPair,
        });
        queryCount++;
      } catch (err) {
        failures.push({
          deployment: job.deployment.key,
          detail: `${job.pair.join("/")}: ${(err as Error).message}`,
        });
        continue;
      }

      blocks[job.deployment.key] = Math.max(blocks[job.deployment.key] ?? 0, res.block);

      for (const pool of res.data.liquidityPools) {
        const poolKey = `${job.deployment.key}:${pool.id}`;
        if (seenPool.has(poolKey)) continue;

        // Gate 1: every token must be quoted by a lending oracle. A pool whose
        // composition cannot be valued cannot be reasoned about, and this is
        // what excludes the fabricated-TVL pools as a class.
        const tokens = pool.inputTokens.map((t) => ({
          ...t,
          id: t.id.toLowerCase(),
          price: prices.get(t.id.toLowerCase()),
        }));
        if (tokens.some((t) => !t.price || t.price <= 0)) {
          rejected.unpricedToken++;
          seenPool.add(poolKey);
          continue;
        }

        seenPool.add(poolKey);

        const balances = tokens.map((t, i) => {
          const raw = pool.inputTokenBalances[i];
          return raw ? Number(BigInt(raw)) / 10 ** t.decimals : 0;
        });

        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i];
          if (!wanted.has(token.id)) continue;
          const reserveTokens = balances[i];
          if (reserveTokens <= 0) continue;

          // Gate 2: the reserve ratio against the deepest other leg must be in
          // the same ballpark as the oracle. Order-of-magnitude only; see
          // MAX_IMPLIED_PRICE_DEVIATION for why it cannot be tight.
          const others = tokens
            .map((t, j) => ({ t, value: balances[j] * t.price!, j }))
            .filter((o) => o.j !== i)
            .sort((a, b) => b.value - a.value);
          const other = others[0];
          if (other && balances[other.j] > 0) {
            const implied = (balances[other.j] / reserveTokens) * other.t.price!;
            const ratio = implied / token.price!;
            if (ratio > MAX_IMPLIED_PRICE_DEVIATION || ratio < 1 / MAX_IMPLIED_PRICE_DEVIATION) {
              rejected.impliedPriceOutOfBand++;
              rejectedUsdByAsset[token.symbol] =
                (rejectedUsdByAsset[token.symbol] ?? 0) + reserveTokens * token.price!;
              continue;
            }
          }

          const reserveUsd = reserveTokens * token.price!;
          if (reserveUsd < MIN_POOL_RESERVE_USD) {
            rejected.dust++;
            continue;
          }

          const entry = byAsset.get(token.id) ?? {
            assetId: token.id,
            symbol: token.symbol,
            reserveTokens: 0,
            reserveUsd: 0,
            pools: [],
          };
          entry.reserveTokens += reserveTokens;
          entry.reserveUsd += reserveUsd;
          entry.pools.push({
            dex: job.deployment.key,
            poolId: pool.id,
            name: pool.name,
            reserveTokens,
            reserveUsd,
            pairedWith: tokens.filter((_, j) => j !== i).map((t) => t.symbol),
          });
          byAsset.set(token.id, entry);
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  for (const entry of byAsset.values()) entry.pools.sort((a, b) => b.reserveUsd - a.reserveUsd);

  onProgress(
    `liquidity: ${byAsset.size}/${assets.length} assets priced, ${seenPool.size} pools seen, ` +
      `${rejected.unpricedToken} rejected for unpriced tokens`,
  );

  return { byAsset, blocks, rejected, rejectedUsdByAsset, failures, queryCount };
}
