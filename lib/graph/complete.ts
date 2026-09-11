/**
 * Exhaustive position fetch for a chosen set of accounts.
 *
 * The market-stratified sample answers "how much of the book is cross-protocol".
 * It cannot answer "is this account safe", because it may hold an account's debt
 * while dropping the collateral backing it. Anything account-level — health
 * factors, cascade seeds, the published signal — has to run on complete position
 * sets, which is what this produces.
 */

import { query } from "./client";
import type { Deployment } from "./deployments";
import { accountPositionsQuery } from "./queries";
import { normalizePosition } from "../exposure/normalize";
import type { Position, RawPosition } from "../exposure/types";

type PositionsData = { positions: RawPosition[] };

/** Accounts per `account_in` filter. Large filters make the gateway slow. */
const ACCOUNTS_PER_QUERY = 100;

export async function fetchPositionsForAccounts(
  deployments: Deployment[],
  accounts: string[],
  prices: Map<string, number>,
  { pageSize = 1000, concurrency = 6 }: { pageSize?: number; concurrency?: number } = {},
): Promise<Position[]> {
  if (accounts.length === 0) return [];

  const batches: { deployment: Deployment; accounts: string[] }[] = [];
  for (const deployment of deployments) {
    for (let i = 0; i < accounts.length; i += ACCOUNTS_PER_QUERY) {
      batches.push({ deployment, accounts: accounts.slice(i, i + ACCOUNTS_PER_QUERY) });
    }
  }

  const out: Position[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      const document = accountPositionsQuery(batch.deployment.schemaVersion);
      let lastId = "";

      // No cap: a truncated result here would reintroduce exactly the
      // incompleteness this pass exists to remove.
      for (;;) {
        const res = await query<PositionsData>(batch.deployment, document, {
          first: pageSize,
          lastId,
          accounts: batch.accounts,
        });
        const page = res.data.positions;
        if (page.length === 0) break;

        for (const raw of page) {
          const p = normalizePosition(raw, batch.deployment.key, prices);
          if (p) out.push(p);
        }

        lastId = page[page.length - 1].id;
        if (page.length < pageSize) break;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
