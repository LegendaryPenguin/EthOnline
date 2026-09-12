---
name: sentinel
description: Ask Sentinel about systemic risk in DeFi lending — cross-protocol leverage, coupling between protocols, collateral shock scenarios, and whether current conditions warrant an alert. Use when a question concerns levered borrowers across multiple lending protocols, contagion or cascade risk, or checking a figure against a raw Messari-schema subgraph. Relays only cited figures and honours refusals.
---

# Sentinel

Sentinel measures how much borrowed value sits with addresses levered across **more than one**
lending protocol on the same collateral. That is the systemic quantity: single-protocol
leverage liquidates once, cross-protocol leverage cascades.

Publishing the per-address map is itself the harm — it is a hunting list for liquidation bots
and a deanonymization aid — so the per-address joins happen inside a TEE and only aggregates
leave it. **This constrains you, not just the server.**

## The one rule

**Never state a number that a tool did not return.**

Every tool answer arrives with a citation table: each figure, its value, the subgraph it came
from, and the block it was read at. When you relay an answer:

- Quote the figures exactly as the tool rendered them. `$5,720,859,090` does not become
  "about $5.7 billion", and `1.25%` does not become "roughly 1%". The rounding is the
  failure mode this whole design exists to prevent, and it is one the server cannot catch on
  your behalf once the text is yours.
- Reproduce or link the citation table. If you are summarising several answers, keep at
  minimum the block number — every figure in one session comes from one pinned block, and
  saying which makes the answer checkable.
- Do not compute derived figures. No ratios, no differences, no annualising, no "which means
  roughly X per protocol". If the user wants a derived quantity, say which tool would have to
  provide it. An arithmetic step you perform is an uncited number no matter how simple.
- Never combine figures from two sessions. Two runs pin different blocks; the difference
  between them is not a measurement.

## Tools

Start with `sentinel_signal` unless the question clearly names something else. Opening a
session costs roughly 28 subgraph reads and is cached for five minutes, so the first call is
the slow one and the rest are nearly free — prefer several specific tools over guessing.

| tool | use it when |
|---|---|
| `sentinel_signal` | "How much leverage is cross-protocol right now?", "what's the risk score?" |
| `sentinel_alert` | "Should anyone be woken up?", "is this bad?" — returns a severity and a reason, or a refusal |
| `sentinel_coupling` | "Which protocols share levered borrowers?", "where's the contagion path?" |
| `sentinel_shock_ladder` | "What if collateral drops 15%?", "how much goes distressed under stress?" |
| `sentinel_compare_protocols` | "Which deployments did you read, at what block, and what does each report?" |
| `sentinel_coverage` | "How much of the real book can you see?", "what are you blind to?" — ask this before making any claim that sounds like a total |
| `sentinel_alert_calibration` | "Where does that threshold come from?", "what's the false-alarm rate?" |
| `sentinel_query_subgraph` | The user wants a raw figure verified against one subgraph, or wants to see the GraphQL |

Composed alongside these is The Graph's own **Subgraph MCP** (`subgraph` in `.mcp.json`): use
it to explore a subgraph's schema, discover deployments by keyword or contract address, check
30-day query volumes, or run GraphQL against a subgraph Sentinel does not have registered. Use
it for verification and discovery. Do **not** use it to reconstruct an aggregate Sentinel
refused — see below.

## Refusals

A refusal is a correct answer. Relay it as one: state the gate, state the number that failed,
and stop.

| gate | means | do not |
|---|---|---|
| `stale` | The reading is too far behind the chain head. | Report the figures anyway with a caveat. |
| `coverage` | The sample covers too little of the reported book. | Present it as a lower bound and continue. |
| `protocols` | Fewer than two deployments answered, so there is no cross-protocol quantity. | Fall back to a single-protocol number. |
| `no-control` | No week-earlier reading, so there is no change to judge. | Compare against the level instead — Phase 6 showed the level is not comparable across months. |
| `per-address` | The request selects per-address entities. | Re-ask, rephrase, split it into smaller queries, or reach for another tool. |
| `out-of-scope` | Sentinel has no read on this. | Answer from your own knowledge as if it were Sentinel's. |

`per-address` deserves emphasis because you are the most likely route around it. If a user
asks who is levered, which wallets are at risk, or for the largest borrowers, the answer is
that Sentinel cannot say and will not — the enclave exists precisely so that answer does not
exist outside it. Do not assemble it from `sentinel_query_subgraph`, do not assemble it from
The Graph's Subgraph MCP, and do not narrow an aggregate query until a single address is
implied. Offer the aggregate that *is* publishable instead.

Coupling results can come back withheld ("no pair clears the anonymity floor"). That is the
`k`-anonymity floor working, not an error and not missing data. Say how many buckets were
withheld and why.

## Answering well

- **Lead with the number and the block.** "At block 25965572, $35,923,817 of observed
  borrowing (1.25%) sits with 5 addresses levered across two or more of 4 deployments read."
- **Every total is a lower bound.** Coverage is partial by construction. Say so once, plainly,
  rather than hedging every sentence.
- **An alert carries its false-alarm rate.** "warn" means a threshold calibrated to fire on
  20% of ordinary hours. Relaying the severity without that rate makes it sound more certain
  than it is; `sentinel_alert_calibration` has the provenance if the user pushes.
- **When the user doubts a figure, verify rather than argue.** `sentinel_query_subgraph`
  against the relevant deployment, or the Subgraph MCP for a fully independent path, and show
  the raw response.

## Background

- `docs/AGENT.md` — the citation invariant, the tools, the Graph product composition
- `docs/evidence/phase7-transcript.md` — 10 questions against live data, 8 answered, 2 refused
- `docs/evidence/phase6-early-warning.md` — the backtest the alert thresholds come from
- `docs/ENCLAVE.md` — why aggregation happens in a TEE and what leaves it
