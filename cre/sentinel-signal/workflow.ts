/**
 * Sentinel's confidential aggregation, as a Chainlink CRE workflow.
 *
 * ─── What is confidential here, precisely ───────────────────────────────────
 *
 * A confidential workflow runs inside an attested enclave, but the workflow
 * *binary* is what the Workflow DON hands to that enclave — so this file's logic
 * is revealed to node operators. What the enclave keeps confidential is the data
 * the logic computes over: Vault DON secrets released by `getSecret`, the request
 * and response payloads of HTTP calls made from inside the enclave, and
 * intermediate values that never cross back.
 *
 * That boundary happens to be exactly the one Sentinel needs, which is why the
 * design is shaped around it rather than around a wish:
 *
 *   confidential   the per-address position rows returned by the Graph gateway —
 *                  the ranked map of who is levered on what, across which
 *                  protocols. This is the response payload of an in-enclave HTTP
 *                  call, so it never exists outside the enclave.
 *   confidential   the Graph API key, and therefore the request URL that embeds it.
 *   confidential   the risk policy: shock ladder, per-asset betas, composite
 *                  weights, k-anonymity floor. A Vault DON secret, because a
 *                  published recipe is a gameable one.
 *   public         this code, and the aggregate signal reported at the end.
 *
 * ─── Why the enclave is load-bearing ───────────────────────────────────────
 *
 * The input is a target list. Ranked by debt, cross-referenced across five
 * protocols, with the collateral asset named and the distance to liquidation
 * computed — published, it is an operational advantage for liquidation bots and a
 * deanonymization aid for anyone who already knows one address in a cluster.
 * `npm run leak-demo` prints exactly what escapes when the aggregation runs
 * outside the enclave. The aggregate is safe; the rows are not; and the aggregate
 * cannot be computed without the rows.
 *
 * ─── The budget, which shaped the query plan ────────────────────────────────
 *
 * 15 HTTP calls per execution and 250 KB per response (`cre workflow limits
 * export`). The app's snapshot uses hundreds of round trips, so the confidential
 * path cannot simply reuse it. Three passes of one call per deployment:
 * bootstrap, discovery, completion. See `lib/signal/enclave-queries.ts` for why
 * the third pass is not optional.
 *
 * ─── Sharing code with the product ──────────────────────────────────────────
 *
 * The normalizer, the cross-protocol join and the aggregation are imported from
 * `lib/`, unchanged and untouched, so the enclave computes the signal with the
 * same code the app and the backtest use. A TEE running its own private
 * reimplementation would prove nothing about the product.
 */

import { bytesToBase64, cre, ok, text, type TeeRuntime } from '@chainlink/cre-sdk'
import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { z } from 'zod'
import { buildPriceIndex, normalizePosition } from '../../lib/exposure/normalize'
import type { Position, RawMarket, RawPosition } from '../../lib/exposure/types'
import { aggregateSignal, type SentinelSignal } from '../../lib/signal/aggregate'
import {
	collectAliasedPositions,
	completeBooksQuery,
	ENCLAVE_BOOTSTRAP_QUERY,
	topPositionsQuery,
} from '../../lib/signal/enclave-queries'
import { parseRiskPolicy, type RiskPolicy } from '../../lib/signal/policy'

// ─── Config: the public half ────────────────────────────────────────────────
// Everything here is revealed, so nothing here may be risk policy. Which
// subgraphs to read and how large a sample to take are architecture, not policy —
// knowing them tells you nothing about where the signal's boundaries sit.

const deploymentSchema = z.object({
	key: z.string().regex(/^[a-z0-9-]+$/, 'deployment key must be a slug, never an address'),
	label: z.string(),
	subgraphId: z.string(),
	schemaVersion: z.string(),
})

export const configSchema = z.object({
	schedule: z.string(),
	/** Gateway base, without the key. The key is a secret and is joined in-enclave. */
	gatewayBaseUrl: z.string(),
	apiKeySecretId: z.string(),
	policySecretId: z.string(),
	deployments: z.array(deploymentSchema).min(1),
	/** Markets pulled per deployment for prices and risk parameters. */
	marketsPerDeployment: z.number().int().positive(),
	/** Deepest markets sampled for positions, aliased into one call. */
	marketsSampled: z.number().int().positive(),
	positionsPerMarket: z.number().int().positive(),
	/** Largest borrowers promoted to a complete-book fetch. The population. */
	candidateAccounts: z.number().int().positive(),
	completeBooksPageSize: z.number().int().positive(),
	maxBlockLag: z.number().int().nonnegative(),
	/** Local ceiling on HTTP calls, to fail with a useful message before the runtime does. */
	httpCallBudget: z.number().int().positive(),
	/**
	 * Enclave logging. False in production: a log line leaves the enclave, so
	 * logging inside one erodes the confidentiality it exists to provide. Even
	 * aggregate logs are off by default rather than trusted to be harmless.
	 */
	logDiagnostics: z.boolean(),
})

