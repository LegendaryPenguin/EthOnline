# Phase 6 — early warning, measured

Run 2026-09-13T02:33:00.996Z at head block 25965525. `npm run backtest:cascades`.

Labelled from **26194 `Liquidate` events over 362.7 days** across 5 deployments, at a measured 298.4 blocks/hour. 808 gateway calls spent scoring 45 pre-event blocks and 20 quiet windows.

## Headline

The primary test is **paired**: each pre-event block against the same hour of the previous week. The unpaired figures are reported below it because they are the ones that would normally be quoted, and in this study they are the ones that are wrong — see *Why paired*.

| | Sentinel `systemicRiskScore` | baseline: borrow/TVL |
|---|---|---|
| **paired win rate** (episode > own control) | **4/5** = 80% | 2/5 = 40% |
| **paired _p_** (two-sided sign test) | **0.375** | 1.000 |
| same statistic on ordinary hours (the null) | 13/20 = 65% | 9/20 = 45% |
| **paired AUC** (episode rise vs ordinary rise) | **0.690** | 0.470 |
| unpaired AUC (confounded by drift — see below) | 0.270 | 0.190 |
| **episodes detected** (week-on-week change policy) | **0 / 5** | 0 / 5 |
| **median lead time** | **—** | — |
| alert threshold on the change (p90 of ordinary Δ) | 2.39 | 0.00645 |
| episodes detected by an *absolute* threshold | 0 / 5 | 0 / 5 |
| absolute threshold (p90 of ordinary hours) | 31.74 | 0.42488 |
| ordinary-hour median | 30.69 | 0.42094 |
| labelled set | 5 positive / 20 negative | same blocks |

The baseline is not a straw man. Borrow-over-TVL is the strongest statistic obtainable from public protocol totals alone — one HTTP call, no positions, no enclave — so it is the thing the confidential aggregation has to beat to be worth building. Both columns are computed from the same blocks by the same code path; the only difference is which number is read out.

### The alert policy cannot be an absolute threshold, and that is a result

| policy | stated FPR | threshold on Δ | episodes detected | median lead |
|---|---|---|---|---|
| p90 of ordinary Δ | 10% | 2.39 | 0 / 5 | n/a |
| p80 of ordinary Δ | 20% | 0.87 | 3 / 5 | 24h |
| p70 of ordinary Δ | 30% | 0.61 | 3 / 5 | 24h |

Three operating points, reported rather than chosen. With 5 episodes, picking between them by which detects more would be fitting the operating point to the labels, so the whole trade-off is published and a consumer with a cost of a false alarm picks their own row. The first row is the primary result.

The reason the strictest row detects nothing is worth stating precisely, because it is not that the episodes are invisible. The ordinary-hour Δ distribution is **-10.7, -9.9, -1.8, -1.4, -0.7, -0.1, -0.0, 0.0, 0.2, 0.3, 0.3, 0.4, 0.5, 0.5, 0.8, 0.9, 0.9, 2.4, 2.6, 3.5** — seventeen weeks of near-zero movement, and three outliers that set the p90 above every episode's Δ. Those outliers are one structural break, not ordinary noise: between 2026-08-20 and 2026-08-30 the multi-protocol share of sampled debt halves from 1.4% to 0.8% and the score steps down about nine points. That is a real change in cross-protocol leverage — the headline component of the score, doing exactly what it is built to do — and any week-long pair straddling it inherits a ±10 point difference. Excluding those pairs would raise the detection count and would also be deciding, after the fact, which weeks count.

Calibrated once on ordinary hours, the absolute threshold (31.7) detects 0 of 5 episodes. The score ladder shows why and it is not a tuning failure: the threshold is set by July's ~31 while every August and September episode sits at ~21, so any level fixed once is either always on or never on. **The published score's level is not comparable across months; its change is.** So the operating variable is the week-on-week difference, thresholded at the p90 of that difference over ordinary hours — still calibrated on negatives alone, still never consulting an outcome. That is the policy Phase 7's agent enforces, and this is where its number comes from.

With 5 paired episodes the smallest attainable two-sided _p_ is 0.063, so this design cannot produce a significant result at any conventional level and is not presented as one. It is a directional test with its power stated, and the power is bounded by state retention rather than by effort — see *What this cannot measure*.

### Why paired

The first run of this script reported an unpaired AUC and got **0.271 for Sentinel against 0.277 for the baseline**: both far below chance and six thousandths apart. Two measurements do not fail identically by coincidence, and the cause is visible in the score ladder below — the signal is a slowly drifting *level*, around 31 in July and 21 in September, against under one point of movement across an episode's own 24-hour approach. The old negative rule (no liquidation within six hours) admitted only 5 hours out of 8,700, which forced every negative into one stretch of the calendar, so the AUC was measuring the drift between that stretch and the positives.

