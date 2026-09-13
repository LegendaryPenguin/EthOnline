# Evidence

Every qualification bullet from all three tracks, mapped to the file, line and artifact that
satisfies it. The bullets are quoted verbatim in `docs/TRACKS.md`; this document answers them.

Reproduce the whole thing with one command:

```sh
cp .env.example .env.local   # then fill in GRAPH_API_KEY and SENTINEL_RISK_POLICY
npm install
npm run verify               # 18 stages, live, ~2 minutes
```

`npm run preflight` alone tells you whether your setup can produce real numbers, before
anything else runs.

**Last full run — 18 stages, all green:**

```
  total 251.7s across 18 stages
  cold-start flow (preflight → snapshot → cascade → shock:ladder → cre:test
                   → fixture:report → consume-signal → build): 62.5s
```

**The cold-start flow has been observed between 53.6s and 62.5s, so it straddles our own 60-second
target and misses it on some runs.** We are recording the miss rather than requoting the faster run,
because a target you only report when you clear it is not a target.

The reason is a single stage and it is not ours to fix: `cascade` makes 636 live DEX-depth queries
and has been observed between **40.6s and 57.2s**. That stage is gateway-bound, not client-bound —
measured at concurrency 10 (46.5s) and 40 (45.4s), zero failures either way — so widening the client
buys ~1s and risks rate limits. Everything else in the flow put together, including five protocols
queried and joined, the enclave run, the signed report, an independent consumer and the production
build, is about 15 seconds. The honest claim is therefore *"about a minute from an API key to a
rendered dashboard, dominated by one gateway-bound stage"*, not *"under 60 seconds"*.

The full run is now ~4 minutes rather than ~90s because `cre:simulate` alone takes **148.4s** —
compiling the workflow to WASM and running it through Chainlink's simulator. It is not part of the
cold-start flow, and it skips cleanly with a printed reason on any machine without CRE credentials.

**Where the numbers in this document come from.** Live queries on 2026-09-13 against five
Messari Lending/CDP deployments and four Messari DEX AMM deployments at mainnet block
~25,965,980. Sentinel has no mock mode; `lib/__tests__/no-mock-data.test.ts` enforces that.

---

# Track 1 — The Graph: Best Use of Composable or Standardized Graph Products

### 1. "Either compose two or more of The Graph's products, or build meaningfully on a standardized schema (for example the Messari Standardized Subgraphs)."

**Both, and the second is the load-bearing one.** Sentinel builds on *two different* Messari
standardized schemas and treats them as one composed pipeline:

| Schema | Deployments | Registry |
|---|---|---|
| Messari **Lending/CDP** (`schema-lending.graphql`) | Aave V3, Aave V2, Compound V3, Compound V2, Morpho Aave V2 | `lib/graph/deployments.ts:25` |
| Messari **DEX AMM** | Uniswap V3, SushiSwap V2, SushiSwap V3, Curve | `lib/graph/dex.ts:35` |

Nine deployments, two shared schemas, zero per-protocol adapters. The composition is not
decorative: the cascade model needs risk parameters from the lending schema *and* exit
liquidity from the DEX schema, because a liquidation that cannot be sold into real depth is
not a liquidation. `lib/cascade/impact.ts` is where the two schemas meet.

### 2. "Consume live data from a Graph provider… Mocked, local-only, or static datasets do not qualify."

- Gateway client: `lib/graph/client.ts` — one chokepoint, `requireApiKey()` at
  `lib/graph/client.ts:38`, and **no mock path at all**. The module doc-comment states the two
  rules it exists to enforce.
- Enforced by test, not by intention: `lib/__tests__/no-mock-data.test.ts` fails the build if
  any `lib/` product path imports a fixture, if any bare 32-hex key appears in source, or if any
  module reads `GRAPH_API_KEY` outside that one chokepoint. **That test caught a real violation
  during Phase 10** — `scripts/preflight.mts` was reading the environment directly.
- Every response carries the block it was served at (`QueryResult.block`,
  `lib/graph/client.ts:49`) and every snapshot records provenance.
- Sync state is treated as data, not assumed: deployments more than `MAX_BLOCK_LAG` = 1000
  blocks behind head are excluded **with the reason recorded** (`lib/graph/client.ts:18`).
