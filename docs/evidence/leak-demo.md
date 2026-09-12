# Leak demo — the same pipeline, with the enclave removed

Run 2026-09-12T22:36:07.717Z. Addresses truncated for this file.

This is `scripts/leak-demo.mts`, which runs the confidential workflow's own query plan, normalizer and risk policy and then calls `perAddressRowsForLeakDemoOnly` where the enclave calls `aggregateSignal`. That single substitution is the entire diff, and it is the difference between a risk statistic and a target list.

**90 borrowers profiled. 17 of them are levered across more than one protocol, carrying $1,201,315,878 of debt. 29 become distressed within the policy's shock ladder.**

Each row below is individually actionable: the trigger column is the price decline at which the position can be liquidated, and the collateral column is what to sell into. Cross-protocol rows are the novel harm — each protocol's own interface shows only its slice, and that slice can look comfortable while the aggregate does not.

| # | borrower | protocols | debt | collateral | leverage | top collateral | distressed at |
|---|---|---|---|---|---|---|---|
| 1 | `0xf0bb2086…73416c` | 1 (aave-v3-eth) | $1,032,508,256 | $1,125,773,010 | 0.87x | `0xbdfa7b78…275129` | −5% |
| 2 | `0x9600a48e…b22745` | 3 (aave-v3-eth, compound-v3-eth, morpho-aave-v2-eth) | $754,021,035 | $824,056,695 | 0.88x | `0xcd5fe23c…59b7ee` | −5% |
| 3 | `0xf34d97c6…5ca6da` | 1 (aave-v3-eth) | $310,861,813 | $341,650,030 | 1.04x | `0xcd5fe23c…59b7ee` | −5% |
| 4 | `0xcdfa7efe…f49c89` | 1 (aave-v3-eth) | $280,005,677 | $298,624,610 | 0.80x | `0xa1290d69…99e5a7` | −5% |
| 5 | `0x893aa69f…290080` | 1 (aave-v3-eth) | $249,243,797 | $294,673,140 | 0.96x | `0x7f39c581…5e2ca0` | −5% |
| 6 | `0xc468315a…f74ca6` | 1 (aave-v3-eth) | $194,726,995 | $218,101,221 | 1.06x | `0x4c9edd58…1e68b3` | −10% |
| 7 | `0x7cd0b7ed…70c912` | 1 (aave-v3-eth) | $194,545,252 | $416,348,260 | 1.67x | `0xcbb7c000…ed33bf` | — |
| 8 | `0xd9381427…b048dd` | 1 (aave-v3-eth) | $193,548,968 | $211,458,287 | 1.04x | `0x4c9edd58…1e68b3` | −5% |
| 9 | `0xabdbbd00…eef8d6` | 1 (aave-v3-eth) | $176,920,206 | $556,329,044 | 2.45x | `0xcbb7c000…ed33bf` | — |
| 10 | `0x4f87de7d…790545` | 1 (aave-v3-eth) | $176,106,607 | $197,857,220 | 1.07x | `0xcd5fe23c…59b7ee` | −10% |
| 11 | `0xc70ad21c…013810` | 1 (aave-v3-eth) | $141,983,176 | $318,353,364 | 1.86x | `0xc02aaa39…756cc2` | — |
| 12 | `0x741aa7cf…4131f3` | 2 (aave-v3-eth, morpho-aave-v2-eth) | $132,267,260 | $348,693,237 | 2.19x | `0xc02aaa39…756cc2` | — |
| 13 | `0xf7462251…c83010` | 2 (aave-v3-eth, compound-v3-eth) | $131,944,774 | $138,816,544 | 0.79x | `0xa1290d69…99e5a7` | −5% |
| 14 | `0x40e93a52…f7aba8` | 1 (aave-v3-eth) | $130,138,685 | $140,858,074 | 0.81x | `0xa1290d69…99e5a7` | −5% |
| 15 | `0x7ee29373…df5178` | 1 (aave-v3-eth) | $112,612,600 | $510,021,613 | 3.65x | `0x7f39c581…5e2ca0` | — |
| 16 | `0x99926ab8…70f242` | 1 (aave-v3-eth) | $112,555,003 | $244,722,443 | 1.79x | `0xc02aaa39…756cc2` | — |
| 17 | `0x28a55c4b…38a6b0` | 1 (aave-v3-eth) | $108,220,024 | $289,632,251 | 2.22x | `0xc02aaa39…756cc2` | — |
| 18 | `0xe40d278a…ef03bf` | 1 (aave-v3-eth) | $95,757,432 | $195,365,624 | 1.64x | `0xcbb7c000…ed33bf` | — |
| 19 | `0x32073633…8b7910` | 1 (aave-v3-eth) | $91,073,739 | $101,426,130 | 1.06x | `0x356b8d89…d5ba7d` | −10% |
| 20 | `0xd848f542…7af452` | 1 (aave-v3-eth) | $88,280,613 | $262,517,997 | 2.41x | `0x7f39c581…5e2ca0` | — |
| 21 | `0x755013a7…654e60` | 1 (aave-v3-eth) | $78,310,763 | $85,026,472 | 0.81x | `0xa1290d69…99e5a7` | −5% |
| 22 | `0x973ddb8e…951683` | 1 (aave-v3-eth) | $74,888,467 | $77,319,493 | 0.77x | `0xa1290d69…99e5a7` | −5% |
| 23 | `0x0a42b2f3…9fc02c` | 1 (aave-v3-eth) | $71,248,616 | $116,435,420 | 1.31x | `0xcd5fe23c…59b7ee` | −30% |
| 24 | `0xda43cce1…dd41bd` | 1 (aave-v3-eth) | $70,647,844 | $79,111,198 | 1.06x | `0x4c9edd58…1e68b3` | −10% |
| 25 | `0x34780c20…69ddcf` | 1 (aave-v3-eth) | $69,389,202 | $239,983,675 | 2.87x | `0xc02aaa39…756cc2` | — |

_65 further rows omitted from this file; the script prints all of them._

## What the enclave publishes instead

`docs/evidence/enclave-local-run.log` is the same data through `aggregateSignal`: a single systemic risk score, a multi-protocol share of debt, a shock ladder of aggregate distressed value, and coupling buckets suppressed below the policy's k-anonymity floor. No row above survives that boundary — `assertAggregateOnly` walks the output and throws on anything address-shaped, checking object keys as well as string values.

The point is not that the aggregate is safer because we chose to publish less. It is that the aggregate is the answer to the question, and the table is not.
