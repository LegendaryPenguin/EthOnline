/**
 * Runs the confidential handler against the live Graph gateway, outside an enclave.
 *
 * Why this exists: `cre workflow simulate` is login-gated, and an unproven workflow
 * is not evidence of anything. This harness stands up the slice of `TeeRuntime` the
 * handler uses and backs `callCapability` with real HTTP against the real gateway, so
 * the query plan, the 15-call budget, the debt reconciliation gate and the aggregation
 * are all exercised on live mainnet state. Every line of `workflow.ts` runs unchanged.
 *
 * What it does NOT prove, and the log says so: there is no enclave here, no Nitro
 * attestation, and no Vault DON. The secrets come from `../.env` and the report is
 * printed rather than signed. Only a simulation or a deployment can show attestation.
 *
 * The handler is synchronous — CRE's programming model is `.result()`, not `await` —
 * so the HTTP has to be synchronous too. `curl` via `Bun.spawnSync` is the honest way
 * to get that. The gateway URL embeds the API key as a path segment, so it is passed
 * to curl through a stdin config file rather than argv, where `ps` would show it.
 *
 *   bun --env-file=../.env local-run.ts [--config config.staging.json]
 */

import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TeeRuntime } from '@chainlink/cre-sdk'
import { type Config, configSchema, onCronTrigger } from './workflow'

const configPath =
	process.argv.includes('--config')
		? process.argv[process.argv.indexOf('--config') + 1]
		: 'config.staging.json'

const config: Config = configSchema.parse(await Bun.file(configPath).json())

const secrets: Record<string, string | undefined> = {
	[config.apiKeySecretId]: process.env[config.apiKeySecretId],
	[config.policySecretId]: process.env[config.policySecretId],
}
for (const [id, value] of Object.entries(secrets)) {
	if (!value) {
		// Fail before the first request rather than after four of them.
		console.error(`missing secret ${id}; set it in cre/.env (see cre/.env.example)`)
		process.exit(1)
	}
}

let calls = 0
const timings: string[] = []

/** One synchronous POST. Returns the raw bytes and the status, and logs neither. */
function post(url: string, body: Uint8Array): { statusCode: number; body: Uint8Array } {
	const bodyFile = join(tmpdir(), `sentinel-req-${process.pid}-${calls}.json`)
	writeFileSync(bodyFile, body)
	try {
		// `--config -` keeps the key-bearing URL out of argv.
		const proc = Bun.spawnSync(['curl', '-sS', '--fail-with-body', '-w', '\n%{http_code}', '--config', '-'], {
			stdin: Buffer.from(
				[
					`url = "${url}"`,
					'request = "POST"',
					'header = "Content-Type: application/json"',
					`data-binary = "@${bodyFile}"`,
				].join('\n'),
			),
		})
		const text = new TextDecoder().decode(proc.stdout)
		const split = text.lastIndexOf('\n')
		const statusCode = Number.parseInt(text.slice(split + 1), 10)
		return {
			statusCode: Number.isFinite(statusCode) ? statusCode : 0,
			body: new TextEncoder().encode(text.slice(0, split)),
		}
	} finally {
		try {
			unlinkSync(bodyFile)
		} catch {
			// A leftover temp file is not worth failing a run over.
		}
	}
}

const runtime = {
	config,
	getSecret: (request: { id: string }) => ({
		result: () => ({ id: request.id, value: secrets[request.id] as string }),
	}),
	callCapability: ({ payload }: { payload: { url: string; body: Uint8Array } }) => {
		const started = Date.now()
		const response = post(payload.url, payload.body)
		// The operation name is the only thing safe to print: the document names
		// market ids, and the response names addresses.
		const op = /query (\w+)/.exec(new TextDecoder().decode(payload.body))?.[1] ?? '?'
		calls += 1
		timings.push(
			`  call ${String(calls).padStart(2)}  ${op.padEnd(21)} HTTP ${response.statusCode}  ` +
				`${String(Date.now() - started).padStart(5)}ms  ${String(response.body.length).padStart(7)} bytes`,
		)
		return { result: () => response }
	},
	log: (line: string) => console.log(`  [enclave] ${line}`),
	usingTheDons: () => ({
		report: (input: { encodedPayload: string }) => {
			console.log('\nreport that would cross the enclave boundary (base64 ABI):')
			console.log(`  ${input.encodedPayload}`)
			return { result: () => ({}) }
		},
	}),
} as unknown as TeeRuntime<Config>

console.log('Sentinel confidential workflow — LOCAL harness, no enclave')
console.log(`run at           ${new Date().toISOString()}`)
console.log(
	`commit           ${Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']).stdout.toString().trim()}`,
)
console.log(`config           ${configPath}`)
console.log(`deployments      ${config.deployments.map((d) => d.key).join(', ')}`)
console.log(`call budget      ${config.httpCallBudget}`)
console.log('attestation      NONE — this is not a TEE; secrets come from ../.env')
console.log('')

const startedAt = Date.now()
let summary: string
try {
	summary = onCronTrigger(runtime)
} catch (error) {
	console.log(timings.join('\n'))
	console.error(`\nFAILED after ${calls} calls: ${error instanceof Error ? error.message : error}`)
	process.exit(1)
}

console.log('\nHTTP calls actually issued:')
console.log(timings.join('\n'))
console.log(`\n  ${calls} of ${config.httpCallBudget} calls, ${Date.now() - startedAt}ms total`)
console.log(`\nhandler return value:\n  ${summary}`)

const leaked = /0x[0-9a-fA-F]{40}/.exec(summary)
if (leaked) {
	console.error(`\nFAIL: the handler's public return value contains an address: ${leaked[0]}`)
	process.exit(1)
}
console.log('\nOK: no address appears in the handler output.')
