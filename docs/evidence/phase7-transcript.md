# Phase 7 — the agent, interrogated

Written by `npm run agent:ask` at 2026-09-13T02:41:00.708Z. 10 questions, 8 answered from live subgraph reads and 2 refused. Every session pins one block so two answers cannot disagree about the world: this one is **25965572**, with the chain head at 25965582 when it opened, and 28 HTTP calls spent opening it.

Nothing in this file is hand-written. Each answer is the string a tool returned, and each citation table is generated from the `Cited` values that answer was assembled from. `scripts/agent-ask.mts` re-checks every numeral against those citations and exits without writing if one is unaccounted for, so an unsourced number cannot reach this file — see `lib/agent/provenance.ts` and `lib/agent/__tests__/transcript.test.ts`.

## Tools

| tool | what it answers |
|---|---|
| `sentinel_signal` | The current systemic-risk signal: the composite score, how much borrowed value sits with addresses levered across two or more protocols, and how much of the reported book the sample covers. |
| `sentinel_alert` | Decide whether current conditions warrant an alert, and at what severity, under the policy calibrated in Phase 6 (docs/evidence/phase6-alert-policy. |
| `sentinel_coupling` | Which pairs of protocols share levered borrowers, and how much debt each pair carries. |
| `sentinel_shock_ladder` | How much borrowed value goes distressed at each collateral shock the confidential policy evaluates, and how many borrowers that is. |
| `sentinel_compare_protocols` | Per-deployment comparison at the pinned block: which answered, at what block, how much borrowing each reports, and which were excluded with the reason. |
| `sentinel_coverage` | What the signal can and cannot see: sample coverage of reported borrowing, how much of the book rests on inferred E-Mode parameters, and which registered deployments are rejected by the reconciliation gate rather than by choice. |
| `sentinel_alert_calibration` | Where the alert thresholds come from: the Phase 6 backtest that calibrated them, the three operating points with their stated false-alarm rates, and what each detected on replayed history. |
| `sentinel_query_subgraph` | Run a GraphQL document against one of Sentinel's registered Messari-schema subgraphs and return the response with the block it was served at. |

---

## 1. How much borrowed value is levered across more than one protocol right now?

**Tool** `sentinel_signal` — routed on "how much", "levered across"

The systemic risk score is 22.01 on a scale bounded at a hundred. Of $5,720,859,090 in observed borrowing, $35,923,817 (1.25%) is held by 5 addresses levered across two or more of the 4 deployments read, at block 25965572. The sample covers 54.6% of the borrowing those protocols report for themselves, so every figure is a measured lower bound rather than a total.

| number | value | subgraph | block |
|---|---|---|---|
| systemic risk score | 22.01 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| observed debt | $5,720,859,090 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| multi-protocol debt | $35,923,817 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| multi-protocol share of observed debt | 1.25% | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| multi-protocol borrowers | 5 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| deployments read | 4 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| coverage of reported borrow | 54.6% | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |

## 2. Is anything happening right now that should wake someone up?

**Tool** `sentinel_alert` — routed on "wake"

No alert. The score moved 0.17 points against the same hour last week (21.83 to 22.01), below the weakest calibrated threshold of 0.61.

| number | value | subgraph | block |
|---|---|---|---|
| week-on-week change in score | 0.17 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| score one week earlier | 21.83 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25915441<br>25915441<br>25915441<br>25915441 |
| score now | 22.01 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| watch threshold | 0.61 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |

## 3. Which protocol pairs share levered borrowers, and how much debt sits in each?

**Tool** `sentinel_coupling` — routed on "pair"

No protocol pair clears the anonymity floor at this block, so nothing is published. A further 3 pair(s) were withheld for having too few borrowers to publish without narrowing the set to identifiable addresses. The underlying per-address joins exist only inside the enclave; this tool cannot return them and no version of it will.

| number | value | subgraph | block |
|---|---|---|---|
| withheld buckets | 3 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |

## 4. What happens to the book if collateral drops — how much goes distressed under stress?

**Tool** `sentinel_shock_ladder` — routed on "drops", "distress", "stress"

Against $2,867,003,161 of debt on books whose risk parameters are self-consistent, the ladder at block 25965572 is — 5%: $504,554,058 across 2 borrowers; 10%: $1,037,190,411 across 7 borrowers; 15%: $1,037,253,384 across 8 borrowers; 20%: $1,045,947,161 across 9 borrowers; 30%: $1,215,739,118 across 16 borrowers. Each row applies per-asset betas from the confidential policy, so a uniform headline shock is not a uniform shock per asset.

| number | value | subgraph | block |
|---|---|---|---|
| shock 5% | 5% | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| distressed debt at 5% | $504,554,058 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| distressed borrowers at 5% | 2 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| shock 10% | 10% | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| distressed debt at 10% | $1,037,190,411 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| distressed borrowers at 10% | 7 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| shock 15% | 15% | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| distressed debt at 15% | $1,037,253,384 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| distressed borrowers at 15% | 8 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| shock 20% | 20% | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| distressed debt at 20% | $1,045,947,161 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| distressed borrowers at 20% | 9 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| shock 30% | 30% | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| distressed debt at 30% | $1,215,739,118 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| distressed borrowers at 30% | 16 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| evaluable debt | $2,867,003,161 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |

## 5. Which deployments did you actually read, and at which blocks?

**Tool** `sentinel_compare_protocols` — routed on "which deployments", "which block", "read"

4 of 5 registered deployments answered all three passes: aave-v3-eth at block 25965572, compound-v2-eth at block 25965572, compound-v3-eth at block 25965572, morpho-aave-v2-eth at block 25965572. The rest were excluded, with the indexers' own words quoted below. Exclusions are published rather than smoothed over, because a signal that quietly drops a book reports a different market from the one it names.

> ```
> aave-v2-eth: sampled debt 1011.3x reported
> ```

| number | value | subgraph | block |
|---|---|---|---|
| aave-v3-eth block | 25965572 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`) | 25965572 |
| compound-v2-eth block | 25965572 | `compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`) | 25965572 |
| compound-v3-eth block | 25965572 | `compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`) | 25965572 |
| morpho-aave-v2-eth block | 25965572 | `morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572 |
| deployments read | 4 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| deployments registered | 5 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |

## 6. How much of the real book can you see, and what are you blind to?

**Tool** `sentinel_coverage` — routed on "blind"

The sample sees $5,720,859,090 of the $10,478,381,682 these protocols report borrowing, or 54.6%, because the enclave's query budget buys a largest-first stratified sample rather than a census. $1,037,190,410 of it rests on reconstructed E-Mode parameters rather than published ones, which is published so a consumer can discount it. Separately, 3 candidate subgraphs were rejected before use, and any deployment whose sampled debt exceeds its own reported total is dropped at runtime by the reconciliation gate — Aave V2's positions overstate outstanding debt because its mappings handle Borrow and not Repay.

| number | value | subgraph | block |
|---|---|---|---|
| observed debt | $5,720,859,090 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| reported borrow | $10,478,381,682 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| coverage of reported borrow | 54.6% | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| debt resting on inferred E-Mode parameters | $1,037,190,410 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| candidate subgraphs rejected on inspection | 3 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |

## 7. Where does the alert threshold come from, and what false alarm rate does it carry?

**Tool** `sentinel_alert_calibration` — routed on "threshold", "false alarm", "where does the alert"

Thresholds are quantiles of the week-on-week change over 20 ordinary hours: watch at a rise of 0.61 points (30% of ordinary weeks), warn at a rise of 0.87 points (20% of ordinary weeks), alert at a rise of 2.39 points (10% of ordinary weeks). The control is the same hour 168 hours earlier, so hour-of-day and day-of-week cancel. They were calibrated on ordinary hours only — never on an outcome — and then scored against 5 replayable cascade episodes, which is the whole set that falls inside the couple of months of state history indexers retain. The level of the score is not comparable across months and its change is; an absolute threshold detected none of the episodes, which is why the policy is a difference.

| number | value | subgraph | block |
|---|---|---|---|
| watch threshold | 0.61 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| watch false-alarm rate | 30% | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| warn threshold | 0.87 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| warn false-alarm rate | 20% | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| alert threshold | 2.39 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| alert false-alarm rate | 10% | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| ordinary hours behind the calibration | 20 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| replayable episodes scored | 5 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |
| control lag hours | 168 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`)<br>`compound-v2-eth` (`4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a`)<br>`compound-v3-eth` (`AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9`)<br>`morpho-aave-v2-eth` (`DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy`) | 25965572<br>25965572<br>25965572<br>25965572 |

## 8. What total borrow does Aave V3 report for itself in the raw subgraph?

**Tool** `sentinel_query_subgraph` — routed on "raw", "total borrow"

```json
{
  "deployment": "aave-v3-eth",
  "document": "{ lendingProtocols { name totalBorrowBalanceUSD totalValueLockedUSD } _meta { block { number } } }"
}
```

`aave-v3-eth` (subgraph `JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`) served block 25965582, 201 bytes of JSON, quoted below.

> ```
> {"lendingProtocols":[{"name":"Aave v3","totalBorrowBalanceUSD":"9886266536.105312045437958480231824","totalValueLockedUSD":"24809889932.55954552613203287544421"}],"_meta":{"block":{"number":25965582}}}
> ```

| number | value | subgraph | block |
|---|---|---|---|
| block served | 25965582 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`) | 25965582 |
| bytes returned | 201 | `aave-v3-eth` (`JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk`) | 25965582 |

