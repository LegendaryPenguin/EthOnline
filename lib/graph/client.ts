/**
 * Gateway client for the decentralized network.
 *
 * Two rules this module exists to enforce:
 *
 *  1. There is no mock fallback. If the key is missing or a deployment is
 *     unreachable, callers get an error. Silently serving fake numbers would
 *     invalidate every claim the project makes, so it is not an option.
 *  2. Sync state is data, not an assumption. Every response carries the block
 *     it was served at, and stale deployments are excluded loudly.
 */

import type { Deployment } from "./deployments";

const GATEWAY = "https://gateway.thegraph.com/api";

/** Deployments further behind head than this are excluded from analysis. */
export const MAX_BLOCK_LAG = 1000;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly deployment: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

export function requireApiKey(): string {
  const key = process.env.GRAPH_API_KEY;
  if (!key) {
    throw new Error(
      "GRAPH_API_KEY is not set. Sentinel has no mock mode by design — " +
        "create a key at https://thegraph.com/studio/apikeys/ and put it in .env.local",
    );
  }
  return key;
}

export type QueryResult<T> = {
  data: T;
  /** Block the gateway served this response at. */
  block: number;
  deployment: Deployment;
  /** Wall-clock ms for the request, for the query-cost budget. */
  elapsedMs: number;
};

type GqlResponse<T> = {
  data?: T & { _meta?: { block?: { number?: number } } };
  errors?: { message: string }[];
};

/**
 * Execute one query document against one deployment.
 *
 * Retries only on transport-level and 5xx failures. GraphQL errors are not
 * retried: they are deterministic, so a retry just wastes the query budget.
 */
export async function query<T>(
  deployment: Deployment,
  document: string,
  variables: Record<string, unknown> = {},
  { retries = 2, timeoutMs = 45_000 }: { retries?: number; timeoutMs?: number } = {},
): Promise<QueryResult<T>> {
  const url = `${GATEWAY}/${requireApiKey()}/subgraphs/id/${deployment.subgraphId}`;
  const started = Date.now();
  let lastTransportError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: document, variables }),
        signal: controller.signal,
      });

      if (res.status >= 500) {
        lastTransportError = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        throw new GraphError(`HTTP ${res.status} from gateway`, deployment.key);
      }

      const body = (await res.json()) as GqlResponse<T>;
      if (body.errors?.length) {
        throw new GraphError(
          `GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`,
          deployment.key,
        );
      }
      if (!body.data) {
        throw new GraphError("Gateway returned no data", deployment.key);
      }

      return {
        data: body.data as T,
        block: body.data._meta?.block?.number ?? 0,
        deployment,
        elapsedMs: Date.now() - started,
      };
    } catch (err) {
      if (err instanceof GraphError) throw err;
      lastTransportError = err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw new GraphError(
    `Unreachable after ${retries + 1} attempts`,
    deployment.key,
    lastTransportError,
  );
}

/**
 * Run the same document across many deployments concurrently.
 *
 * Partial failure is expected and survivable — one dead deployment must not
 * take the whole snapshot down — so failures are returned rather than thrown.
 */
export async function queryAll<T>(
  deployments: Deployment[],
  document: string,
  variables: Record<string, unknown> = {},
): Promise<{ ok: QueryResult<T>[]; failed: { deployment: Deployment; error: Error }[] }> {
  const settled = await Promise.allSettled(
    deployments.map((d) => query<T>(d, document, variables)),
  );

  const ok: QueryResult<T>[] = [];
  const failed: { deployment: Deployment; error: Error }[] = [];

  settled.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push(r.value);
    else failed.push({ deployment: deployments[i], error: r.reason as Error });
  });

  return { ok, failed };
}
