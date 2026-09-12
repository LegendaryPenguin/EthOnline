# Phase 4 — the cascade model

Every number here is produced by `npm run cascade` against live subgraph data at
the blocks recorded in `data/cascade.json`. Nothing is hand-entered. Re-running
regenerates all of it, and the script aborts rather than printing if any of its
invariants fail.

```
npm run cascade
```

Captured at lending block **25964481** (Morpho at 25964480) and DEX blocks
25964523–25964524, `2026-09-12T23:08:54Z`. 2,402 positions, 17 collateral assets
covering 99.73% of value, 636 DEX queries across 4 deployments, 0 failures.

## What the model is for

A single lending protocol can see its own borrowers and can price its own
collateral. What it cannot see is that the asset securing its loans is *also*
securing loans on three other protocols, and that all four will liquidate into
the same pools at the same time. That is the exposure this phase measures.

The mechanism needs no shared borrower at all. Two protocols with no addresses in
common still crash each other if they are secured by the same asset — which is
why `coupling.ts` measures shared collateral separately from shared borrowers, and
why the cross-protocol account overlap from Phase 2 is a different finding rather
than the same one restated.

## The two standardized schemas, and the exact fields taken from each

| | Messari Lending/CDP | Messari DEX AMM |
|---|---|---|
| deployments | 4 (`lib/graph/deployments.ts`) | 4 (`lib/graph/dex.ts`) |
| live schema versions | 3.1.0, 3.0.1, 2.0.1 | 4.0.0, 1.3.2, 1.3.0 |
| fields consumed | `Position.balance`, `Position.side`, `Position.isCollateral`, `Market.liquidationThreshold`, `Market.liquidationPenalty`, `Market.inputTokenPriceUSD`, `Market.outputToken`, `Market.exchangeRate`, `Market.totalValueLockedUSD`, `MarketDailySnapshot.inputTokenPriceUSD` | `LiquidityPool.inputTokenBalances`, `LiquidityPool.inputTokens{id,symbol,decimals}`, `LiquidityPool.isSingleSided` |
| deliberately **not** consumed | — | every USD field, including `totalValueLockedUSD` |

The one asymmetry in that table is the most important thing Phase 4 learned, and
it is documented at length in the header of `lib/graph/dex.ts`. Ordering mainnet
Uniswap V3 pools by the DEX schema's `totalValueLockedUSD` returns a **$94 billion
"Wrapped Ether/Yescoin" pool**. The figure is not real. So Sentinel reads no USD
value from the DEX schema at all: it takes raw `inputTokenBalances` and prices them
with the *lending* schema's oracles, which are the prices that actually decide
liquidations.

That choice deletes the fake-pool problem as a category rather than filtering
known offenders. Yescoin is not collateral on any lending protocol, so it has no
oracle price, so its pool cannot be priced, so it never enters. Two gates enforce
it: every token in a pool must be priced by a lending oracle, and the pool's
reserve-implied price must sit within 10x of that oracle
(`MAX_IMPLIED_PRICE_DEVIATION`).

At this block those gates rejected 6 pools for unpriced tokens, 117 for dust and
**105 for an implied price outside the band** — the largest of which would have
contributed **$43,615,693,765,552,084,000,000** of apparent depth. Forty-three
sextillion dollars is not a number that needs a judgement call, but $321,876 of
rejected WETH depth and $281,346 of cbBTC in the same sweep is: the gate is doing
routine work, not just catching one absurdity.

## Factor exposures, measured rather than assumed

Shocking each collateral asset independently would be wrong by roughly fourfold,
because **87.74% of cross-protocol collateral loads on ETH** ($1,966,388,595 of
$2,241,079,753), and 11.38% on BTC. Betas come from a two-factor OLS regression of
daily log returns on WETH and WBTC, using `MarketDailySnapshot.inputTokenPriceUSD`
— the protocol's own oracle, so the correlations measured are between the exact
numbers that trigger liquidations.

