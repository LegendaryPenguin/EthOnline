# Phase 4 — the cascade model

Every number here is produced by `npm run cascade` against live subgraph data at
the blocks recorded in `data/cascade.json`. Nothing is hand-entered. Re-running
regenerates all of it, and the script aborts rather than printing if any of its
invariants fail.

```
npm run cascade
```

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
| fields consumed | `Position.balance`, `Position.side`, `Position.isCollateral`, `Market.liquidationThreshold`, `Market.liquidationPenalty`, `Market.inputTokenPriceUSD`, `Market.totalValueLockedUSD`, `MarketDailySnapshot.inputTokenPriceUSD` | `LiquidityPool.inputTokenBalances`, `LiquidityPool.inputTokens{id,symbol,decimals}`, `LiquidityPool.isSingleSided` |
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

## Factor exposures, measured rather than assumed

Shocking each collateral asset independently would be wrong by roughly fourfold,
because **87% of cross-protocol collateral is one bet on ETH**. Betas come from a
two-factor OLS regression of daily log returns on WETH and WBTC, using
`MarketDailySnapshot.inputTokenPriceUSD` — the protocol's own oracle, so the
correlations measured are between the exact numbers that trigger liquidations.

| asset | collateral | DEX depth | collateral/depth | βETH | βBTC | R² | obs |
|---|---|---|---|---|---|---|---|
| weETH | $885,764,646 | $16,358,038 | **54.1x** | 0.94 | 0.07 | 0.95 | 364 |
| WETH | $455,757,255 | $211,993,466 | 2.1x | 1.00 | 0.00 | 1.00 | 364 |
| wstETH | $402,184,909 | $3,790,935 | **106.1x** | 0.98 | 0.03 | 0.99 | 364 |
| WBTC | $233,107,297 | $89,442,985 | 2.6x | 0.00 | 1.00 | 1.00 | 364 |
| rsETH | $194,888,334 | **$0** | no depth | 0.57 | 0.24 | 0.51 | 250 |
| cbETH | $5,423,784 | $168,007 | 32.3x | 0.98 | -0.12 | 0.71 | 312 |
| USDC | $4,399,822 | $176,483,247 | 0.0x | -0.00 | 0.00 | 0.01 | 364 |
| XAUt | $4,281,632 | $2,802,193 | 1.5x | 0.05 | 0.17 | 0.11 | 362 |

Two rows are worth reading closely. USDC regresses to a beta of zero on both
factors at an R² of 0.01 — a stablecoin correctly identified as one without ever
being labelled. And XAUt is why the regression exists at all: an earlier version
of this model classified assets by price band, and tokenised gold trading at 1.73x
the ETH price fell inside a `[0.85, 1.75]` window and was shocked as an ETH
derivative. Both rejected designs are documented in the header of
`lib/cascade/factors.ts`, including the one that would have been more satisfying to
ship — corroborating correlation from DEX pool composition, which measurement
showed carries almost no information, because on Ethereum LINK is 94.3% and AAVE
97.2% paired with WETH by depth. Everything trades against WETH.

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
| **aave-v3** | 100.00% | 0.88% | 58.81% | 56.86% |
| **compound-v2** | 0.88% | 100.00% | 1.73% | 0.01% |
| **compound-v3** | 58.81% | 1.73% | 100.00% | 7.88% |
| **morpho** | 56.86% | 0.01% | 7.88% | 100.00% |

Shared collateral, deliberately **asymmetric**. Read `[row][column]` as "how much
of the row's collateral is standing in front of the column's liquidations".

| | aave-v3 | compound-v2 | compound-v3 | morpho |
|---|---|---|---|---|
| **aave-v3** | 100.00% | 8.47% | 99.35% | 28.84% |
| **compound-v2** | 94.84% | 100.00% | 94.10% | 94.28% |
| **compound-v3** | 99.30% | 43.25% | 100.00% | 60.94% |
| **morpho** | 98.06% | 96.94% | 59.94% | 100.00% |

The asymmetry is the finding, not a bug to be normalised away. Compound V2 holds
94.84% of its collateral in assets Aave V3 also lends against, while Aave V3 holds
only 8.47% in assets Compound V2 touches. Both protocols are exposed to the same
asset; only one of them is existentially exposed to the other's forced selling.
Symmetrising the matrix would erase exactly the direction contagion runs.