That rule was also wrong on its own terms: it claimed any liquidation anywhere is abnormal, while 1264 of the 2685 active hours in this window liquidated exactly one account. Individual liquidations are the background state of a lending market. Negatives are now ordinary hours — no episode within 36h, and no episode-grade activity of their own — and every observation is differenced against itself a week earlier, which holds the drift, the weekly cycle and the composition of the book roughly fixed.

## Lead time, per episode

| episode | accounts | protocols | liquidated | score −1h | control (−1w) | Δ | Sentinel lead | baseline lead |
|---|---|---|---|---|---|---|---|---|
| 2026-07-19T10:00Z | 341 | 3 (aave-v2-eth, aave-v3-eth, compound-v2-eth) | $233,254 | 28.9 | 27.2 | +1.73 | **missed** | missed |
| 2026-08-19T11:00Z | 35 | 3 (aave-v2-eth, aave-v3-eth, compound-v3-eth) | $5,281,451 | 30.3 | 31.1 | -0.78 | **missed** | missed |
| 2026-08-30T23:00Z | 6 | 2 (aave-v2-eth, aave-v3-eth) | $805,648 | 21.8 | 20.6 | +1.24 | **missed** | missed |
| 2026-09-02T09:00Z | 4 | 2 (aave-v2-eth, aave-v3-eth) | $160,296 | 21.9 | 20.4 | +1.50 | **missed** | missed |
| 2026-09-04T08:00Z | 9 | 3 (aave-v2-eth, aave-v3-eth, morpho-aave-v2-eth) | $254,066 | 21.8 | 21.2 | +0.54 | **missed** | missed |

The Δ column is the paired test, one row at a time: the score an hour before the cascade minus the score at the same hour of the previous week. A positive Δ is the claim under test, and the sign test in the Headline counts them.

Lead time is the longest offset at which the alert is on **and stays on** through to the event, under the week-on-week change policy. A spike that lapses is not a warning a desk could act on, so it does not count as one. The threshold was fixed from the ordinary windows before any episode was scored, so every figure in this column is out of sample with respect to the labels.

### The score ladder

| episode | −1h | −2h | −3h | −4h | −6h | −8h | −12h | −18h | −24h |
|---|---|---|---|---|---|---|---|---|---|
| 2026-07-19T10:00Z | 28.9 | 28.9 | 28.9 | 28.9 | 28.9 | 28.9 | 28.9 | 29.4 | 29.4 |
| 2026-08-19T11:00Z | 30.3 | 30.4 | 30.4 | 30.3 | 30.5 | 30.6 | 30.6 | 30.8 | 30.8 |
| 2026-08-30T23:00Z | 21.8 | 21.8 | 21.9 | 21.9 | 21.9 | 21.9 | 21.8 | 21.8 | 21.8 |
| 2026-09-02T09:00Z | 21.9 | 21.9 | 21.9 | 21.9 | 21.9 | 21.8 | 21.8 | 21.8 | 21.7 |
| 2026-09-04T08:00Z | 21.8 | 21.7 | 21.9 | 21.8 | 21.8 | 21.9 | 22.0 | 21.9 | 21.9 |

## ROC

| threshold | TPR | FPR | TP | FP |
|---|---|---|---|---|
| 32.24 | 0.00 | 0.05 | 0 | 1 |
| 31.75 | 0.00 | 0.10 | 0 | 2 |
| 31.74 | 0.00 | 0.15 | 0 | 3 |
| 31.65 | 0.00 | 0.20 | 0 | 4 |
| 31.52 | 0.00 | 0.25 | 0 | 5 |
| 31.41 | 0.00 | 0.30 | 0 | 6 |
| 31.35 | 0.00 | 0.35 | 0 | 7 |
| 31.24 | 0.00 | 0.40 | 0 | 8 |
| 31.12 | 0.00 | 0.45 | 0 | 9 |
| 30.92 | 0.00 | 0.50 | 0 | 10 |
| 30.46 | 0.00 | 0.55 | 0 | 11 |
| 30.37 | 0.00 | 0.60 | 0 | 12 |
| 30.34 | 0.20 | 0.60 | 1 | 12 |
| 29.20 | 0.20 | 0.65 | 1 | 13 |
| 28.89 | 0.40 | 0.65 | 2 | 13 |
| 28.03 | 0.40 | 0.70 | 2 | 14 |
| 22.26 | 0.40 | 0.75 | 2 | 15 |
| 21.91 | 0.60 | 0.75 | 3 | 15 |
| 21.83 | 0.60 | 0.80 | 3 | 16 |
| 21.83 | 0.80 | 0.80 | 4 | 16 |
| 21.83 | 0.80 | 0.85 | 4 | 17 |
| 21.76 | 1.00 | 0.85 | 5 | 17 |
| 20.84 | 1.00 | 0.90 | 5 | 18 |
| 20.64 | 1.00 | 0.95 | 5 | 19 |
| 20.34 | 1.00 | 1.00 | 5 | 20 |