export type Config = z.infer<typeof configSchema>
type ConfigDeployment = z.infer<typeof deploymentSchema>

/**
 * Ceiling on sampled debt over protocol-reported debt before a deployment's rows
 * are rejected. A sample cannot exceed the whole, so above 1.0 is already
 * contradictory; the headroom absorbs block skew and oracle differences.
 *
 * Not merely defensive. Aave V2's live subgraph maps Borrow but not Repay, so its
 * `balance` is lifetime cumulative borrowing and overstates outstanding debt by
 * roughly 1925x. Without this gate the enclave would publish that number.
 */
const MAX_DEBT_RECONCILIATION_RATIO = 1.25

/**
 * Running out of HTTP calls, which is fatal rather than a per-deployment note.
 *
 * A distinct class because the per-pass handlers below deliberately absorb
 * deployment failures — one dead subgraph must not take the run down. Budget
 * exhaustion is the opposite: it is a property of the run, not of a deployment,
 * and absorbing it publishes a signal computed over however many deployments
 * happened to fit. A test caught exactly that, reporting a score of 0 over 0
 * borrowers with two reassuring notes. So it is thrown past every catch.
 */
class BudgetExhausted extends Error {}

type BootstrapData = {
	_meta: { block: { number: number; timestamp: number } }
	lendingProtocols: {
		name: string
		schemaVersion: string
		totalBorrowBalanceUSD: string
		totalValueLockedUSD: string
	}[]
	markets: RawMarket[]
}

// ─── The TEE handler ────────────────────────────────────────────────────────

