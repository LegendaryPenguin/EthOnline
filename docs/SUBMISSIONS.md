# Submission drafts

Three drafts, one per prize. Each is written in that sponsor's own vocabulary and answers that
sponsor's own bullets — a judge reading the Chainlink submission should not have to care about
Messari schemas, and a judge reading The Graph submissions should not have to parse TEE attestation.

Paste-ready. Every figure here is live-verified; every claim links to the file that proves it.

---

## Draft 1 — The Graph: Best Use of Composable or Standardized Graph Products

**Project:** Sentinel — a confidential systemic-risk oracle for DeFi lending

**What it does**

Sentinel measures how much borrowed value sits with addresses levered across *multiple* lending
protocols on the *same* collateral — the debt that liquidates twice in one price move. On live
mainnet data it found **$35.9M** of such debt, 125 bps of evaluable debt, held by **1,116
addresses borrowing at 2, 3 or 4 protocols at once** out of 37,862 scanned, at block 25,966,506.

**How it uses standardized and composed Graph products**

Two different Messari standardized schemas, treated as one composed pipeline:

- **Messari Lending/CDP** — Aave V3, Aave V2, Compound V3, Compound V2, Morpho Aave V2
  (`lib/graph/deployments.ts`)
- **Messari DEX AMM** — Uniswap V3, SushiSwap V2, SushiSwap V3, Curve (`lib/graph/dex.ts`)

Nine deployments, two shared schemas, **zero per-protocol adapters**. One query document runs
byte-identically against every lending deployment.

The composition is load-bearing, not decorative: the cascade model needs risk parameters from the
lending schema **and** exit liquidity from the DEX schema, because a liquidation that cannot be sold
into real depth is not a liquidation. 636 live depth queries over 159 asset pairs, deduplicated by
pool — which matters, because Curve's tricrypto pool holds WBTC, WETH and USDC at once and is
returned by three different pair queries; summing without dedupe triple-counted its reserves.

**The standards leverage, concretely**

`Account.id` is `Bytes!` — the raw address — and it is the same key in every protocol's subgraph.
**So the cross-protocol join is a primary-key join, not heuristic address matching.** That is the
only reason this project can exist. Adding a sixth lending protocol means adding a row to a
registry: no adapter, no new query, no mapping code.

**What we found out about the standard, and gave back**

- **Aave V2 is registered on purpose and rejected at runtime on purpose.** Its mappings handle
  `Borrow` but not `Repay`, so `balance` is lifetime cumulative borrowing and its own debt total is
  off by three orders of magnitude. A reconciliation gate catches this **with zero Aave-specific
  code** — a sample is a subset, so sampled debt cannot legitimately exceed protocol-reported debt,
  and that inequality is a free integrity check that works for any protocol. Keeping the row in the
  registry is the evidence the gate does something.
- **Aave V3 E-Mode is absent from the standardized schema,** and we quantified the absence rather
  than ignoring it: 116 of 360 completed multi-protocol borrowers compute as `HF < 1` while being
  live and un-liquidated, carrying $1.07B. That is our parameters being wrong, not those borrowers
  being unsafe — so every distress figure we publish is a **bound**, not a point estimate.

**Live data only.** No mock mode exists, and a test enforces that: `lib/__tests__/no-mock-data.test.ts`
fails the build if any product path imports a fixture. Every response carries the block it was
served at; deployments more than 1000 blocks behind head are excluded with the reason recorded.

**What we do not claim:** we did not author or extend a standardized subgraph. We consume two.

**Verify it:** `npm run verify` — 18 stages, live, ~2 minutes, every stage green. Evidence map with file and line for every
bullet above: `docs/EVIDENCE.md`.

**Your qualification requirements, in order**

