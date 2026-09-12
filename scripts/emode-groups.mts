/**
 * Derive the risk policy's E-Mode correlated asset groups, from measured prices.
 *
 * Aave V3's E-Mode raises the liquidation threshold for a book whose collateral and
 * debt are correlated assets, and the Messari lending schema has no field for it.
 * Ignoring it is the largest single error in Sentinel: measured live, $3.9B of $5.7B
 * of observed debt computed to a health factor below 1 while sitting un-liquidated on
 * chain, and had to be discarded.
 *
 * The enclave cannot fix this itself. Deciding which assets are correlated takes a
 * year of daily oracle prices for every collateral asset — hundreds of HTTP calls
 * against a budget of fifteen. So the measurement happens here, offline, and the
 * result travels to the enclave inside the Vault DON secret risk policy.
 *
 * "Correlated" is not asserted by symbol. Every asset is regressed on the ETH and
 * BTC factors with `lib/cascade/factors.ts` and classified with the *same*
 * `classifyAsset` the in-process inference uses, so the offline groups and the
 * runtime inference cannot mean different things. An asset with too little history,
 * or a poor fit, lands in no group and its book keeps its published thresholds:
 * unmeasured is not the same as uncorrelated, and neither is guessed.
 *
 * Output: `docs/evidence/emode-groups.md` (the audit trail, with every beta and R2)
 * and the `emode` block to paste into `SENTINEL_RISK_POLICY`.
 *
 *   npm run emode:groups
 */

import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

import { mkdirSync, writeFileSync } from "node:fs";
import { query } from "../lib/graph/client";
import { DEPLOYMENTS } from "../lib/graph/deployments";
import { fetchPriceHistory } from "../lib/graph/history";
import { measureBetas, type AssetBeta } from "../lib/cascade/factors";
import {
  classifyAsset,
  tracksAnchor,
  EMODE_THRESHOLD,
  WRAPPER_BETA_TOLERANCE,
  WRAPPER_OFF_FACTOR_MAX,
  type EmodeCategory,
} from "../lib/cascade/emode";
import type { RawMarket } from "../lib/exposure/types";

/** Markets per deployment. The same 60 the enclave bootstraps with. */
const MARKETS = 60;

/**
 * Minimum collateral depth before an asset is worth a history fetch.
 *
 * Not a risk judgement — a budget one. The tail of a lending market is dust
 * markets, and a year of prices for each costs a paged query.
 */
const MIN_TVL_USD = 1_000_000;

const MARKETS_QUERY = /* GraphQL */ `
  query EmodeGroupMarkets($first: Int!) {
    markets(first: $first, orderBy: totalValueLockedUSD, orderDirection: desc) {
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

const marketsByProtocol: Record<string, RawMarket[]> = {};
for (const d of DEPLOYMENTS) {
  const result = await query<{ markets: RawMarket[] }>(d, MARKETS_QUERY, { first: MARKETS });
  if (result.data) marketsByProtocol[d.key] = result.data.markets;
  console.log(`${d.key}: ${result.data?.markets.length ?? 0} markets`);
}

// One entry per distinct input token, keeping the deepest market's TVL as depth.
const depth = new Map<string, { id: string; symbol: string; tvlUsd: number }>();
for (const markets of Object.values(marketsByProtocol)) {
  for (const m of markets) {
    const id = m.inputToken.id.toLowerCase();
    const tvl = Number(m.totalValueLockedUSD) || 0;
    const current = depth.get(id);
    if (!current) depth.set(id, { id, symbol: m.inputToken.symbol, tvlUsd: tvl });
    else current.tvlUsd = Math.max(current.tvlUsd, tvl);
  }
}

const assets = [...depth.values()]
  .filter((a) => a.tvlUsd >= MIN_TVL_USD)
  .sort((a, b) => b.tvlUsd - a.tvlUsd);
console.log(
  `\n${assets.length} assets above ${MIN_TVL_USD.toLocaleString("en-US")} TVL, of ${depth.size} seen`,
);

const history = await fetchPriceHistory({
  assets,
  marketsByProtocol,
  deployments: DEPLOYMENTS,
  onProgress: (msg) => console.log(`  ${msg}`),
});
console.log(
  `\nhistory: ${history.byAsset.size} series, ${history.failures.length} assets without one`,
);

const betas = measureBetas(assets, history.byAsset);

const groups: Record<EmodeCategory, string[]> = { ETH: [], BTC: [], USD: [] };
const unclassified: { asset: (typeof assets)[number]; beta: AssetBeta | undefined }[] = [];
for (const asset of assets) {
  const beta = betas.get(asset.id);
  const category = classifyAsset(beta);
  // Both gates: the category, and — because an elevated liquidation threshold is a
  // stronger claim than a shock magnitude — that the asset actually tracks the
  // category's anchor. See `tracksAnchor`.
  if (category && tracksAnchor(beta)) groups[category].push(asset.id);
  else unclassified.push({ asset, beta });
}

// A group of one cannot express a correlated pair, and the policy parser rejects it.
const emode = {
  threshold: EMODE_THRESHOLD,
  groups: (["ETH", "BTC", "USD"] as const).map((k) => groups[k]).filter((g) => g.length >= 2),
};

const pct = (n: number) => `${(100 * n).toFixed(1)}%`;
const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const lines: string[] = [];
const say = (line = "") => lines.push(line);

say("# E-Mode correlated asset groups");
say();
say(`Derived ${new Date().toISOString()} by \`npm run emode:groups\`.`);
say();
say(
  "Aave V3 E-Mode raises the liquidation threshold for a book whose collateral and " +
    "debt are correlated. The Messari lending schema does not express it, and ignoring " +
    "it made $3.9B of $5.7B of observed debt compute insolvent while alive on chain. " +
    "These groups are what let the confidential workflow evaluate those books instead " +
    "of discarding them.",
);
say();
say(
  `Each asset below was regressed on the ETH and BTC factors over up to a year of the ` +
    `protocols' own oracle prices and classified by \`classifyAsset\` in ` +
    `\`lib/cascade/emode.ts\` — the same function the runtime inference calls, so the ` +
    `groups cannot mean something different from the code that applies them. ` +
    `Threshold: **${EMODE_THRESHOLD}**, hand-verified against Aave's ` +
    `\`getUserAccountData\` in \`npm run verify:emode\`.`,
);
say();
say(
  `Group membership takes one requirement beyond that classification: the asset must ` +
    `load within ${WRAPPER_BETA_TOLERANCE} of 1 on its own anchor and no more than ` +
    `${WRAPPER_OFF_FACTOR_MAX} on the other one (\`tracksAnchor\`). Sharing a ` +
    `liquidation threshold is a stronger claim than sharing a shock: LINK falls when ` +
    `ETH falls and should be shocked with it, but it is not an Aave E-Mode pair with ` +
    `WETH, and admitting it would manufacture solvency for a book that does not have it.`,
);
say();