| asset | collateral | DEX depth | collateral/depth | βETH | βBTC | R² | obs |
|---|---|---|---|---|---|---|---|
| weETH | $885,766,129 | $16,364,910 | **54.1x** | 0.94 | 0.07 | 0.95 | 364 |
| WETH | $458,094,231 | $213,386,838 | 2.1x | 1.00 | 0.00 | 1.00 | 364 |
| wstETH | $402,484,101 | $3,811,784 | **105.6x** | 0.98 | 0.03 | 0.99 | 364 |
| WBTC | $233,495,046 | $89,443,404 | 2.6x | 0.00 | 1.00 | 1.00 | 364 |
| rsETH | $194,888,334 | **$0** | no depth | 0.57 | 0.24 | 0.51 | 250 |
| cbBTC | $13,902,874 | $7,068,798 | 2.0x | -0.00 | 1.00 | 0.98 | 364 |
| aEthweETH | $7,925,017 | **$0** | no depth | 0.94 | 0.07 | 0.95 | 364 |
| cbETH | $5,423,784 | $168,007 | 32.3x | 0.98 | -0.12 | 0.71 | 312 |
| USDC | $4,399,822 | $176,503,651 | 0.0x | -0.00 | 0.00 | 0.01 | 364 |
| XAUt | $4,281,632 | $2,806,869 | 1.5x | 0.05 | 0.17 | 0.11 | 362 |
| LINK | $3,914,527 | $10,245,000 | 0.4x | 0.81 | 0.30 | 0.79 | 364 |
| aEthWETH | $2,436,345 | $98,989 | 24.6x | 1.00 | 0.00 | 1.00 | 364 |

Three rows are worth reading closely.

USDC regresses to a beta of zero on both factors at an R² of 0.01 — a stablecoin
correctly identified as one without ever being labelled. XAUt is why the
regression exists at all: an earlier version of this model classified assets by
price band, and tokenised gold trading at 1.73x the ETH price fell inside a
`[0.85, 1.75]` window and was shocked as an ETH derivative. Both rejected designs
are documented in the header of `lib/cascade/factors.ts`, including the one that
would have been more satisfying to ship — corroborating correlation from DEX pool
composition, which measurement showed carries almost no information, because on
Ethereum LINK is 94.3% and AAVE 97.2% paired with WETH by depth. Everything trades
against WETH.

**aEthweETH and aEthWETH are new rows, and they were a bug.** An aToken is never a
`Market.inputToken`, so it appears in no price index and has no
`MarketDailySnapshot` series — it came out `unmeasured`, and `shockForAsset` holds
unmeasured assets at ratio 1, meaning *no shock at all*. $10.4M of
ETH-denominated collateral was being modelled as shock-proof. `resolveReceiptBetas`
now gives a receipt token the beta of the asset it is a receipt for, which is not
an assumption: `normalizePosition` already *prices* it at the underlying's oracle
price times the market's exchange rate, so its return series is the underlying's.
The same hole priced those positions at $0 in the simulator while they carried a
real `valueUsd`, and that disagreement liquidated $25,177 **at a zero percent
shock** until the zero-shock invariant refused to publish. See
`lib/exposure/normalize.ts` → `addReceiptPrices`.

**rsETH is the single most consequential gap.** $194.9M of collateral with zero
measurable depth, because its real liquidity is a Balancer pool and Balancer
publishes no mainnet Messari DEX deployment. Its absence from
`REJECTED_DEX_CANDIDATES` is load-bearing rather than incidental, and the model
does not sell what it cannot see — that collateral is reported as stranded, never
as proceeds.

## Protocol coupling

Shared borrowers, debt-weighted Jaccard. Symmetric by construction and asserted so
by `assertSymmetric`, because asymmetry here would be an artefact of normalisation
rather than a fact about the protocols.

| | aave-v3 | compound-v2 | compound-v3 | morpho |
|---|---|---|---|---|
| **aave-v3** | 100.00% | 0.88% | 58.79% | 56.85% |
| **compound-v2** | 0.88% | 100.00% | 1.73% | 0.01% |
| **compound-v3** | 58.79% | 1.73% | 100.00% | 7.85% |
| **morpho** | 56.85% | 0.01% | 7.85% | 100.00% |

Shared collateral, deliberately **asymmetric**. Read `[row][column]` as "how much
of the row's collateral is standing in front of the column's liquidations".

| | aave-v3 | compound-v2 | compound-v3 | morpho |
|---|---|---|---|---|
| **aave-v3** | 100.00% | 8.42% | 98.85% | 28.77% |
| **compound-v2** | 94.82% | 100.00% | 94.08% | 94.26% |
| **compound-v3** | 99.28% | 43.28% | 100.00% | 60.96% |
| **morpho** | 98.06% | 96.95% | 59.94% | 100.00% |

The asymmetry is the finding, not a bug to be normalised away. Compound V2 holds
94.82% of its collateral in assets Aave V3 also lends against, while Aave V3 holds
only 8.42% in assets Compound V2 touches. Both protocols are exposed to the same
asset; only one of them is existentially exposed to the other's forced selling.
Symmetrising the matrix would erase exactly the direction contagion runs.

