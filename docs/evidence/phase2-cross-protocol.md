# Phase 2 — the cross-protocol exposure graph

The headline finding, and what had to be fixed before it meant anything.

Reproduce with `npm run snapshot`. Every figure below is a live gateway read; the
codebase has no mock path and a test enforces that (`lib/__tests__/no-mock-data.test.ts`).

## The finding

At block **25964440**, across four block-aligned Messari-standardized lending
deployments covering **95.4% of all debt those protocols report**:

> **At least 9.07% of borrowed value — $906M — sits with addresses levered across
> two or more lending protocols.**

Of 37,870 accounts sampled, 1,114 hold positions on two or more protocols, 72 on
three, and 2 on all four. 359 of them carry debt.

| Protocol pair | Shared accounts |
|---|---|
| Aave V3 + Compound V3 | 541 |
| Aave V3 + Compound V2 | 212 |
| Compound V2 + Compound V3 | 211 |
| Compound V3 + Morpho Aave V2 | 161 |
| Aave V3 + Morpho Aave V2 | 78 |
| Compound V2 + Morpho Aave V2 | 65 |

This is the number no individual lending protocol can compute. Each one sees only
its own book. The join is possible because every deployment on the standardized
schema keys `Account` by the raw address, making it a **primary-key join** — no
address clustering, no heuristics, no probabilistic matching.

### Why "at least"

Two reasons, both in the conservative direction:

1. **Sampling.** Positions are pulled largest-first, stratified per market. Every
   position dropped is smaller than every position kept, so the measured share is
   a floor. Coverage is 95.4%, so the floor is close to the ceiling.
2. **Stale balances.** Position balances are written on events, so accrued
   interest is missing. Measured against the Aave V3 Pool contract, debt was
   under-reported on 22 of 23 accounts — see
   [health-reconciliation.md](../verification/health-reconciliation.md).

## Coverage

| Protocol | Schema | Sampled debt | Reported debt | Coverage |
|---|---|---|---|---|
| Aave V3 | 3.1.0 | $9,407,443,718 | $9,885,846,967 | 95.16% |
| Compound V3 | 3.1.0 | $576,456,557 | $580,229,135 | 99.35% |
| Compound V2 | 2.0.1 | $10,147,759 | $11,948,674 | 84.93% |
| Morpho Aave V2 | 3.0.1 | $5,507 | $5,964 | 92.35% |
| Aave V2 | 3.1.0 | — | — | **excluded, see below** |

All four included deployments served block 25964440 — the snapshot is block-aligned,
not stitched across time.

## Four things that had to be fixed first

Each was found by reading live output rather than trusting it, and each would have
silently corrupted the headline.

### 1. Aave V2 overstates debt by three orders of magnitude

Its position mappings handle `Borrow` but not `Repay`: positions opened in May
2021 show `borrowCount: 41, repayCount: 0` and were never closed, so `balance` is
*lifetime cumulative borrowed*, not outstanding debt. It reported $26.87B of
position debt against $13.96M of protocol debt — **1925x** on this snapshot.

The multiple is not a constant, and it would be sloppy to quote it as one: the
same gate measured **1011x** during the CRE simulation
(`docs/evidence/cre-simulation.log`), because the ratio moves with whichever
positions the sample happens to draw. The finding is invariant; its magnitude
is not.

The fix is not an Aave V2 special case. A sample is a subset, so sampled debt can
never legitimately exceed reported debt — that inequality is a free integrity
gate, and it works for any protocol. The gate lives in `lib/graph/snapshot.ts`,
Aave V2 stays in the registry, and the exclusion reason is recorded in the
snapshot's provenance rather than dropped.

The cross-check costs nothing precisely *because* of the standard: protocol-level
totals and position-level rows come back through the same query shape.

### 2. Ordering by raw `balance` sorts by decimal count, not value

`balance` is a raw BigInt, so a global `orderBy: balance` ranks an 18-decimal
token above a larger USDC position. "Largest first" was false, which would have
made the share-of-debt figure meaningless.

Sampling is now stratified per market. Within a market, decimals are constant, so
balance order *is* value order.

### 3. Sampling is invalid for per-account risk

An account's debt can sit in a deep market and be captured while the collateral
backing it ranks below another market's cutoff and is dropped — which collapses
its health factor for no reason but our own sampling. This is why 4,367 borrowers
initially looked insolvent.

Accounts of interest are now re-fetched exhaustively (`lib/graph/complete.ts`).
For the 359 multi-protocol borrowers this returns 2,402 positions where the
stratified sample held 1,541: **36% of their positions were missing.**

On the run that surfaced this, 4,367 borrowers looked insolvent before completion
and 119 after. At this block the post-completion figure is 116 of 359, holding
$1.08B — and that residue is not sampling. It is Aave V3 E-Mode, which the
standardized schema does not express; Phase 5 reconstructs it (see
[emode-groups.md](emode-groups.md)) and recovers most of it.

### 4. The same standardized field ships in two different units

`liquidationThreshold` is specified as a percentage. Aave V3 emits `83` and
Compound V2 emits `82.5`. **Morpho Aave V2 emits `0.86`.** Both live, right now.
`toFraction` infers the unit from magnitude and rejects anything above 100.

## The reach of the standard, honestly

Sentinel covers four protocols, not because four is impressive, but because that
is what actually publishes this schema on the decentralized network for Ethereum
mainnet lending. Candidates evaluated and rejected (recorded in
`REJECTED_CANDIDATES` in `lib/graph/deployments.ts`):

| Subgraph | Why not |
|---|---|
| Silo Finance v2 Mainnet | Has a `LendingProtocol` type, but no `totalBorrowBalanceUSD` or `totalValueLockedUSD` |
| Fraxlend Mainnet | No `lendingProtocols` field; not the Messari lending schema |
| Silo v1 Mainnet | No `lendingProtocols` field; not the Messari lending schema |

Including them would mean writing the per-protocol adapters the standard exists to
make unnecessary. The point of the registry is that adding a protocol is adding a
row — and that property only holds if the row genuinely answers the same query.

## One concession to version skew

`positionsQuery` varies by *schema version*, because `Position.asset` was added in
3.x and Compound V2 is live on 2.0.1, where the asset is the market's input token.
That is weaker than a per-protocol adapter — four protocols still share one query
shape, keyed on a version string the subgraph itself reports — but it is the
honest limit of the standard as deployed, and `lib/graph/queries.ts` says so at
the point where someone would be tempted to add a second exception.