AUC is computed by the Mann-Whitney rank identity rather than by integrating this table, so ties are counted as half a win and the figure does not depend on how many rows the sample happens to distinguish. With 5 positives the resolution of this curve is 0.20 in TPR, which is a limit of the label set and not of the method — see below.

## What this cannot measure, and why

**State retention is the binding constraint, and it is a Graph-relevant finding rather than an inconvenience.** Time travel is a property of the indexers serving a subgraph, not of the subgraph, the schema, or the chain. Probed at this head block:

| deployment | events retained | state retained |
|---|---|---|
| `aave-v3-eth` | 11765 rows | ~480448 blocks (~67.1 days) |
| `aave-v2-eth` | 9025 rows | **none** |
| `compound-v3-eth` | 861 rows | ~475390 blocks (~66.4 days) |
| `compound-v2-eth` | 4475 rows | **none** |
| `morpho-aave-v2-eth` | 68 rows | **none** |

So the archive of *what happened* reaches back 362.7 days while the archive of *what the books looked like* reaches back ~67.1 days. Sentinel can therefore **locate crises it cannot replay**, and the largest events in the labelled window are exactly those:

| episode | accounts | protocols | liquidated | replayable |
|---|---|---|---|---|
| 2026-02-04T14:00Z | 2452 | 4 | $224,470,836 | **no — outside state window** |
| 2026-01-30T13:00Z | 2009 | 4 | $209,389,348 | **no — outside state window** |
| 2025-10-10T14:00Z | 683 | 4 | $159,871,599 | **no — outside state window** |
| 2026-06-04T20:00Z | 3057 | 4 | $145,176,716 | **no — outside state window** |
| 2025-11-20T16:00Z | 746 | 5 | $113,507,166 | **no — outside state window** |
| 2025-11-04T14:00Z | 509 | 4 | $106,579,340 | **no — outside state window** |
| 2025-11-16T16:00Z | 128 | 4 | $35,489,166 | **no — outside state window** |
| 2026-02-03T14:00Z | 220 | 4 | $25,594,840 | **no — outside state window** |

92 of 97 detected episodes fall outside the state window, including the largest. Every number in the Headline table is measured on the 5 that do not, and a calm 67 days is a weaker test than a violent year would have been. Publishing the AUC without this section would let a retention limit read as validation.

## Labelling choices, and their sensitivity

An episode is a contiguous run of hourly buckets (gaps up to 2h tolerated, because a cascade arrives in waves as bots clear what is profitable) with at least 4 distinct accounts liquidated across at least 2 protocols, together liquidating at least $100,000.

**Breadth is necessary and it is not sufficient**, and both halves of that were measured rather than assumed. Breadth is necessary because 1264 of the 2685 active hours liquidated exactly one account, the largest of them $3,414,127 — a detector tuned on dollars alone would fire on that and be measuring whale activity. Breadth is insufficient because the first run of this script used breadth alone and admitted 253 "episodes" in a year, down to **$4 across 8 accounts on 2 protocols**: bots sweeping dust, arriving mostly on the two deployments whose indexing the reconciliation gate already rejects. Scoring a systemic-risk signal against those is scoring it against noise.

| rule | episodes in 363 days |
|---|---|
| **this report**: 4+ accounts, 2+ protocols, $100,000+ | **97** |
| 4+ accounts, 2+ protocols, $0+ | 253 |
| 4+ accounts, 2+ protocols, $1,000,000+ | 41 |
| 10+ accounts, 2+ protocols, $100,000+ | 75 |
| 4+ accounts, 3+ protocols, $100,000+ | 75 |

## No lookahead

`lib/backtest/replay-signal.ts` takes a single block and passes it to all three enclave passes; nothing in the scoring path receives a liquidation, a later block, or an outcome. `lib/backtest/__tests__/no-lookahead.test.ts` asserts this against the query documents themselves — every block argument in every pass equals the requested block, and no document mentions a `liquidates` selection. The threshold is calibrated from quiet windows only, so the positives never influence the operating point.

The replay is the enclave's own query plan, block-parameterized, rather than a lookalike written beside it — same three passes, same sampled-debt reconciliation gate, same `aggregateSignal`. A backtest that sampled differently from the product would be measuring a system nobody ships.