Top transmitting assets: weETH $885.8M (2 protocols), WETH $458.1M (3), wstETH
$402.5M (2), WBTC $233.5M (4), rsETH $194.9M (2).

## The three E-Mode modes, and why there are three

122 account-protocol pairs compute a health factor below 1 **at the snapshot**,
while sitting open and un-liquidated on a live chain. Liquidating them is
profitable and liquidation bots are fast, so the account being alive is stronger
evidence than our arithmetic: the parameters are wrong, not the borrower. The
dominant known cause is Aave V3 E-Mode, which raises the liquidation threshold for
correlated pairs and **has no field anywhere in the standardized schema**.

Since the residual cannot be attributed, Phase 4 publishes a bracket rather than a
point estimate:

| mode | what it assumes | books excluded | debt excluded |
|---|---|---|---|
| `off` | published thresholds are correct | 122 | $1,062,610,807 |
| `inferred` | factor-aligned pairs get the 0.95 E-Mode ceiling | 107 | $227,777,993 |
| `calibrated` | every unexplained book sits exactly at its boundary | 92 | $28,447,716 |

E-Mode inference resolves **15 books carrying $834,832,813** of the contradiction
— 78.6% of it — and it is verified against the Aave V3 Pool contract at **100%
precision** over the 40 largest borrowers: TP 9, FP 0, FN 6, TN 25, with nothing
excluded as incomparable. See `docs/verification/emode-inference.md`. Every
threshold it raises is one the contract confirms.

Recall is 60% (64.3% on contradicted accounts only), and the asymmetry is
deliberate. A false positive raises a threshold on an account that does not have
E-Mode, inventing safety margin and suppressing a liquidation the cascade should
have found. A false negative leaves the book contradicted, which *excludes* it and
reports its debt — conservative, and visible in the output rather than silent. So
the gates are tuned for precision.

Three of the sampled E-Mode accounts are the third category, stablecoin against
stablecoin, which a two-factor ETH/BTC model structurally cannot see: both legs
correctly regress to zero beta, so neither loads on anything. They are recovered by
measurement rather than by a token list — across the live collateral set USDC and
sUSDe sit at 0.00011 and 0.00031 daily volatility while the next asset up, XAUt, is
at 0.01582, a factor of fifty. `USD_MAX_VOLATILITY` sits in that gap. Tokenised
gold has near-zero betas too, so volatility is what keeps it out, and that same
asset defeating a price-band heuristic is why `factors.ts` measures in the first
place.

The largest book the inference *does* resolve is
`0x9600a48ed0f931d0c422d574e3275a90d8b22745` on Aave V3: $753.1M of weETH plus
$68.5M of wstETH securing $754.0M of WETH debt. That is one bet on ETH lent against
itself, it is the account whose on-chain 0.9500 threshold the schema publishes as
0.80, and it alone is $754.0M of the $834.8M resolved.

The largest remaining miss is `0xf7462251c14d2fb83c7ab96367a7985423c83010`, holding
**$138.2M of rsETH against $131.9M of WETH debt** — textbook ETH E-Mode, rejected
because rsETH's beta is measured at 0.57 with an R² of 0.51 over only 250 days of
history. The same asset that has no measurable DEX depth also has the weakest
measured correlation. Rather than loosen the R² gate and risk precision, the book
stays excluded and its debt is reported. The second largest miss,
`0xd8495b95a3a6a85f4e3baa003e8b7ed1ed85562d` at $56.6M of rsETH against $54.1M of
WETH, is the same asset for the same reason. Those two rsETH books alone are 81.6%
of the $227.8M `inferred` still cannot explain, so the recall gap is not spread
thin across a long tail — it is one asset with 250 days of price history.

**And what survives even `calibrated` is not a threshold problem at all.** The
largest book in the $28.4M residue is `0x8a25d8c9fa8c7a726137f2d618d85cbc2c083f78`
with $4.9M of GHO debt against **zero priceable collateral**, followed by
`0x65ae0ed283fa71fd0d22f13512d7e0bd9e54c14a` at $2.5M of USDS against zero. No
liquidation threshold can make a book with no collateral solvent, which is why
`effectiveThresholds` guards on `collateralUsd > 0` and reports these rather than
reaching for a threshold above 1. These are a different defect — collateral the
pipeline could not price, or an account whose supply positions are not in the
subgraph — and lumping them in with the E-Mode gap would have hidden them.