| Requirement | Sentinel |
|---|---|
| "Either compose two or more of The Graph's products, or build meaningfully on a standardized schema (for example the Messari Standardized Subgraphs)" | **Both.** Two Messari Standardized Subgraph schemas — Lending/CDP and DEX AMM — composed into one pipeline, nine deployments |
| "Consume live data from a Graph provider… Mocked, local-only, or static datasets do not qualify" | Every figure is a live gateway query. **No mock mode exists**, and `lib/__tests__/no-mock-data.test.ts` fails the build if one appears |
| "Simply querying one Subgraph with no composition or standardization does not qualify" | Nine deployments, two schemas, one query document per schema, zero per-protocol adapters |
| "Authoring or extending a Standardized Subgraph… is in scope" | **Not claimed.** We consume the standard. What we contribute instead is a measurement of two places it breaks down, above |
| "Make the standards leverage clear: show what became easier because a shared schema or composed product was used" | The primary-key cross-protocol join, which is the only reason the project is possible; and a sixth protocol costs one registry row |
| "Submit a public repository and a short demo video (two to four minutes)" | Public repo with per-phase commit history; 3:38 captioned video |

And the description's own bar — *"one query pattern spanning many protocols"* — is exactly what the
first shot of the video shows.

---

## Draft 2 — The Graph: Best AI Tooling or AI Use Case (From Scratch)

**Pool: Start Fresh (net-new).** Begun and built during ETHOnline 2026. Prior-work disclosure,
written unprompted and naming both of the author's earlier repositories: `docs/DISCLOSURE.md`.

**What we built**

Reusable AI infrastructure for querying systemic risk across DeFi lending: **an MCP server exposing
8 tools** (`mcp/sentinel-server.mts`) plus **an agent SKILL** (`.claude/skills/sentinel/SKILL.md`).
Any MCP client can mount it; it is not bound to our dashboard. Every tool answers by querying
Messari standardized subgraphs live through The Graph's gateway.

| Tool | What it answers |
|---|---|
| `sentinel_signal` | the composite score and cross-protocol leverage figures |
| `sentinel_alert` | whether conditions warrant an alert, against the calibrated policy |
| `sentinel_coupling` | which protocols are coupled, by shared borrowers and shared collateral |
| `sentinel_shock_ladder` | the cascade at each shock magnitude |
| `sentinel_compare_protocols` | one protocol against another on the same measures |
| `sentinel_coverage` | what this reading could and could not evaluate |
| `sentinel_query_subgraph` | an escape hatch to check any figure against the raw schema |
| `sentinel_alert_calibration` | how the thresholds were derived, and their hit rate |

**The Graph is load-bearing.** Every tool call hits the gateway; there is no cached or mocked path.
Handshake proof — a real JSON-RPC `initialize` / `tools/list` / `tools/call` exchange, reproducible
with `npm run mcp:handshake`: `docs/evidence/phase7-mcp-handshake.log`.

**The interesting part: the tools constrain the model**

This is the design idea we would most like judged.

- **A session pins one block and answers every question at it.** Not a caching optimisation — a
  correctness property. Two figures from two blocks cannot be compared, and an agent that mixes
  them produces a number that was never true.
- **Every figure arrives with a citation table:** value, source subgraph, block.
- **The SKILL has one rule — never state a number a tool did not return** — and it is spelled out
  to the point of forbidding rounding (`$5,720,859,090` may not become "about $5.7 billion") and
  banning derived arithmetic outright, because an arithmetic step the model performs is an uncited
  number no matter how simple.
- **Refusals that hold.** Ask for the per-address leverage map — the actual thing this project
  computes — and the tools refuse, because publishing it is the harm. **The refusal is in the
  server, not in a prompt, so it survives an adversarial user.**

**Meaningful work, not printed query results.** The signal drives real automation:
`contracts/src/GuardedVault.sol` consumes it on-chain and pauses new borrowing under alert, with
Solidity tests covering staleness, replay and the week-old baseline. And the aggregation itself runs
inside a Chainlink CRE confidential TEE workflow, because the per-address intermediate value cannot
be published safely.

**Run it:** `README.md` and `.claude/skills/sentinel/SKILL.md`; design rationale in `docs/AGENT.md`;
transcript including the refusals in `docs/evidence/phase7-transcript.md`; everything re-verified by
`npm run verify`.

**Your qualification requirements, in order**

