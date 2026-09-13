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
import { asOfBlock, encodeSignal, SIGNAL_ABI_PARAMS } from '../../lib/signal/report'

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
	/**
	 * Largest borrowers each deployment nominates before the union is capped. Without
	 * this, the largest protocol supplies every candidate and cross-protocol coupling
	 * becomes unobservable by construction.
	 */
	candidatesPerDeployment: z.number().int().positive(),
	/** Cap on the nominated union promoted to a complete-book fetch. The population. */
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
	const sampledBy = new Map<string, Position[]>()
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
			const positions: Position[] = []
			for (const raw of collectAliasedPositions<RawPosition>(data)) {
				const p = normalizePosition(raw, d.key, prices)
				if (p) positions.push(p)
			}

			// Reconcile here, before nomination, not just before aggregation. A
			// subgraph that overstates debt does not merely contribute a wrong number
			// — it outbids every honest deployment for candidate slots, because
			// nomination ranks by debt. Measured live: Aave V2's top sampled positions
			// come to $14.1B against its own reported $14.0M, so it took nearly all 40
			// slots and was then discarded in pass 3, leaving a population drawn from
			// one protocol and a multi-protocol share of exactly zero. A gate that
			// runs too late is indistinguishable from no gate at all.
			const ratio = debtRatio(positions, bootstrap.get(d.key))
			if (ratio !== undefined && ratio > MAX_DEBT_RECONCILIATION_RATIO) {
				notes.push(
					`${d.key} excluded at discovery: sampled debt is ${ratio.toFixed(1)}x the ` +
						'protocol-reported total, so its position mappings disagree with its own totals',
				)
				delete blocks[d.key]
				continue
			}

			sampled.push(...positions)
			sampledBy.set(d.key, positions)
			discovered.push(d)
		} catch (err) {
			if (err instanceof BudgetExhausted) throw err
			notes.push(`${d.key} excluded: discovery: ${message(err)}`)
		}
	}

	// ── The population ──
	// Each deployment nominates its own largest borrowers first, and only then is
	// the union ranked and capped. Ranking the pooled sample directly looks more
	// principled and is wrong for this signal: Aave V3 carries $6.0B of the $6.4B
	// sampled, so a pooled top-40 is forty Aave V3 whales, and a population that
	// only one protocol can reach reports a multi-protocol share of 0.00% no matter
	// what the world is doing. Measured: pooled nomination gave 0.00%, per-protocol
	// nomination is what surfaces the coupling Phase 2 found by brute force.
	//
	// The cap is still largest-first, so every published share remains a lower
	// bound — each account the cap drops carries less sampled debt than each one it
	// keeps.
	const nominated = new Set<string>()
	for (const d of discovered) {
		for (const a of largestBorrowers(sampledBy.get(d.key) ?? [], config.candidatesPerDeployment)) {
			nominated.add(a)
		}
	}
	const candidates = largestBorrowers(
		sampled.filter((p) => nominated.has(p.account)),
		config.candidateAccounts,
	)
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

		// Reconciled a second time, on the complete books rather than the discovery
		// sample. The discovery gate protects the candidate population; this one
		// protects the published number. A subgraph can pass the first and fail the
		// second, because the complete books include markets discovery never sampled.
		const ratio = debtRatio(positions, bootstrap.get(d.key))
		if (ratio !== undefined && ratio > MAX_DEBT_RECONCILIATION_RATIO) {
			notes.push(
				`${d.key} excluded: sampled debt is ${ratio.toFixed(1)}x the ` +
					'protocol-reported total, so its position mappings disagree with its own totals',
			)
			delete blocks[d.key]
			continue
		}

		reportedDebtUsd[d.key] = Number(
			bootstrap.get(d.key)?.lendingProtocols[0]?.totalBorrowBalanceUSD ?? 0,
		)
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
// Encoding lives in `lib/signal/report.ts`, not here, so that a consumer can decode
// a Sentinel report without installing the CRE toolchain — and so that the encoder
// and the decoder can never disagree about the field list. A disagreeing ABI decoder
// does not error; it returns plausible numbers in the wrong fields.

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
		// Evaluable, not observed: books whose health factor contradicts the chain are
		// excluded from every component, so the share has to say what it is a share of
		// or it reads as a share of everything.
		`${(signal.multiProtocolShareOfDebt * 100).toFixed(2)}% of evaluable debt is multi-protocol`,
		`${(signal.evaluableDebtUsd / 1e6).toFixed(0)}M USD evaluable of ${(signal.debtUsd / 1e6).toFixed(0)}M observed`,
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

/**
 * Sampled borrowed value as a multiple of the protocol's own reported total.
 *
 * A sample can only ever be a fraction of the whole, so a ratio above 1 means the
 * position rows and the protocol entity disagree — the rows are describing something
 * other than current debt. This cross-check costs nothing extra only because the
 * standardized schema exposes both levels in the same query shape, which is the whole
 * argument for standardization: the consistency check is a schema property.
 *
 * `undefined` when there is no reported total to compare against; an absent
 * denominator is not evidence of a problem.
 */
function debtRatio(positions: Position[], bootstrap: BootstrapData | undefined): number | undefined {
	const reported = Number(bootstrap?.lendingProtocols[0]?.totalBorrowBalanceUSD ?? 0)
	if (!(reported > 0)) return undefined
	let sampledDebt = 0
	for (const p of positions) if (p.side === 'BORROWER') sampledDebt += p.valueUsd
	return sampledDebt / reported
}

// ─── Registration ───────────────────────────────────────────────────────────

export function initWorkflow(config: Config) {
	const cronTrigger = new cre.capabilities.CronCapability()

	return [
		// `handlerInTee`, not `handler`: the aggregation itself runs in the enclave.
		// There is no non-TEE path in this workflow, and the signal has exactly one
		// producer, and it is this handler.
		cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
			{ tee: 'nitro', regions: ['us-west-2'] },
		]),
	]
}

/** Re-exported so the tests can build a policy without reaching into lib/. */
export type { RiskPolicy }

/**
 * Re-exported so the workflow's own tests and `docs/SIGNAL.md` have one import site
 * for the wire format, and so a grep for the ABI from inside `cre/` finds it.
 */
export { asOfBlock, encodeSignal, SIGNAL_ABI_PARAMS }
