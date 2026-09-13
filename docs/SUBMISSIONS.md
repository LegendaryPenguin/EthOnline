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
mainnet data it found **$35,923,754** of such debt, 125 bps of evaluable debt, held by **1,115
addresses borrowing at 2, 3 or 4 protocols at once** out of 37,866 scanned.

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
  than ignoring it: 116 of 359 completed multi-protocol borrowers compute as `HF < 1` while being
  live and un-liquidated, carrying $1.07B. That is our parameters being wrong, not those borrowers
  being unsafe — so every distress figure we publish is a **bound**, not a point estimate.

**Live data only.** No mock mode exists, and a test enforces that: `lib/__tests__/no-mock-data.test.ts`
fails the build if any product path imports a fixture. Every response carries the block it was
served at; deployments more than 1000 blocks behind head are excluded with the reason recorded.

**What we do not claim:** we did not author or extend a standardized subgraph. We consume two.

**Verify it:** `npm run verify` — 18 stages, live, ~4 minutes, every stage green. Evidence map with file and line for every
bullet above: `docs/EVIDENCE.md`.

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

**All four categories of sensitive input, processed inside the enclave**

| Category | What |
|---|---|
| **Secret** | the Graph gateway API key, fetched from the Vault DON inside the enclave |
| **Private parameter** | `SENTINEL_RISK_POLICY` — leverage watch level and composite weights. As sensitive as the key: publish the threshold and a borrower sits one basis point under it. |
| **Confidential API response** | raw `Position` rows — every address, balance and collateral flag — read over an authenticated request made from inside the enclave |
| **Intermediate value** | the per-address cross-protocol leverage map. Computed in the enclave, **never emitted.** |

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
"score 22.0/100, block 25966223, 4 protocols, 90 borrowers, 1.25% of evaluable debt is
 multi-protocol, 2866M USD evaluable of 5717M observed, 1215158822 USD distressed at the
 deepest shock, 3 buckets suppressed for k-anonymity, 1 deployment notes"
```

**Meaningfully integrated, not a placeholder.** Two decisions visible in that one line were both
taken inside the enclave on data the operator cannot see: a reconciliation gate excluded a
deployment on its own evidence, and **k-anonymity suppression withheld 3 coupling buckets** because
fewer than *k* distinct accounts stood behind them — publishing 0 rather than a number that would
identify someone. Suppression that never fires is decoration; this one fires.

And the integration is demonstrable in the negative, which is the strongest form: **`npm run
leak-demo` shows exactly what the enclave refuses to publish and what an attacker gains if the
boundary is removed** (`docs/evidence/leak-demo.md`).

**What leaves the enclave:** 12 aggregate fields, signed, specified in `docs/SIGNAL.md` and verified
on-chain in `contracts/src/SentinelSignal.sol`. `contracts/src/GuardedVault.sol` consumes them and
pauses new borrowing under alert. The dashboard verifies the signer quorum before rendering a single
figure, and `npm run check:ui` proves **zero** 40-hex strings cross the wire on either route.

**One finding worth passing to the CRE team.** With `-g`, the engine logs full outbound request
URLs. The Graph gateway carries the API key as a path segment, so our first raw transcript contained
the live key 28 times. We now redact in-flight and refuse to write the log if any 32-hex token
survives (`scripts/cre-simulate.mts`) — but the default is a footgun for any workflow whose secret
lives in a URL, and it is worth a warning in the CLI.

**What we do not claim:** we have not deployed to the CRE network — `cre whoami` reports
`Deploy Access: Not enabled`. The bullet reads "simulation **or** a live deployment", and the
simulation is done. Details: `docs/CRE-SIMULATION.md`.