export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
	const config = runtime.config

	// ── Secrets: released by the Vault DON directly into the attested enclave ──
	// Neither value is ever passed to `usingTheDons()`, so neither reaches Workflow
	// DON node memory. The API key is the more obvious secret; the policy is the
	// more interesting one, because it is what makes the published number hard to
	// game rather than merely private.
	const apiKey = runtime.getSecret({ id: config.apiKeySecretId }).result().value
	const policy = parseRiskPolicy(runtime.getSecret({ id: config.policySecretId }).result().value)

	const gql = makeGatewayClient(runtime, apiKey)
	const notes: string[] = []

	// ── Pass 1: protocol totals, sync block, markets ──
	const bootstrap = new Map<string, BootstrapData>()
	for (const d of config.deployments) {
		try {
			bootstrap.set(
				d.key,
				gql<BootstrapData>(d, ENCLAVE_BOOTSTRAP_QUERY, { markets: config.marketsPerDeployment }),
			)
		} catch (err) {
			if (err instanceof BudgetExhausted) throw err
			notes.push(`${d.key} excluded: bootstrap: ${message(err)}`)
		}
	}
	if (bootstrap.size === 0) {
		throw new Error('no deployment answered; Sentinel has no mock mode')
	}

	// Head is the furthest-ahead deployment observable. Anything lagging it by more
	// than the configured margin is describing a different world, so it is dropped
	// before any of the remaining budget is spent on it.
	let head = 0
	for (const b of bootstrap.values()) head = Math.max(head, b._meta.block.number)

	const live: ConfigDeployment[] = []
	const blocks: Record<string, number> = {}
	for (const d of config.deployments) {
		const b = bootstrap.get(d.key)
		if (!b) continue
		const lag = head - b._meta.block.number
		if (lag > config.maxBlockLag) {
			notes.push(`${d.key} excluded: ${lag} blocks behind head ${head}`)
			continue
		}
		blocks[d.key] = b._meta.block.number
		live.push(d)
	}
	if (live.length === 0) throw new Error(`every deployment lags head ${head}`)

	// One price index across every live deployment's markets: an asset missing from
	// one protocol's market list is still priceable from another's.
	const allMarkets: RawMarket[] = []
	for (const d of live) allMarkets.push(...(bootstrap.get(d.key)?.markets ?? []))
	const prices = buildPriceIndex(allMarkets)

	// ── Pass 2: discovery. Largest positions in the deepest markets. ──
	const sampled: Position[] = []
	const discovered: ConfigDeployment[] = []
	for (const d of live) {
		const markets = (bootstrap.get(d.key)?.markets ?? [])
			.filter(
				(m) => Number(m.totalDepositBalanceUSD) > 0 || Number(m.totalBorrowBalanceUSD) > 0,
			)
			.slice(0, config.marketsSampled)
		if (markets.length === 0) {
			notes.push(`${d.key} excluded: no market with a book`)
			continue
		}
		try {
			const data = gql<Record<string, unknown>>(
				d,
				topPositionsQuery(
					d.schemaVersion,
					markets.map((m) => m.id),
					config.positionsPerMarket,
				),
				{},
			)
			for (const raw of collectAliasedPositions<RawPosition>(data)) {
				const p = normalizePosition(raw, d.key, prices)
				if (p) sampled.push(p)
			}
			discovered.push(d)
		} catch (err) {
			if (err instanceof BudgetExhausted) throw err
			notes.push(`${d.key} excluded: discovery: ${message(err)}`)
		}
	}

	// The population: the largest borrowers observable across every deployment.
	// Largest-first is what makes every published share a lower bound — each
	// account the cap excludes carries less debt than each one it keeps.
	const candidates = largestBorrowers(sampled, config.candidateAccounts)
	if (candidates.length === 0) throw new Error('discovery found no priced borrower')

	// ── Pass 3: completion. Complete books for the population, and only these
	// rows reach the aggregation — a truncated book yields a meaningless health
	// factor rather than a pessimistic one.
	const complete: Position[] = []
	const reportedDebtUsd: Record<string, number> = {}
	for (const d of discovered) {
		let rows: RawPosition[]
		try {
			rows = gql<{ positions: RawPosition[] }>(d, completeBooksQuery(d.schemaVersion), {
				accounts: candidates,
				first: config.completeBooksPageSize,
			}).positions
		} catch (err) {
			if (err instanceof BudgetExhausted) throw err
			notes.push(`${d.key} excluded: completion: ${message(err)}`)
			delete blocks[d.key]
			continue
		}

		// There is no budget for a second page, so a full page means the books were
		// silently truncated. Failing here beats publishing a signal computed on
		// partial books; the fix is a smaller `candidateAccounts`, not a retry.
		if (rows.length >= config.completeBooksPageSize) {
			throw new Error(
				`${d.key}: complete-book page filled at ${config.completeBooksPageSize} rows, so books ` +
					'are truncated and health factors would be meaningless; lower candidateAccounts',
			)
		}

		const positions: Position[] = []
		for (const raw of rows) {
			const p = normalizePosition(raw, d.key, prices)
			if (p) positions.push(p)
		}

		// Reconcile position rows against the protocol's own reported totals. This
		// cross-check is free only because the standardized schema exposes both
		// levels in one query shape.
		const reported = Number(bootstrap.get(d.key)?.lendingProtocols[0]?.totalBorrowBalanceUSD ?? 0)
		let sampledDebt = 0
		for (const p of positions) if (p.side === 'BORROWER') sampledDebt += p.valueUsd
		if (reported > 0 && sampledDebt / reported > MAX_DEBT_RECONCILIATION_RATIO) {
			notes.push(
				`${d.key} excluded: sampled debt is ${(sampledDebt / reported).toFixed(1)}x the ` +
					'protocol-reported total, so its position mappings disagree with its own totals',
			)
			delete blocks[d.key]
			continue
		}

		reportedDebtUsd[d.key] = reported
		complete.push(...positions)
	}

	if (Object.keys(blocks).length === 0) {
		throw new Error(`every deployment failed reconciliation: ${notes.join(' | ')}`)
	}

	// ── The aggregation. Per-address rows in, aggregate out. ──
	// `aggregateSignal` runs `assertAggregateOnly` on its own output, so nothing
	// address-shaped can reach the report even if this file changes later.
	const signal = aggregateSignal({ positions: complete, blocks, reportedDebtUsd, policy })

	// A signal over no borrowers is not a low-risk reading, it is a failed run. It
	// would publish a score of 0 — the most reassuring number available — from an
	// absence of data, which is the worst possible way to be wrong.
	if (signal.borrowersObserved === 0) {
		throw new Error(`no borrower survived completion: ${notes.join(' | ')}`)
	}

	// Diagnostics are off in production: a log line leaves the enclave. Even these
	// are aggregate-only, and the guard above has already refused anything
	// address-shaped, but the confidentiality claim should not rest on that.
	if (config.logDiagnostics) {
		runtime.log(
			`enclave: ${signal.borrowersObserved} borrowers, score ` +
				`${signal.systemicRiskScore.toFixed(1)}, ${signal.coupling.length} coupling buckets, ` +
				`${signal.suppressedBuckets.length} suppressed, ${notes.length} deployment notes`,
		)
		for (const n of notes) runtime.log(`enclave: ${n}`)
	}

	// ── Cross back to the DON. Everything past this line is public. ──
	// `usingTheDons()` returns a plain Runtime, so any value handed to it leaves
	// the enclave. Only the aggregate crosses; the positions, the key and the
	// policy stay behind and are discarded when the execution ends.
	const donRuntime = runtime.usingTheDons()
	donRuntime
		.report({
			encodedPayload: bytesToBase64(hexBytes(encodeSignal(signal))),
			encoderName: 'evm',
			signingAlgo: 'ecdsa',
			hashingAlgo: 'keccak256',
		})
		.result()

	return summarize(signal, notes)
}