| Requirement | Sentinel |
|---|---|
| "Use The Graph as a load-bearing part of the project: either the AI tooling targets The Graph's products… or the agent/app uses The Graph… as its source of blockchain data" | **Both halves.** The tooling targets Standardized Subgraphs, and the app is a **risk monitor** — your own example of a qualifying AI app — with The Graph as its only source of blockchain data |
| "Consume live data from a Graph provider… Mocked, local-only, or static datasets do not qualify" | Every tool call hits the gateway with a Subgraph Studio API key. Proven by the JSON-RPC handshake log, reproducible with `npm run mcp:handshake` |
| "Do meaningful work with the data: reasoning, decisions, automation, or a natural-language interface, not just printing a raw query result" | All four: block-pinned reasoning with citations, an alert decision against a calibrated policy, on-chain automation via `GuardedVault`, and a natural-language interface through the SKILL |
| "Tooling submissions must be reusable infrastructure, not a single end-user app" | An MCP server any MCP client can mount and a SKILL.md any Claude Code user can install. The dashboard is *a* consumer, not the product |
| "Open-source the code with a clear README or SKILL.md so judges can run it" | Both, plus `npm run verify` as one command that re-checks every claim on live data |
| "Select the pool that matches how you built… document any pre-existing work" | **Start Fresh.** Prior work disclosed unprompted in `docs/DISCLOSURE.md`, naming both earlier repositories |

Your description lists the tooling forms that count — *"new or extended MCP servers, agent SKILLs"* —
and this submission is the first two of those, built for the second half of the same sentence.

---

## Draft 3 — Chainlink: Best Confidential Workflow

**The confidential part is not *a* part of this application — it is the application.**

Sentinel measures how much DeFi lending debt is levered across multiple protocols on the same
collateral. Computing that requires a per-address map of who is levered where, and **publishing that
map is itself the harm**: it is a hunting list for liquidation bots and a deanonymization aid for
everyone else. So the aggregation happens somewhere the operator cannot see it, and only the
aggregate is published. Remove the enclave and there is no safe product left.

**The TEE handler**

`cre/sentinel-signal/workflow.ts:534`:

```ts
cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
    { tee: 'nitro', regions: ['us-west-2'] },
])
```

`handlerInTee`, not `handler`. The handler signature is `(runtime: TeeRuntime<Config>) => string` —
**the TEE runtime is the only runtime this workflow has.** There is no non-TEE path; the signal has
exactly one producer.

**Requirement 3 asks for "at least one" of five categories. All five are processed inside the
enclave**, and they are genuinely different kinds of sensitive:

| Your category | What, in Sentinel |
|---|---|
| **secret** | the Graph gateway API key, fetched from the Vault DON inside the enclave (`workflow.ts:157`) |
| **private parameter** | `SENTINEL_RISK_POLICY` — leverage watch level, shock ladder, composite weights, k-anonymity floor. As sensitive as the key: publish the threshold and a borrower sits one basis point under it (`workflow.ts:158`) |
| **sensitive input** | the borrower set itself — which addresses are under evaluation. Knowing who Sentinel is looking at is already a signal |
| **confidential API response** | raw `Position` rows — every address, balance and collateral flag across 37,862 accounts — read over an authenticated request made from inside the enclave (`workflow.ts:438`) |
| **intermediate value** | the per-address cross-protocol leverage map. Computed in the enclave, **never emitted** — this is the value the whole design exists to protect (`lib/signal/aggregate.ts`) |

One implementation note, recorded because it is the kind of thing a judge asks: `ConfidentialHTTPClient`
is deliberately **not** used — it has no `TeeRuntime` overload, whereas `HTTPClient.sendRequest` does,
so the gateway call is made through the TEE runtime instead (`workflow.ts:427`).

Neither secret is ever passed to `usingTheDons()`, so neither reaches Workflow DON node memory.

**Successful execution, with evidence**

`npm run cre:simulate` → **exit 0**. Full transcript: `docs/evidence/cre-simulation.log`. The CLI's
own output confirms the dispatch:

```
Trigger requested TEE Execution your trigger will run in one of the following Tees:
    - AWS Nitro in us-west-2
During real execution, user logs for this trigger will not be visible, and will not leave the TEE.
```