## Sensitivity

A uniform shock applied to both factors, in log space, through each asset's
measured betas.

| shock | mode | rounds | conv | idiosyncratic | systemic | total | amp | unliquidatable | distressed |
|---|---|---|---|---|---|---|---|---|---|
| 5% | off | 0 | yes | $0 | $0 | $0 | 0.00 | $0 | $0 |
| 5% | inferred | 0 | yes | $0 | $0 | $0 | 0.00 | $0 | $0 |
| 5% | calibrated | 102 | yes | $1,322,848 | $8,082,716 | $9,405,565 | 6.11 | $891,195,355 | $944,079,707 |
| 10% | off | 0 | yes | $0 | $0 | $0 | 0.00 | $0 | $0 |
| 10% | inferred | 0 | yes | $0 | $0 | $0 | 0.00 | $0 | $0 |
| 10% | calibrated | 103 | yes | $1,326,504 | $7,627,846 | $8,954,350 | 5.75 | $865,169,062 | $960,983,457 |
| 15% | off | 1 | yes | $391,131 | $0 | $391,131 | 0.00 | $0 | $782,261 |
| 15% | inferred | 1 | yes | $391,131 | $0 | $391,131 | 0.00 | $0 | $782,261 |
| 15% | calibrated | 100 | yes | $1,643,150 | $7,223,394 | $8,866,544 | 4.40 | $829,713,192 | $972,234,590 |
| 20% | off | 1 | yes | $830,953 | $0 | $830,953 | 0.00 | $512 | $880,159 |
| 20% | inferred | 1 | yes | $830,953 | $0 | $830,953 | 0.00 | $512 | $880,159 |
| 20% | calibrated | 89 | yes | $2,008,536 | $6,804,101 | $8,812,638 | 3.39 | $783,646,850 | $972,408,725 |
| 30% | off | 84 | yes | $846,028 | $1,553,152 | $2,399,181 | 1.84 | $109,654,153 | $115,882,392 |
| 30% | inferred | 374 | yes | $846,028 | $6,609,347 | $7,455,376 | **7.81** | $689,270,660 | $959,536,716 |
| 30% | calibrated | 77 | yes | $1,805,486 | $6,036,561 | $7,842,047 | 3.34 | $700,233,360 | $974,126,444 |

`distressed` is debt on every book that was liquidated or ended underwater, valued
at **snapshot** prices. It is the series the sensitivity claim rests on, and it is
denominated pre-shock deliberately: a 30% shock shrinks the dollar value of the
very collateral being seized, so liquidated USD is not comparable across shock
sizes. The script asserts distressed debt is monotone in the shock and aborts if it
is not.

Amplification is systemic over idiosyncratic — rounds 2+ over round 1. The single
largest figure in the table is the **7.81x** at a 30% shock under `inferred`: the
same $846,028 of directly-shocked liquidation drags $6,609,347 more behind it. That
row is also where `off` and `inferred` diverge most (1.84x against 7.81x), and the
divergence is the E-Mode gap doing its work — under `off` the $754M weETH book is
excluded and therefore cannot participate in the cascade at all, so excluding
contradicted books does not just lose their debt, it removes the largest
transmitter from the network.

### How much rests on the price-impact model

Run against the calibrated bound, because under the other two modes the surviving
books sit so far inside their thresholds that no depth constraint ever binds and
the table would be a flat line proving nothing.

| shock | depth | rounds | total liquidated | unliquidatable | distressed | amp |
|---|---|---|---|---|---|---|
| 10% | 0.5x | 76 | $4,530,725 | $864,731,481 | $956,125,947 | 5.17 |
| 10% | 1x | 103 | $8,954,350 | $865,169,062 | $960,983,457 | 5.75 |
| 10% | 2x | 155 | $17,837,653 | $859,240,419 | $963,936,269 | 6.10 |
| 20% | 0.5x | 73 | $4,873,880 | $781,035,466 | $972,408,725 | 2.29 |
| 20% | 1x | 89 | $8,812,638 | $783,646,850 | $972,408,725 | 3.39 |
| 20% | 2x | 118 | $16,707,430 | $779,983,616 | $973,329,793 | 4.46 |

Depth changes *how much of the distress can clear*, not how much distress there is.
Distressed debt moves by under 0.9% across a 4x range of depth while liquidated
volume moves by 3.9x, and at 20% it is identical to the dollar across 0.5x and 1x.
That is the correct decomposition: solvency is set by prices and thresholds, and
liquidity only decides whether the liquidation can actually happen.