// ─── The report payload ─────────────────────────────────────────────────────

/**
 * ABI encoding of the published signal.
 *
 * USD figures are scaled to 6 decimals and carried as integers because a
 * consumer contract cannot do arithmetic on a float, and rounding at the
 * boundary is better than rounding in Solidity. Shares and the score are basis
 * points for the same reason.
 *
 * The field list is the signal's public contract; `docs/SIGNAL.md` documents it
 * and Phase 8's consumer decodes it.
 */
export const SIGNAL_ABI_PARAMS =
	'string version, uint64 asOfBlock, uint32 borrowersObserved, uint256 debtUsd6, ' +
	'uint256 multiProtocolDebtUsd6, uint16 multiProtocolShareBps, uint16 leveredShareBps, ' +
	'uint16 worstShockBps, uint256 worstShockDistressedDebtUsd6, uint16 systemicRiskScoreBps, ' +
	'uint16 couplingBuckets, uint16 suppressedBuckets'

export function encodeSignal(signal: SentinelSignal): `0x${string}` {
	const worst = signal.shockLadder[signal.shockLadder.length - 1]
	return encodeAbiParameters(parseAbiParameters(SIGNAL_ABI_PARAMS), [
		signal.version,
		BigInt(asOfBlock(signal)),
		signal.borrowersObserved,
		usd6(signal.debtUsd),
		usd6(signal.multiProtocolDebtUsd),
		bps(signal.multiProtocolShareOfDebt),
		bps(signal.leveredShareOfDebt),
		bps(worst?.shock ?? 0),
		usd6(worst?.distressedDebtUsd ?? 0),
		bps(signal.systemicRiskScore / 100),
		signal.coupling.length,
		signal.suppressedBuckets.length,
	])
}

/**
 * The oldest block any included deployment served.
 *
 * The minimum rather than the maximum: a consumer's staleness check has to be
 * against the least fresh input, or a single lagging deployment would be hidden
 * behind a fresh one.
 */
export function asOfBlock(signal: SentinelSignal): number {
	const numbers = Object.values(signal.blocks)
	return numbers.length === 0 ? 0 : Math.min(...numbers)
}

/** USD to 6 decimals. Guarded, because silently wrapping money is not an option. */
function usd6(usd: number): bigint {
	if (!Number.isFinite(usd) || usd < 0) throw new Error(`usd6: refusing to encode ${usd}`)
	const scaled = Math.round(usd * 1e6)
	if (!Number.isSafeInteger(scaled)) {
		throw new Error(`usd6: ${usd} exceeds exact integer range at 6 decimals`)
	}
	return BigInt(scaled)
}

/** A fraction in [0,1] to basis points, saturating rather than wrapping uint16. */
function bps(fraction: number): number {
	if (!Number.isFinite(fraction) || fraction < 0) throw new Error(`bps: refusing ${fraction}`)
	return Math.min(10_000, Math.round(fraction * 10_000))
}