That last line is Chainlink's own tooling stating the property this project is built on. Result:

```
✓ Workflow Simulation Result:
"score 22.0/100, block 25966362, 4 protocols, 90 borrowers, 1.25% of evaluable debt is
 multi-protocol, 2866M USD evaluable of 5717M observed, 1215158822 USD distressed at the
 deepest shock, 3 buckets suppressed for k-anonymity, 1 deployment notes"
```

That is the run in the video, byte for byte — `docs/evidence/casts/cre-simulate.json`, replayed on
screen at 1:31. `docs/evidence/cre-simulation.log` is a later run of the same command at block
25966510; every figure moves with the chain except the ones that are the point (4 protocols, 90
borrowers, 3 buckets suppressed).

**Meaningfully integrated, not a placeholder.** Two decisions visible in that one line were both
taken inside the enclave on data the operator cannot see: a reconciliation gate excluded a
deployment on its own evidence, and **k-anonymity suppression withheld 3 coupling buckets** because
fewer than *k* distinct accounts stood behind them — publishing 0 rather than a number that would
identify someone. Suppression that never fires is decoration; this one fires.

And the integration is demonstrable in the negative, which is the strongest form: **`npm run
leak-demo` shows exactly what the enclave refuses to publish and what an attacker gains if the
boundary is removed** (`docs/evidence/leak-demo.md`).

**Explicit control over what leaves the enclave, for all three of your destinations.** 12 aggregate
fields, signed — specified field by field in `docs/SIGNAL.md`:

- **DON consensus** — the aggregate is what reaches consensus; neither secret is ever passed to
  `usingTheDons()`.
- **External delivery** — the dashboard verifies the signer quorum before rendering a single figure,
  and `npm run check:ui` proves **zero** 40-hex strings cross the wire on either route.
- **Onchain settlement** — verified in `contracts/src/SentinelSignal.sol`; `GuardedVault.sol` pauses
  new borrowing under alert.

**Your qualification requirements, in order**

| Requirement | Sentinel |
|---|---|
| "Build a CRE Workflow that uses the Confidential Workflows to execute a meaningful part of the application" | The confidential part *is* the application — without the enclave there is no publishable product |
| "must register and use a confidential TEE handler, such as `handlerInTee` in TypeScript" | `cre.handlerInTee(...)` at `cre/sentinel-signal/workflow.ts:534`, with `{ tee: 'nitro' }`. No non-TEE path exists |
| "must process at least one sensitive input, secret, confidential API response, private parameter, or intermediate value inside the enclave" | **All five categories**, tabled above |
| "must be meaningfully integrated into the project's core functionality. A placeholder handler or an isolated example… will not qualify" | Two enclave-internal decisions visible in the simulation output: a deployment excluded on its own evidence, and 3 coupling buckets withheld by k-anonymity. `npm run leak-demo` shows what removing the boundary would cost |
| "Demonstrate a successful execution through either: A Confidential Workflow simulation using the CRE CLI or a live deployment" | **CRE CLI simulation, exit 0.** `npm run cre:simulate` |
| "Provide evidence of the successful simulation or deployment… such as a demo video, terminal output, execution logs" | All three: the video's longest section is this simulation, and the full execution log is committed at `docs/evidence/cre-simulation.log` |

Your description says developers *"designate sensitive parts of a CRE Workflow to execute inside a
hardware-isolated Trusted Execution Environment"* — here the sensitive part is the only part, and the
CLI's own output names the enclave it was dispatched to.

**One finding worth passing to the CRE team.** With `-g`, the engine logs full outbound request
URLs. The Graph gateway carries the API key as a path segment, so our first raw transcript contained
the live key 28 times. We now redact in-flight and refuse to write the log if any 32-hex token
survives (`scripts/cre-simulate.mts`) — but the default is a footgun for any workflow whose secret
lives in a URL, and it is worth a warning in the CLI.

**What we do not claim:** we have not deployed to the CRE network — `cre whoami` reports
`Deploy Access: Not enabled`. The bullet reads "simulation **or** a live deployment", and the
simulation is done. Details: `docs/CRE-SIMULATION.md`.