Top transmitting assets: weETH $885.8M (2 protocols), WETH $455.8M (3), wstETH
$402.2M (2), WBTC $233.1M (4), rsETH $194.9M (2).

## The three E-Mode modes, and why there are three

125 account-protocol pairs compute a health factor below 1 **at the snapshot**,
while sitting open and un-liquidated on a live chain. Liquidating them is
profitable and liquidation bots are fast, so the account being alive is stronger
evidence than our arithmetic: the parameters are wrong, not the borrower. The
dominant known cause is Aave V3 E-Mode, which raises the liquidation threshold for
correlated pairs and **has no field anywhere in the standardized schema**.

Since the residual cannot be attributed, Phase 4 publishes a bracket rather than a
point estimate:

| mode | what it assumes | books excluded | debt excluded |
|---|---|---|---|
| `off` | published thresholds are correct | 125 | $1,062,616,496 |
| `inferred` | factor-aligned pairs get the 0.95 E-Mode ceiling | 111 | $230,441,202 |
| `calibrated` | every unexplained book sits exactly at its boundary | 97 | $31,238,520 |

E-Mode inference resolves 16 books carrying $832.2M of the contradiction, and it
is verified against the Aave V3 Pool contract at **100% precision** over the 40
largest borrowers — see `docs/verification/emode-inference.md`. Every threshold it
raises is one the contract confirms.

Recall is 60%, and the asymmetry is deliberate. A false positive raises a threshold
on an account that does not have E-Mode, inventing safety margin and suppressing a
liquidation the cascade should have found. A false negative leaves the book
contradicted, which *excludes* it and reports its debt — conservative, and visible
in the output rather than silent. So the gates are tuned for precision.

Three of the sampled E-Mode accounts are the third category, stablecoin against
stablecoin, which a two-factor ETH/BTC model structurally cannot see: both legs
correctly regress to zero beta, so neither loads on anything. They are recovered by
measurement rather than by a token list — across the live collateral set USDC and
sUSDe sit at 0.00011 and 0.00031 daily volatility while the next asset up, XAUt, is
at 0.01582, a factor of fifty. `USD_MAX_VOLATILITY` sits in that gap. Tokenised
gold has near-zero betas too, so volatility is what keeps it out, and that same
asset defeating a price-band heuristic is why `factors.ts` measures in the first
place.

The largest remaining miss is a single book holding **$138.2M of rsETH against
$131.9M of WETH debt** — textbook ETH E-Mode, rejected because rsETH's beta is
measured at 0.57 with an R² of 0.51 over only 250 days of history. The same asset
that has no measurable DEX depth also has the weakest measured correlation. Rather
than loosen the R² gate and risk precision, the book stays excluded and its debt is
reported.

## Sensitivity

A uniform shock applied to both factors, in log space, through each asset's
measured betas.

| shock | mode | rounds | conv | idiosyncratic | systemic | total | amp | unliquidatable | distressed |
|---|---|---|---|---|---|---|---|---|---|
| 5% | off | 0 | yes | $0 | $0 | $0 | 0.00 | $0 | $0 |
| 5% | inferred | 0 | yes | $0 | $0 | $0 | 0.00 | $0 | $0 |
| 5% | calibrated | 83 | yes | $1,318,683 | $8,107,749 | $9,426,432 | 6.15 | $888,649,028 | $941,394,403 |
| 10% | off | 0 | yes | $0 | $0 | $0 | 0.00 | $0 | $0 |
| 10% | inferred | 0 | yes | $0 | $0 | $0 | 0.00 | $0 | $0 |
| 10% | calibrated | 82 | yes | $1,309,457 | $7,657,976 | $8,967,433 | 5.85 | $875,273,092 | $970,844,096 |
| 15% | off | 1 | yes | $391,131 | $0 | $391,131 | 0.00 | $0 | $782,261 |
| 15% | inferred | 1 | yes | $391,131 | $0 | $391,131 | 0.00 | $0 | $782,261 |
| 15% | calibrated | 76 | yes | $1,627,045 | $7,293,938 | $8,920,983 | 4.48 | $829,156,329 | $971,684,647 |
| 20% | off | 1 | yes | $830,953 | $0 | $830,953 | 0.00 | $512 | $880,159 |
| 20% | inferred | 1 | yes | $830,953 | $0 | $830,953 | 0.00 | $512 | $880,159 |
| 20% | calibrated | 82 | yes | $1,993,374 | $6,871,250 | $8,864,624 | 3.45 | $784,018,738 | $972,779,722 |
| 30% | off | 283 | yes | $7,570,178 | $42,251,088 | $49,821,267 | 5.58 | $167,983,235 | $230,034,650 |
| 30% | inferred | 290 | yes | $7,570,178 | $42,091,914 | $49,662,092 | 5.56 | $177,805,265 | $249,717,820 |
| 30% | calibrated | 143 | yes | $8,346,957 | $8,031,677 | $16,378,635 | 0.96 | $638,836,395 | $999,239,203 |