function hexBytes(hex: `0x${string}`): Uint8Array {
	const body = hex.slice(2)
	const out = new Uint8Array(body.length / 2)
	for (let i = 0; i < out.length; i++) {
		out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
	}
	return out
}

/** The handler's return value. Aggregate only — it is surfaced by the CLI. */
function summarize(signal: SentinelSignal, notes: string[]): string {
	const worst = signal.shockLadder[signal.shockLadder.length - 1]
	return [
		`score ${signal.systemicRiskScore.toFixed(1)}/100`,
		`block ${asOfBlock(signal)}`,
		`${signal.protocols.length} protocols`,
		`${signal.borrowersObserved} borrowers`,
		`${(signal.multiProtocolShareOfDebt * 100).toFixed(2)}% of evaluable debt is multi-protocol`,
		`${(worst ? worst.distressedDebtUsd : 0).toFixed(0)} USD distressed at the deepest shock`,
		`${signal.suppressedBuckets.length} buckets suppressed for k-anonymity`,
		`${notes.length} deployment notes`,
	].join(', ')
}

// ─── The in-enclave gateway client ──────────────────────────────────────────

/**
 * A GraphQL client whose requests never leave the enclave.
 *
 * `HTTPClient.sendRequest` has a `TeeRuntime` overload, so passing the TEE runtime
 * runs the request from inside the enclave and keeps both payloads confidential.
 * `ConfidentialHTTPClient` is deliberately not used: it has no `TeeRuntime`
 * overload and is not meant to be called from a TEE handler.
 *
 * Two rules the closure enforces. The API key is interpolated into the URL, so no
 * error message may ever include the URL — only the deployment key, which is a
 * slug by config schema. And the call budget is counted here rather than trusted,
 * so exceeding it produces a message naming the pass instead of an opaque runtime
 * refusal.
 */
function makeGatewayClient(runtime: TeeRuntime<Config>, apiKey: string) {
	const config = runtime.config
	const http = new cre.capabilities.HTTPClient()
	let calls = 0

	return function gql<T>(
		deployment: ConfigDeployment,
		document: string,
		variables: Record<string, unknown>,
	): T {
		if (++calls > config.httpCallBudget) {
			throw new BudgetExhausted(
				`HTTP call budget of ${config.httpCallBudget} exhausted at ${deployment.key}; ` +
					'reduce deployments or marketsSampled',
			)
		}

		const payload = new TextEncoder().encode(JSON.stringify({ query: document, variables }))
		const response = http
			.sendRequest(runtime, {
				url: `${config.gatewayBaseUrl}/${apiKey}/subgraphs/id/${deployment.subgraphId}`,
				method: 'POST',
				multiHeaders: { 'Content-Type': { values: ['application/json'] } },
				body: bytesToBase64(payload),
			})
			.result()

		if (!ok(response)) {
			throw new Error(`gateway returned HTTP ${response.statusCode} for ${deployment.key}`)
		}

		const body = JSON.parse(text(response)) as {
			data?: T
			errors?: { message: string }[]
		}
		if (body.errors && body.errors.length > 0) {
			throw new Error(
				`GraphQL error for ${deployment.key}: ${body.errors.map((e) => e.message).join('; ')}`,
			)
		}
		if (!body.data) throw new Error(`gateway returned no data for ${deployment.key}`)
		return body.data
	}
}

/**
 * The `n` accounts carrying the most sampled debt.
 *
 * Ranked by debt rather than by position count, because debt is what propagates.
 * Ties break on the address so the population is deterministic — two enclaves
 * observing the same state must nominate the same accounts or consensus over the
 * attested result becomes a coin flip.
 */
export function largestBorrowers(positions: Position[], n: number): string[] {
	const debt = new Map<string, number>()
	for (const p of positions) {
		if (p.side !== 'BORROWER' || p.valueUsd <= 0) continue
		debt.set(p.account, (debt.get(p.account) ?? 0) + p.valueUsd)
	}
	return [...debt]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, n)
		.map(([account]) => account)
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ─── Registration ───────────────────────────────────────────────────────────

export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()

	return [
		// `handlerInTee`, not `handler`: the aggregation itself runs in the enclave.
		// There is no non-TEE path in this workflow — the signal has exactly one
		// producer, and it is this handler.
		cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}

/** Re-exported so the tests can build a policy without reaching into lib/. */
export type { RiskPolicy }
