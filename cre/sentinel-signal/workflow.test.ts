/**
 * Tests for the confidential workflow, with no network and no enclave.
 *
 * What these can prove: that the handler spends its call budget the way the query
 * plan says, that it fails loudly on the conditions that would otherwise publish a
 * wrong number, and — the one that matters most — that nothing confidential
 * crosses back to the DON. That last property is the entire privacy claim, and it
 * is checked against the actual report bytes rather than by reading the code.
 *
 * What these cannot prove: that a real Nitro enclave attests correctly. Only
 * `cre workflow simulate` and a deployment can show that.
 *
 * The public test surface ships no TEE runtime factory (`newTestRuntime` returns a
 * DON `Runtime`), so the slice of `TeeRuntime` the handler actually uses is stood
 * up here: config, getSecret, callCapability, log, usingTheDons.
 */

import { describe, expect } from 'bun:test'
import type { TeeRuntime } from '@chainlink/cre-sdk'
import { test } from '@chainlink/cre-sdk/test'
import { asOfBlock, type Config, initWorkflow, largestBorrowers, onCronTrigger } from './workflow'

const API_KEY = 'test-graph-key'
const POLICY = JSON.stringify({
	shocks: [0.1, 0.3],
	assetBeta: { '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 1 },
	defaultBeta: 1,
	kAnonymity: 2,
	weights: { concentration: 0.5, leverage: 0.2, distress: 0.3 },
	leverageWatchLevel: 1.5,
	// Empty on purpose: these tests assert on the query plan and the published body,
	// and a lifted threshold underneath them would change those numbers for a reason
	// unrelated to what each test is about.
	emode: { threshold: 0.95, groups: [] },
})

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const WHALE = '0x1111111111111111111111111111111111111111'
const WHALE2 = '0x2222222222222222222222222222222222222222'
const SMALL = '0x3333333333333333333333333333333333333333'

const makeConfig = (patch: Partial<Config> = {}): Config => ({
	schedule: '0 */5 * * * *',
	gatewayBaseUrl: 'https://gateway.example/api',
	apiKeySecretId: 'GRAPH_API_KEY',
	policySecretId: 'SENTINEL_RISK_POLICY',
	deployments: [
		{ key: 'aave-v3-eth', label: 'Aave V3', subgraphId: 'AAA', schemaVersion: '3.1.0' },
		{ key: 'compound-v3-eth', label: 'Compound V3', subgraphId: 'CCC', schemaVersion: '3.1.0' },
	],
	marketsPerDeployment: 10,
	marketsSampled: 2,
	positionsPerMarket: 10,
	candidatesPerDeployment: 10,
	candidateAccounts: 10,
	completeBooksPageSize: 100,
	maxBlockLag: 1000,
	httpCallBudget: 15,
	logDiagnostics: true,
	...patch,
})

// ─── Canned gateway responses ───────────────────────────────────────────────

const market = (asset: string, price: string, lt: string, tvl: string) => ({
	id: `mkt-${asset}`,
	name: `market ${asset}`,
	isActive: true,
	canUseAsCollateral: true,
	canBorrowFrom: true,
	maximumLTV: '75',
	liquidationThreshold: lt,
	liquidationPenalty: '5',
	inputTokenPriceUSD: price,
	totalValueLockedUSD: tvl,
	totalBorrowBalanceUSD: tvl,
	totalDepositBalanceUSD: tvl,
	inputToken: { id: asset, symbol: asset === WETH ? 'WETH' : 'USDC', decimals: 18 },
})

const position = (
	id: string,
	account: string,
	side: 'COLLATERAL' | 'BORROWER',
	asset: string,
	whole: number,
) => ({
	id,
	side,
	isCollateral: side === 'COLLATERAL',
	balance: `${whole}${'0'.repeat(18)}`,
	account: { id: account },
	asset: { id: asset, symbol: asset === WETH ? 'WETH' : 'USDC', decimals: 18 },
	market: {
		id: `mkt-${asset}`,
		liquidationThreshold: asset === WETH ? '80' : '85',
		maximumLTV: '75',
		inputTokenPriceUSD: asset === WETH ? '1' : '1',
		inputToken: { id: asset, symbol: asset === WETH ? 'WETH' : 'USDC', decimals: 18 },
	},
})

const bootstrap = (block: number, reportedDebt = '10000') => ({
	data: {
		_meta: { block: { number: block, timestamp: 1_700_000_000 } },
		lendingProtocols: [
			{
				name: 'Test',
				schemaVersion: '3.1.0',
				totalBorrowBalanceUSD: reportedDebt,
				totalValueLockedUSD: '100000',
			},
		],
		markets: [market(WETH, '1', '80', '5000'), market(USDC, '1', '85', '4000')],
	},
})

/** 170 collateral against 100 debt: solvent, distressed only at the 30% shock. */
const books = (accounts: string[], collateral: number, debt: number, tag: string) => {
	const rows: unknown[] = []
	for (const a of accounts) {
		rows.push(position(`${tag}-c-${a}`, a, 'COLLATERAL', WETH, collateral))
		rows.push(position(`${tag}-d-${a}`, a, 'BORROWER', USDC, debt))
	}
	return rows
}

const discovery = (rows: unknown[]) => ({ data: { _meta: { block: { number: 100 } }, m0: rows } })
const completion = (rows: unknown[]) => ({
	data: { _meta: { block: { number: 100 } }, positions: rows },
})

// ─── The fake TEE runtime ───────────────────────────────────────────────────

type Responder = (op: string, deployment: string, body: string) => unknown | undefined

const defaultResponder: Responder = (op, deployment) => {
	if (op === 'EnclaveBootstrap') return bootstrap(100)
	const shared = books([WHALE, WHALE2], 170, 100, deployment)
	// Only Aave sees the small single-protocol borrower, so it is not multi-protocol.
	const rows = deployment === 'aave-v3-eth' ? [...shared, ...books([SMALL], 400, 50, 'a')] : shared
	return op === 'EnclaveTopPositions' ? discovery(rows) : completion(rows)
}

function makeFakeTeeRuntime(
	config: Config = makeConfig(),
	responder: Responder = defaultResponder,
	statusCode = 200,
) {
	const requests: { url: string; op: string; body: string }[] = []
	const reports: { encodedPayload: string }[] = []
	const logs: string[] = []
	const crossed: unknown[] = []

	const runtime = {
		config,
		getSecret: (request: { id?: string }) => ({
			result: () => ({
				id: request.id,
				value: request.id === config.policySecretId ? POLICY : API_KEY,
			}),
		}),
		// `sendRequest` decodes the base64 body before handing the payload to
		// `callCapability`, so what arrives here is bytes, not the string we passed.
		callCapability: ({ payload }: { payload: { url: string; body: Uint8Array } }) => {
			const body = new TextDecoder().decode(payload.body)
			const op = /query (\w+)/.exec(body)?.[1] ?? '?'
			const deployment =
				config.deployments.find((d) => payload.url.endsWith(d.subgraphId))?.key ?? '?'
			requests.push({ url: payload.url, op, body })
			const json = responder(op, deployment, body) ?? { data: null }
			return {
				result: () => ({ statusCode, body: new TextEncoder().encode(JSON.stringify(json)) }),
			}
		},
		log: (message: string) => logs.push(message),
		usingTheDons: () => ({
			report: (input: { encodedPayload: string }) => {
				crossed.push(input)
				reports.push(input)
				return { result: () => ({}) }
			},
		}),
	}

	return {
		runtime: runtime as unknown as TeeRuntime<Config>,
		requests,
		reports,
		logs,
		crossed,
	}
}

// ─── The confidentiality boundary ───────────────────────────────────────────

describe('the enclave boundary', () => {
	test('crosses back exactly one report and nothing else', () => {
		// Every value handed to `usingTheDons()` leaves the enclave. One report, and
		// no side channel, is the whole contract.
		const { runtime, crossed } = makeFakeTeeRuntime()
		onCronTrigger(runtime)
		expect(crossed).toHaveLength(1)
	})

	test('the report bytes contain no address', () => {
		// The report is ABI-encoded aggregates, so an address could only get in via a
		// string field. Checked against the bytes rather than against intent.
		const { runtime, reports } = makeFakeTeeRuntime()
		onCronTrigger(runtime)
		const decoded = atob(reports[0].encodedPayload)
		for (const address of [WHALE, WHALE2, SMALL, WETH, USDC]) {
			expect(decoded).not.toContain(address.slice(2))
		}
	})

	test('neither secret is logged, and neither is the raw gateway response', () => {
		const { runtime, logs } = makeFakeTeeRuntime()
		onCronTrigger(runtime)
		expect(logs.length).toBeGreaterThan(0)
		for (const line of logs) {
			expect(line).not.toContain(API_KEY)
			expect(line).not.toContain('shocks')
			expect(line).not.toContain(WHALE)
		}
	})

	test('logging is off in production, because a log line leaves the enclave', () => {
		const { runtime, logs } = makeFakeTeeRuntime(makeConfig({ logDiagnostics: false }))
		onCronTrigger(runtime)
		expect(logs).toEqual([])
	})

	test('the handler return value names no address either', () => {
		// It reaches the CLI and the simulation log, so it is published output.
		const { runtime } = makeFakeTeeRuntime()
		const summary = onCronTrigger(runtime)
		expect(summary).not.toMatch(/0x[0-9a-fA-F]{40}/)
		expect(summary).toContain('score')
	})

	test('the API key travels only inside the enclave-issued request', () => {
		// It has to be in the URL — the gateway puts the key in the path — and that
		// URL is the confidential request payload of an in-enclave HTTP call. What
		// must not happen is it appearing anywhere that crosses back.
		const { runtime, requests, reports, logs } = makeFakeTeeRuntime()
		onCronTrigger(runtime)
		expect(requests[0].url).toContain(API_KEY)
		expect(JSON.stringify(reports)).not.toContain(API_KEY)
		expect(JSON.stringify(logs)).not.toContain(API_KEY)
	})
})

// ─── The query plan ─────────────────────────────────────────────────────────

describe('the query plan', () => {
	test('spends three calls per deployment, in the documented order', () => {
		const { runtime, requests } = makeFakeTeeRuntime()
		onCronTrigger(runtime)
		expect(requests.map((r) => r.op)).toEqual([
			'EnclaveBootstrap',
			'EnclaveBootstrap',
			'EnclaveTopPositions',
			'EnclaveTopPositions',
			'EnclaveCompleteBooks',
			'EnclaveCompleteBooks',
		])
		expect(requests.length).toBeLessThanOrEqual(makeConfig().httpCallBudget)
	})

	test('nominates candidates from discovery and asks for their complete books', () => {
		// Discovery only nominates. If the completion pass ever stopped filtering to
		// the nominated accounts, the budget would blow up silently.
		const { runtime, requests } = makeFakeTeeRuntime()
		onCronTrigger(runtime)
		const completion = requests.filter((r) => r.op === 'EnclaveCompleteBooks')
		for (const r of completion) {
			expect(r.body).toContain(WHALE)
			expect(r.body).toContain('account_in')
		}
	})

	test('lets every protocol nominate, so the largest one cannot own the population', () => {
		// The bug this pins, found on live data: nomination ranked the pooled sample,
		// Aave V3 carried $6.0B of the $6.4B sampled, and so all 40 candidates were
		// Aave V3 whales. A population only one protocol can reach reports a
		// multi-protocol share of 0.00% regardless of what the world is doing —
		// the signal was structurally unable to observe its own subject.
		const lopsided: Responder = (op, deployment) => {
			if (op === 'EnclaveBootstrap') return bootstrap(100, '10000000')
			// Aave's borrowers are 100x larger, so a pooled top-2 is both of them.
			const rows =
				deployment === 'aave-v3-eth'
					? books([WHALE, WHALE2], 17_000, 10_000, 'a')
					: books([SMALL], 400, 50, 'c')
			return op === 'EnclaveTopPositions' ? discovery(rows) : completion(rows)
		}
		const { runtime, requests } = makeFakeTeeRuntime(
			makeConfig({ candidatesPerDeployment: 1, candidateAccounts: 2 }),
			lopsided,
		)
		onCronTrigger(runtime)
		const asked = requests.find((r) => r.op === 'EnclaveCompleteBooks')?.body ?? ''
		expect(asked).toContain(WHALE)
		expect(asked).toContain(SMALL)
	})

	test('refuses to publish when a complete-book page fills', () => {
		// A full page means truncated books, and a health factor from a truncated
		// book is meaningless rather than pessimistic. Failing beats publishing.
		const { runtime } = makeFakeTeeRuntime(makeConfig({ completeBooksPageSize: 2 }))
		expect(() => onCronTrigger(runtime)).toThrow(/truncated/)
	})

	test('stops at the call budget with a message naming where it ran out', () => {
		const { runtime } = makeFakeTeeRuntime(makeConfig({ httpCallBudget: 3 }))
		expect(() => onCronTrigger(runtime)).toThrow(/budget of 3 exhausted at/)
	})
})

// ─── Failing loudly ─────────────────────────────────────────────────────────

describe('refusing to publish a wrong number', () => {
	test('excludes a deployment lagging head, rather than mixing two worlds', () => {
		const stale: Responder = (op, deployment) =>
			op === 'EnclaveBootstrap' && deployment === 'compound-v3-eth'
				? bootstrap(50)
				: defaultResponder(op, deployment, '')
		const { runtime, requests } = makeFakeTeeRuntime(
			makeConfig({ maxBlockLag: 10 }),
			stale,
		)
		onCronTrigger(runtime)
		// Excluded before any of the remaining budget is spent on it.
		expect(requests.filter((r) => r.url.endsWith('CCC'))).toHaveLength(1)
	})

	test('excludes a deployment whose sampled debt exceeds its own reported total', () => {
		// This is Aave V2 in real life: its subgraph maps Borrow but not Repay, so
		// `balance` is lifetime cumulative borrowing. Without the gate the enclave
		// would publish a number 1900x too large.
		const overstated: Responder = (op, deployment) =>
			op === 'EnclaveBootstrap'
				? bootstrap(100, deployment === 'compound-v3-eth' ? '1' : '10000')
				: defaultResponder(op, deployment, '')
		const { runtime, reports } = makeFakeTeeRuntime(makeConfig(), overstated)
		onCronTrigger(runtime)
		// Still publishes, on the one deployment that reconciles.
		expect(reports).toHaveLength(1)
	})

	test('an overstating subgraph is excluded before it can bid for candidate slots', () => {
		// The gate used to run only in pass 3, which turned out to be too late to
		// matter: Aave V2's phantom $14.1B outbid every honest deployment during
		// nomination, so the excluded deployment still decided who the population
		// was. A gate that runs after the decision it should inform is not a gate.
		const overstated: Responder = (op, deployment) => {
			// Compound reports $1 of debt but its positions carry far more.
			if (op === 'EnclaveBootstrap')
				return bootstrap(100, deployment === 'compound-v3-eth' ? '1' : '10000')
			const rows =
				deployment === 'compound-v3-eth'
					? books([WHALE2], 170_000, 100_000, 'c')
					: books([WHALE], 170, 100, 'a')
			return op === 'EnclaveTopPositions' ? discovery(rows) : completion(rows)
		}
		const { runtime, requests } = makeFakeTeeRuntime(
			makeConfig({ candidatesPerDeployment: 1, candidateAccounts: 1 }),
			overstated,
		)
		onCronTrigger(runtime)
		// One completion call only — the excluded deployment is not asked — and the
		// single candidate slot went to the honest deployment's borrower.
		const completions = requests.filter((r) => r.op === 'EnclaveCompleteBooks')
		expect(completions).toHaveLength(1)
		expect(completions[0].body).toContain(WHALE)
		expect(completions[0].body).not.toContain(WHALE2)
	})

	test('throws rather than publishing when every deployment fails', () => {
		const { runtime } = makeFakeTeeRuntime(makeConfig(), () => undefined)
		expect(() => onCronTrigger(runtime)).toThrow()
	})

	test('throws on a malformed risk policy instead of falling back to defaults', () => {
		// A defaulted policy would publish a signal under weights nobody chose.
		const { runtime } = makeFakeTeeRuntime()
		const broken = {
			...(runtime as unknown as { config: Config }),
			getSecret: () => ({ result: () => ({ value: '{"shocks":[]}' }) }),
		}
		const patched = Object.assign(Object.create(Object.getPrototypeOf(runtime)), runtime, broken)
		expect(() => onCronTrigger(patched as TeeRuntime<Config>)).toThrow(/risk policy/)
	})

	test('throws on a non-2xx gateway response and never reports', () => {
		const { runtime, reports } = makeFakeTeeRuntime(makeConfig(), defaultResponder, 500)
		expect(() => onCronTrigger(runtime)).toThrow()
		expect(reports).toHaveLength(0)
	})
})

// ─── Registration and helpers ───────────────────────────────────────────────

describe('initWorkflow', () => {
	test('registers the aggregation itself in a Nitro enclave', () => {
		// Exactly one handler, and it is the aggregation — there is no non-TEE path
		// that could quietly become the real producer.
		const handlers = initWorkflow(makeConfig())
		expect(handlers).toHaveLength(1)
		expect(handlers[0].fn).toBe(onCronTrigger)
		expect(handlers[0].requirements).toBeDefined()
	})
})

describe('largestBorrowers', () => {
	test('ranks by debt and breaks ties deterministically', () => {
		// Two enclaves observing the same state must nominate the same accounts, or
		// consensus over the attested result becomes a coin flip.
		const rows = [
			{ account: '0xb', side: 'BORROWER', valueUsd: 100 },
			{ account: '0xa', side: 'BORROWER', valueUsd: 100 },
			{ account: '0xc', side: 'BORROWER', valueUsd: 500 },
			{ account: '0xd', side: 'COLLATERAL', valueUsd: 900 },
		] as never
		expect(largestBorrowers(rows, 3)).toEqual(['0xc', '0xa', '0xb'])
	})
})

describe('asOfBlock', () => {
	test('reports the least fresh input, not the freshest', () => {
		// A consumer's staleness check has to see the lagging deployment.
		expect(asOfBlock({ blocks: { a: 100, b: 90 } } as never)).toBe(90)
	})
})
