/**
 * Daily price history from the lending schema.
 *
 * `MarketDailySnapshot.inputTokenPriceUSD` is the oracle price the protocol
 * itself acted on that day. Using it rather than an external price API is not a
 * convenience: it means the correlations Sentinel measures are correlations
 * between the exact numbers that decide liquidations, including any oracle lag or
 * deviation, rather than between prices from a venue no lending protocol reads.
 *
 * One query shape covers every deployment. The single version concession is that
 * ordering and cursoring use `timestamp`, which exists on 2.0.1 through 3.1.0,
 * rather than `days`, which Compound V2 on 2.0.1 does not have.
 */

import { query } from "./client";
import type { Deployment } from "./deployments";
import type { RawMarket } from "../exposure/types";

export const DAILY_PRICES_QUERY = /* GraphQL */ `
  query DailyPrices($market: String!, $first: Int!, $before: BigInt!) {
    _meta {
      block {
        number
      }
    }
    marketDailySnapshots(
      first: $first
      where: { market: $market, timestamp_lt: $before, inputTokenPriceUSD_gt: 0 }
      orderBy: timestamp
      orderDirection: desc
    ) {
      timestamp
      inputTokenPriceUSD
    }
  }
`;

/** Price by day index (unix days), so series from different markets align. */
export type PriceSeries = Map<number, number>;

export type HistoryResult = {
  byAsset: Map<string, PriceSeries>;
  /** Which market each asset's series came from, for the audit trail. */
  sources: Map<string, { protocol: string; marketId: string; marketName: string; days: number }>;
  failures: { asset: string; detail: string }[];
};

export const SECONDS_PER_DAY = 86_400;

/**
 * Pick one market per asset: the deepest one that quotes it.
 *
 * Same rule as `buildPriceIndex` uses for spot prices, for the same reason — the
 * deepest market's oracle read is the best-supported one — and deliberately the
 * same rule, so that an asset's spot price and its history come from one source
 * and cannot disagree about what market they describe.
 */
export function deepestMarketPerAsset(
  marketsByProtocol: Record<string, RawMarket[]>,
): Map<string, { protocol: string; market: RawMarket }> {
  const best = new Map<string, { protocol: string; market: RawMarket; tvl: number }>();
  for (const [protocol, markets] of Object.entries(marketsByProtocol)) {
    for (const market of markets) {
      const id = market.inputToken.id.toLowerCase();
      const tvl = Number(market.totalValueLockedUSD) || 0;
      const current = best.get(id);
      if (!current || tvl > current.tvl) best.set(id, { protocol, market, tvl });
    }
  }
  return new Map([...best].map(([k, v]) => [k, { protocol: v.protocol, market: v.market }]));
}

export type HistoryOptions = {
  assets: { id: string; symbol: string }[];
  marketsByProtocol: Record<string, RawMarket[]>;
  deployments: Deployment[];
  /** Trading days of history to request. */
  days?: number;
  pageSize?: number;
  concurrency?: number;
  onProgress?: (msg: string) => void;
};

export async function fetchPriceHistory({
  assets,
  marketsByProtocol,
  deployments,
  days = 365,
  pageSize = 1000,
  concurrency = 6,
  onProgress = () => {},
}: HistoryOptions): Promise<HistoryResult> {
  const markets = deepestMarketPerAsset(marketsByProtocol);
  const byKey = new Map(deployments.map((d) => [d.key, d]));

  const byAsset = new Map<string, PriceSeries>();
  const sources = new Map<
    string,
    { protocol: string; marketId: string; marketName: string; days: number }
  >();
  const failures: { asset: string; detail: string }[] = [];

  const jobs = assets.map((a) => a.id.toLowerCase());
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const assetId = jobs[cursor++];
      if (!assetId) return;

      const pick = markets.get(assetId);
      if (!pick) {
        failures.push({ asset: assetId, detail: "no lending market quotes this asset" });
        continue;
      }
      const deployment = byKey.get(pick.protocol);
      if (!deployment) {
        failures.push({ asset: assetId, detail: `unknown deployment ${pick.protocol}` });
        continue;
      }

      const series: PriceSeries = new Map();
      let before = String(Math.floor(Date.now() / 1000) + SECONDS_PER_DAY);

      try {
        while (series.size < days) {
          const res = await query<{
            marketDailySnapshots: { timestamp: string; inputTokenPriceUSD: string }[];
          }>(deployment, DAILY_PRICES_QUERY, {
            market: pick.market.id,
            first: Math.min(pageSize, days - series.size),
            before,
          });

          const rows = res.data.marketDailySnapshots;
          if (rows.length === 0) break;

          for (const row of rows) {
            const ts = Number(row.timestamp);
            const price = Number(row.inputTokenPriceUSD);
            if (!Number.isFinite(price) || price <= 0) continue;
            const day = Math.floor(ts / SECONDS_PER_DAY);
            // Several snapshots can share a day; the query is newest-first, so
            // the first one seen is the latest and is kept.
            if (!series.has(day)) series.set(day, price);
          }

          before = rows[rows.length - 1].timestamp;
        }
      } catch (err) {
        failures.push({ asset: assetId, detail: (err as Error).message });
        continue;
      }

      if (series.size === 0) {
        failures.push({ asset: assetId, detail: "market has no priced daily snapshots" });
        continue;
      }

      byAsset.set(assetId, series);
      sources.set(assetId, {
        protocol: pick.protocol,
        marketId: pick.market.id,
        marketName: pick.market.name ?? pick.market.id,
        days: series.size,
      });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  onProgress(`history: ${byAsset.size}/${assets.length} assets, ${failures.length} without history`);

  return { byAsset, sources, failures };
}