for (const category of ["ETH", "BTC", "USD"] as const) {
  const members = groups[category];
  say(`## ${category} — ${members.length} assets`);
  say();
  if (members.length === 0) {
    say("_None classified._");
    say();
    continue;
  }
  say("| asset | address | depth | beta ETH | beta BTC | R2 | daily vol | obs |");
  say("|---|---|---|---|---|---|---|---|");
  for (const id of members) {
    const a = depth.get(id)!;
    const b = betas.get(id)!;
    say(
      `| ${a.symbol} | \`${id}\` | ${usd(a.tvlUsd)} | ${b.betaEth.toFixed(3)} | ` +
        `${b.betaBtc.toFixed(3)} | ${pct(b.r2)} | ${b.volatility.toFixed(5)} | ${b.observations} |`,
    );
  }
  say();
}

say(`## Classified into no group — ${unclassified.length} assets`);
say();
say(
  "These keep their published thresholds. An asset with too little history or a poor " +
    "factor fit is *unmeasured*, which is not the same as uncorrelated — so no E-Mode " +
    "is claimed for it, and a book containing one does not qualify.",
);
say();
say("| asset | address | depth | beta ETH | beta BTC | R2 | obs | why |");
say("|---|---|---|---|---|---|---|---|");
for (const { asset, beta } of unclassified) {
  const why = !beta
    ? "no beta"
    : beta.confidence !== "measured"
      ? beta.reason
      : classifyAsset(beta)
        ? `in ${classifyAsset(beta)} by shock beta, but does not track the anchor`
        : "fit or beta below the gate";
  say(
    `| ${asset.symbol} | \`${asset.id}\` | ${usd(asset.tvlUsd)} | ` +
      `${beta ? beta.betaEth.toFixed(3) : "—"} | ${beta ? beta.betaBtc.toFixed(3) : "—"} | ` +
      `${beta ? pct(beta.r2) : "—"} | ${beta ? beta.observations : "—"} | ${why} |`,
  );
}
say();
say("## The policy block");
say();
say("Paste into `SENTINEL_RISK_POLICY`. Secret: see `lib/signal/policy.ts` for why.");
say();
say("```json");
say(JSON.stringify({ emode }, null, 2));
say("```");

mkdirSync("docs/evidence", { recursive: true });
writeFileSync("docs/evidence/emode-groups.md", `${lines.join("\n")}\n`);

console.log(
  `\ngroups: ETH ${groups.ETH.length}, BTC ${groups.BTC.length}, USD ${groups.USD.length}, ` +
    `unclassified ${unclassified.length}`,
);
console.log("wrote docs/evidence/emode-groups.md");
console.log(`\n"emode": ${JSON.stringify(emode)}`);