- Artifact: `docs/evidence/phase1-multiprotocol-query.md`.

### 3. "Simply querying one Subgraph with no composition or standardization does not qualify."

Nine deployments across two schemas, and a single query *document* executed byte-identically
against each. See `lib/graph/queries.ts:1` — the doc-comment states the rule ("If a change here
would need a per-*protocol* variant, that is a signal the standardized schema is not carrying
the weight, so resist it") **and names the one concession honestly**: `positionsQuery` varies by
*schema version*, not by protocol, because `Position.asset` arrived in 3.x and Compound V2 is
live on 2.0.1 today. Five protocols, one query shape, keyed on a version string the subgraph
itself reports.

### 4. "Authoring or extending a Standardized Subgraph, or contributing a reusable composable Substreams module, is in scope."

Not claimed. We consume the standard rather than extend it, which bullets 1 and 3 already
satisfy. Saying so explicitly is more useful to a judge than a stretched claim.

What we *do* contribute back is a measurement of where the standard breaks down, in
`docs/verification/health-reconciliation.md` and `docs/evidence/emode-groups.md`:

- **Aave V2's deployment is registered on purpose and rejected at runtime on purpose**
  (`lib/graph/deployments.ts:44`). Its mappings handle `Borrow` but not `Repay`, so `balance` is
  lifetime cumulative borrowing and overstates outstanding debt by **three orders of magnitude**.
  The multiple is sample-dependent and we quote both readings rather than the bigger one: **1925×**
  on the snapshot in `docs/evidence/phase2-cross-protocol.md`, **1011×** in the CRE simulation
  (`docs/evidence/cre-simulation.log`). What is invariant is the inequality the gate actually keys
  on — a sample is a subset, so sampled debt cannot legitimately exceed protocol-reported debt.
  The reconciliation gate in `lib/graph/snapshot.ts:172` catches this **without a single line of
  Aave-specific code** and records the reason in provenance. Keeping that row in the registry is
  the evidence that the gate does something.
- **Aave V3 E-Mode is absent from the standardized schema**, and that absence is quantified
  rather than ignored: 116 of 359 completed multi-protocol borrowers compute as `HF < 1` while
  being live and un-liquidated, carrying **$1,074,472,124**. That is our parameters being wrong,
  not those borrowers being unsafe. `lib/cascade/emode.ts` therefore reports a **bound**, not a
  point estimate, and the UI prints the upper bound next to every distress figure.

### 5. "Make the standards leverage clear: show what became easier because a shared schema or composed product was used."

The whole product is the answer, and it is specific:

> `Account.id` is `Bytes!` — the raw address — and it is **the same key in every protocol's
> subgraph**. So the cross-protocol join is a primary-key join, not heuristic address matching.

That is the only reason this project exists. Measured on live data (`npm run snapshot`):

| | |
|---|---|
| accounts scanned | 37,866 |
| borrowing at exactly 1 protocol | 36,751 |
| **at 2 protocols** | **1,041** |
| **at 3** | **72** |
| **at 4** | **2** |
| debt levered across >1 protocol on the same collateral | **$35,923,754** (125 bps of evaluable debt) |

Adding a sixth lending protocol to Sentinel means **adding a row to
`lib/graph/deployments.ts`** — no adapter, no new query, no mapping code. The registry
doc-comment says exactly that, and Aave V2's presence-and-rejection proves the claim is load-
bearing rather than aspirational.

The composition across the two schemas is what makes the cascade honest: 636 live DEX-depth
queries over 159 asset pairs across 4 AMM deployments, deduplicated by `dex:poolId` — which
matters more than it sounds, because Curve's tricrypto pool holds WBTC, WETH and USDC at once
and is returned by three different pair queries. Summing without dedupe triple-counted its
reserves (`lib/graph/dex.ts:203`).

### 6. "Submit a public repository and a short demo video (two to four minutes)."

Public repo, granular commit history (one commit per phase with the reasoning in the message).
Video: see the Video section below.

**Evidence documents for this track:** `docs/evidence/phase1-multiprotocol-query.md`,
`docs/evidence/phase2-cross-protocol.md`, `docs/evidence/phase4-cascade.md`,
`docs/verification/health-reconciliation.md`, `docs/evidence/emode-groups.md`.

---

# Track 2 — The Graph: Best AI Tooling or AI Use Case (From Scratch)

### Pool: **Start Fresh (net-new).** Begun and built during the hackathon.

Prior-work disclosure is in `docs/DISCLOSURE.md` and repeated in the submission.

### 1. "Use The Graph as a load-bearing part of the project."

Both halves of the bullet, but the tooling half is the submission: **Sentinel ships a
reusable MCP server** (`mcp/sentinel-server.mts`) exposing **8 tools**, plus an agent SKILL
(`.claude/skills/sentinel/SKILL.md`) — and every tool answers by querying Messari standardized
subgraphs live.

| Tool | What it answers |
|---|---|
| `sentinel_signal` | the composite score and the cross-protocol leverage figures |
| `sentinel_alert` | whether current conditions warrant an alert, against the calibrated policy |
| `sentinel_coupling` | which protocols are coupled, by shared borrowers and shared collateral |
| `sentinel_shock_ladder` | the cascade at each shock magnitude |
| `sentinel_compare_protocols` | one protocol against another on the same measures |
| `sentinel_coverage` | what this reading could and could not evaluate |
| `sentinel_query_subgraph` | an escape hatch to check any figure against the raw schema |
| `sentinel_alert_calibration` | how the alert thresholds were derived, and their hit rate |

Definitions: `lib/agent/tools.ts:74` onward. Handshake proof:
`docs/evidence/phase7-mcp-handshake.log` — a real JSON-RPC `initialize` / `tools/list` /
`tools/call` exchange, reproducible with `npm run mcp:handshake`.

### 2. "Consume live data from a Graph provider… Mocked, local-only, or static datasets do not qualify."

Every tool call hits the gateway. From the handshake log:

```
## [sentinel] MCP server ready: 8 tools, 5 deployments
## [sentinel] head 25965980, pinning 25965970
## [sentinel] signal at 25965970: score 22.00, 4 deployment(s), 14 calls
```

**A session pins one block and answers every question at it** (`lib/agent/context.ts`). That is
not a caching optimisation, it is a correctness property: two figures from two blocks cannot be
compared, and an agent that mixes them produces a number that was never true.

### 3. "Do meaningful work with the data: reasoning, decisions, automation, or a natural-language interface, not just printing a raw query result. Tooling submissions must be reusable infrastructure, not a single end-user app."

**Reusable infrastructure:** an MCP server any MCP client can mount, and a SKILL.md any Claude
Code user can install. Not bound to our dashboard.

**Meaningful work, and the interesting part — the tools constrain the model:**

- **Every figure arrives with a citation table**: value, the subgraph it came from, the block it
  was read at (`lib/agent/provenance.ts`).
- **The SKILL has one rule — "never state a number that a tool did not return"** — and it is
  spelled out to the point of forbidding rounding: `$5,720,859,090` may not become "about $5.7
  billion", and derived arithmetic is banned outright, because "an arithmetic step you perform
  is an uncited number no matter how simple"
  (`.claude/skills/sentinel/SKILL.md:18`).
- **Refusals that hold.** Ask for the per-address leverage map — the actual thing this project
  computes — and the tools refuse, because publishing it is the harm. The refusal is in the
  server, not in a prompt, so it survives an adversarial user.
- Transcript, including the refusals: `docs/evidence/phase7-transcript.md`. Design:
  `docs/AGENT.md`.

**Automation, end to end.** The track lists *"risk monitors"* among the AI apps that qualify, and
that is precisely the category Sentinel is in — but the risk monitor here is not advisory. `contracts/src/GuardedVault.sol`
consumes the signal on-chain and pauses new borrowing under alert — 13 Solidity tests covering
staleness, replay, and the week-old baseline (`npm run forge:test`).

### 4. "Open-source the code with a clear README or SKILL.md so judges can run it."

`README.md`, `.claude/skills/sentinel/SKILL.md`, `docs/AGENT.md`, and `npm run verify` as a
single command that re-verifies every claim on live data.

### 5. "Select the pool that matches how you built… document any pre-existing work."

Start Fresh. `docs/DISCLOSURE.md`.

**Evidence documents for this track:** `docs/evidence/phase7-transcript.md`,
`docs/evidence/phase7-mcp-handshake.log`, `docs/AGENT.md`.

---

# Track 3 — Chainlink: Best Confidential Workflow

### 1. "Build a CRE Workflow that uses the Confidential Workflows to execute a meaningful part of the application."

`cre/sentinel-signal/workflow.ts`. The confidential part is not *a* part of the application —
it is the application. Sentinel's entire reason to exist is that the per-address cross-protocol
leverage map cannot be published, so the aggregation has to happen somewhere the operator
cannot see it.

### 2. "The workflow must register and use a confidential TEE handler, such as `handlerInTee` in TypeScript."

`cre/sentinel-signal/workflow.ts:534`:

```ts
// `handlerInTee`, not `handler`: the aggregation itself runs in the enclave.
// There is no non-TEE path in this workflow — the signal has exactly one
// producer, and it is this handler.
cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
    { tee: 'nitro', regions: ['us-west-2'] },
])
```

The handler signature is `(runtime: TeeRuntime<Config>) => string`
(`cre/sentinel-signal/workflow.ts:149`) — the TEE runtime is the only runtime this workflow has.

### 3. "The confidential portion must process at least one sensitive input, secret, confidential API response, private parameter, or intermediate value inside the enclave."

The bullet asks for **at least one** of five. All five are, which is worth spelling out because they
are genuinely different kinds of sensitive:

| Category | What | Where |
|---|---|---|
| **Secret** | the Graph gateway API key, fetched from the Vault DON *inside* the enclave | `workflow.ts:157` |
| **Private parameter** | `SENTINEL_RISK_POLICY` — the leverage watch level and composite weights. As sensitive as the key: publish the threshold and a borrower sits one basis point under it. | `workflow.ts:158` |
| **Sensitive input** | the borrower set under evaluation. Which addresses Sentinel is looking at is already a signal, before any figure is computed from them. | `workflow.ts:438` |
| **Confidential API response** | raw `Position` rows — every address, balance and collateral flag for 37,866 accounts — read over an authenticated gateway request made from inside the enclave | `workflow.ts:438` |
| **Intermediate value** | the per-address cross-protocol leverage map itself. Computed in the enclave, **never emitted.** | `lib/signal/aggregate.ts` |

The doc-comment at `workflow.ts:152` states the property that makes this real: *"Neither value
is ever passed to `usingTheDons()`, so neither reaches Workflow DON node memory."*

One implementation note recorded because it is the kind of thing a judge asks about:
`ConfidentialHTTPClient` is deliberately **not** used — it has no `TeeRuntime` overload, whereas
`HTTPClient.sendRequest` does, so the gateway call is made through the TEE runtime instead
(`workflow.ts:427`).

### 4. "The Confidential Workflow must be meaningfully integrated into the project's core functionality. A placeholder handler or an isolated example will not qualify."

Two of Chainlink's own listed example use cases describe this project:

> - Automated liquidation protection using private risk thresholds and execution strategies
> - Privacy-preserving risk assessment and policy enforcement

And the integration is demonstrable in the negative, which is the strongest form: **`npm run
leak-demo` shows exactly what the enclave refuses to publish and what an attacker gains if the
boundary is removed** (`docs/evidence/leak-demo.md`). k-anonymity suppression is enforced on the
output — the recorded report suppresses **3 of its coupling buckets** because fewer than `k`
distinct accounts stood behind them, and publishes 0 rather than a number that would identify
someone. Suppression that never fires is decoration; this one fires.

The track description says developers *"explicitly control what stays confidential and what leaves
the enclave for DON consensus, external delivery, or onchain settlement."* Sentinel exercises all
three destinations, which is why the boundary had to be specified field by field rather than
gestured at: the aggregate reaches **DON consensus**; the dashboard is **external delivery**; and
`SentinelSignal.sol` is **onchain settlement**. Each is a separate place a leak could happen, so
each is tested separately.

The signal that leaves the enclave is 12 aggregate fields, specified in `docs/SIGNAL.md` and
verified on-chain in `contracts/src/SentinelSignal.sol`. The dashboard verifies the signer
quorum before rendering a single figure, and `npm run check:ui` proves **zero** 40-hex strings
cross the wire on either route — checked against the 359-account sample, 139 of which are
multi-protocol borrowers. The enclave boundary and the UI boundary are tested separately
because they are separate claims.

### 5–6. "Demonstrate a successful execution… Provide evidence of the successful simulation or deployment."

| Evidence | What it shows |
|---|---|
| **`docs/evidence/cre-simulation.log`** | **the CRE CLI simulation, exit 0** — `npm run cre:simulate`. The CLI's own output confirms the dispatch: *"Trigger requested TEE Execution … AWS Nitro in us-west-2"*, and *"During real execution, user logs for this trigger will not be visible, and will not leave the TEE."* That second line is Chainlink's tooling independently corroborating the design claim this whole project rests on. Result: score 22.0 at block 25966223, 4 protocols, 90 borrowers, **3 buckets suppressed for k-anonymity**. Walked bullet by bullet in `docs/CRE-SIMULATION.md`. |
| `docs/evidence/enclave-local-run.log` | a full local enclave run: secrets, queries, aggregation, signing |
| `npm run cre:test` | the workflow's own test suite: aggregation, k-anonymity suppression, signing |
| `npm run cre:typecheck` | compiles against the real CRE SDK |
| `contracts/test/fixtures/report.json` | the signed report, consumed and verified by `npm run consume-signal` and by 24 Solidity tests |
| `docs/ENCLAVE.md` | the confidentiality argument: what crosses the boundary and why each field is safe |

**On deployment, as distinct from simulation.** The bullet reads "simulation **or** a live
deployment", and the simulation is done. A live deployment additionally needs deploy access —
`cre whoami` reports `Deploy Access: Not enabled`, requestable via `cre account access`. We are not
claiming a deployment.

**One thing worth flagging to anyone reproducing this.** With `-g`, the CRE engine logs full
outbound request URLs, and the Graph gateway carries the API key as a path segment — our first raw
transcript contained the live key 28 times. `npm run cre:simulate` therefore redacts in-flight and
**refuses to write the file at all** if any 32-hex token survives, rather than trusting a human to
remember. Details in `docs/CRE-SIMULATION.md`; the reasoning is in
`scripts/cre-simulate.mts:1`.

---

# The claims we do *not* make

A judge's time is better spent on what is real, so:

- **We did not author or extend a standardized subgraph.** We consume two of them.
- **`sampleCoverageOfReported` is 13.97%, not 62.66%.** The cascade model runs on the completed
  cross-protocol snapshot — $1.46B of borrowed value against $10.478B reported. 62.66% is
  `multiProtocolDebtShareOfSample`, a different quantity. Conflating the two would inflate the
  project by 4.5×, so the dashboard states the difference in prose. (This was a real bug caught
  in Phase 9; see `docs/evidence/phase9-ui.md`.)
- **`systemicRiskScoreBps` = 2201 is a composite whose *level* is not comparable across
  months** — only its change is. Both the UI caption and `docs/SIGNAL.md` say so.
- **Distress figures are bounds, not point estimates**, because Aave V3 E-Mode is not in the
  standardized schema. Every distress number on the dashboard shows its upper bound.
- **The backtest publishes its misses.** `docs/BACKTEST.md` and
  `docs/evidence/phase6-early-warning.md` report lead time on the episodes the signal caught
  *and* the ones it did not.
- **Only 2 of 5 deployments support historical time-travel queries**, so the backtest replays 96
  of 319 liquidation episodes. Stated in the output, not buried.

---

# Video

2:00–4:00, 1080p, captioned. Raw material in `docs/evidence/screens/` (ten screenshots, both
themes, regenerated by `npm run capture:ui`). Script: `docs/VIDEO.md`.

Shows, in order: the headline finding; one query document spanning five protocols; the TEE
simulation logs; the backtest result with lead time; the cascade animation driven by the shock
slider; and `GuardedVault` reacting to the signal on-chain.