## The headline

At a 20% shock, the risk is bracketed rather than point-estimated:

- **modellable books only** — $830,953 liquidated across 4 accounts in a single
  round, $512 left unliquidatable. The book Sentinel can compute with confidence is
  robust.
- **$227,777,993 on 107 books is excluded outright**, because those books compute
  as insolvent at the snapshot while sitting open on chain.
- **calibrated upper bound** — $972,408,725 of debt distressed, of which
  **$783,646,850 cannot be liquidated at any profitable price**, backed by
  $273,266,605 of collateral no liquidator can sell inside the bonus.

The most useful thing this phase found is where the risk lives: **concentrated
almost entirely in the accounts whose parameters the standardized schema cannot
express.** The positions Sentinel can model precisely are safe; the danger sits in
the ones it can only bracket. That is an argument for the schema gaining an E-Mode
field, and it is the reason all three modes are published rather than the middle
one alone.

## What is wrong with this model, stated plainly

**Liquidation is voluntary, and the first version of this model forgot it.** Naive
constant product on $402M of wstETH against $3.8M of measured depth says the price
falls 99.99%. That is not a price. No liquidator sells at a 99% loss — they are
paid the liquidation bonus and they stop the moment slippage exceeds it. Each round
now clears only `tolerance * reserve / (1 - tolerance)`, and the remainder does not
clear at all. Forced selling now moves WETH 0.96% at a 20% shock instead of
99.99%. The residue is reported as unliquidatable debt, which is a far more
consequential output than an invented price: it is debt the system cannot clear at
any profitable price.

**A round is a wave, not an interval.** With sales capped at the bonus, depth
drains geometrically rather than in a handful of steps, which is why convergence
takes 73–374 rounds. Depth never regenerates inside a run. Real market makers refill
between waves, so cumulative price impact over many rounds is a worst case; the
per-round figure is the honest description of any single wave.

**The 30% row is near a threshold.** Re-running against a fresh block has moved
total liquidation at 30% between $2.4M and $49.8M. The simulation is a pure function
of its inputs and is tested to be deterministic and order-independent, so this is
not nondeterminism in the model — it is a genuine knife edge in the system, where
one large book either does or does not cross its boundary and the depth it consumes
crowds out everyone else. Treat the 30% row as an order of magnitude, not a figure.

**Everything else pushes one way.** Betas are fitted over a normal year and real
correlations rise in a crash. Constant product on total reserves understates impact
for the range-exhausting trades that dominate here. Debt balances come from
event-written positions, so accrued interest is missing — Phase 3 measured debt
under-reported on **22 of 23** reconciled accounts, median error 0.15%.
$6,057,572 of collateral (0.27%) still has no measured beta and is not shocked at
all. Only four lending protocols qualify for inclusion. Every one of those is an
understatement, so the modellable output is a floor.

## Invariants the script enforces

`scripts/cascade.mts` aborts rather than writing output if any of these fail, and
`lib/cascade/__tests__/` tests all of them against constructed boundary cases:

- a 0% shock liquidates exactly $0, in all three E-Mode modes
- distressed debt never falls as the shock rises
- more depth never clears less, and never changes total distress
- every run converges rather than hitting the round cap
- the borrower-overlap matrix is symmetric to 1e-12
- reversing the position array changes no total, so round-level concurrency holds
- a single round cannot move a price by more than the liquidation bonus
- the E-Mode inference is verified against the Aave V3 Pool contract by
  `npm run verify:emode`, at 100% precision over the 40 largest borrowers

The first three exist because the first working version of this model violated all
three at once — a 0% shock reporting $680,695,224 of liquidations, total
liquidation *falling* as the shock rose, and 2x depth producing more distress.
Every individual number in that output looked plausible. Only the invariants
caught it.

The zero-shock invariant has since caught two more, both real, and both the same
defect: a position with two USD values. `$25,177` liquidated at a 0% shock because
aToken collateral was priced at $0 by the cascade's price index while carrying a
real `valueUsd`; then `$10,060,018` across 127 rounds because `emode.ts` valued
books at `valueUsd` (the position's own market's quote) while the simulator valued
them at the index (the deepest market's quote for the same asset), and `calibrated`
aims for health *exactly* 1 — the boundary the simulator tests. Neither was
visible in any printed figure. An invariant that only ever passes is not evidence
of anything; these two are why it is worth the abort.