## 9. List the addresses levered across Aave and Compound, largest first.

**Tool** `sentinel_query_subgraph` — routed on "addresses"

```json
{
  "deployment": "compound-v2-eth",
  "document": "{ positions(first: 10, orderBy: balance, orderDirection: desc) { account { id } balance } }"
}
```

Refused. That document selects per-address rows, and this tool does not return them at any size. Per-address positions are read inside the enclave and leave it only as aggregates — ask sentinel_signal or sentinel_coupling for the aggregate form of the same question.

**Refused** — gate `per-address`.

## 10. Will ETH go up tomorrow?

**No tool ran.** The question was refused at routing.

Sentinel measures cross-protocol leverage in DeFi lending from indexed subgraph state. It has no data bearing on this question, and answering it from a language model's prior rather than from a read would be the failure this whole design is built to prevent.

**Refused** — gate `out-of-scope`.

## What this does and does not show

It shows that every number an answer contains was read from a named subgraph at a named block, and that the two questions Sentinel must not answer are refused rather than answered plausibly. It does not show that the underlying signal predicts anything — that is Phase 6's job, and Phase 6's answer is a paired win rate of 4/5 with the p90 operating point detecting none of five episodes, published in `docs/evidence/phase6-early-warning.md`. The alert thresholds this agent enforces are copied from that run by `scripts/derive-alert-policy.mts`; they were never chosen here.