`distressed` is debt on every book that was liquidated or ended underwater, valued
at **snapshot** prices. It is the series the sensitivity claim rests on, and it is
denominated pre-shock deliberately: a 30% shock shrinks the dollar value of the
very collateral being seized, so liquidated USD is not comparable across shock
sizes. The script asserts distressed debt is monotone in the shock and aborts if it
is not.

Amplification is systemic over idiosyncratic — rounds 2+ over round 1. Under the
calibrated bound a 5% shock produces **6.15x** more liquidation from contagion than
from the shock itself.

### How much rests on the price-impact model

Run against the calibrated bound, because under the other two modes the surviving
books sit so far inside their thresholds that no depth constraint ever binds and
the table would be a flat line proving nothing.

| shock | depth | rounds | total liquidated | unliquidatable | distressed | amp |
|---|---|---|---|---|---|---|
| 10% | 0.5x | 71 | $4,540,221 | $879,696,315 | $970,844,096 | 5.31 |
| 10% | 1x | 82 | $8,967,433 | $875,273,092 | $970,844,096 | 5.85 |
| 10% | 2x | 96 | $17,825,656 | $866,408,348 | $970,834,997 | 6.16 |
| 20% | 0.5x | 69 | $4,896,731 | $781,400,663 | $972,779,722 | 2.33 |
| 20% | 1x | 82 | $8,864,624 | $784,018,738 | $972,779,722 | 3.45 |
| 20% | 2x | 104 | $16,809,720 | $779,402,928 | $972,779,722 | 4.53 |

Depth changes *how much of the distress can clear*, not how much distress there is.
Distressed debt is flat across the three columns to within a rounding error while
liquidated volume moves by 3.7x, which is the correct decomposition: solvency is
set by prices and thresholds, and liquidity only decides whether the liquidation
can actually happen.

## The headline

At a 20% shock, the risk is bracketed rather than point-estimated:

- **modellable books only** — $830,953 liquidated, $512 left unliquidatable. The
  book Sentinel can compute with confidence is robust.
- **$230,441,202 on 111 books is excluded outright**, because those books compute
  as insolvent at the snapshot while sitting open on chain.
- **calibrated upper bound** — $972,779,722 of debt distressed, of which
  **$784,018,738 cannot be liquidated at any profitable price**, backed by
  $273,307,236 of collateral no liquidator can sell inside the bonus.

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
clear at all. Forced selling now moves WETH 0.97% at a 20% shock instead of
99.99%. The residue is reported as unliquidatable debt, which is a far more
consequential output than an invented price: it is debt the system cannot clear at
any profitable price.

**A round is a wave, not an interval.** With sales capped at the bonus, depth
drains geometrically rather than in a handful of steps, which is why convergence
takes 70–290 rounds. Depth never regenerates inside a run. Real market makers refill
between waves, so cumulative price impact over many rounds is a worst case; the
per-round figure is the honest description of any single wave.

**The 30% row is near a threshold.** Re-running against a fresh block moved total
liquidation at 30% between $11.6M and $49.7M. The simulation is a pure function of
its inputs and is tested to be deterministic and order-independent, so this is not
nondeterminism in the model — it is a genuine knife edge in the system, where one
large book either does or does not cross its boundary and the depth it consumes
crowds out everyone else. Treat the 30% row as an order of magnitude, not a figure.

**Everything else pushes one way.** Betas are fitted over a normal year and real
correlations rise in a crash. Constant product on total reserves understates impact
for the range-exhausting trades that dominate here. Debt balances come from
event-written positions, so accrued interest is missing (Phase 3: 22 of 23
accounts). $6,010,720 of collateral has no measured beta and is not shocked at all.
Only four lending protocols qualify for inclusion. Every one of those is a
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
