# `sentinel-signal/1` — the published signal

This document is the integration contract. It is written to be sufficient on its own: a
consumer implemented from this file alone, in any language, should authenticate and decode a
Sentinel report correctly and reject every report it ought to reject.

That claim is tested rather than asserted. `contracts/src/SentinelConsumer.sol` and its
Foundry suite were written from this document only — not from `lib/signal/` — and they
interoperate with payloads produced by the TypeScript producer. If the two ever disagree, one
of them is wrong and this document is ambiguous.

---

## What the signal measures

**How much borrowed value sits with addresses levered across more than one lending protocol
on the same collateral.** Single-protocol leverage liquidates once. Cross-protocol leverage
on shared collateral cascades: a liquidation on protocol A moves the price of collateral that
protocol B is also lending against, and B's borrowers were never counted in A's risk model.

The per-address joins that produce this number are computed inside a TEE and never leave it.
Publishing them would be the harm the signal exists to warn about — a ranked list of levered
addresses is a target list for liquidation bots and a deanonymization aid. So what crosses
the boundary is only what is in the field table below, plus a `k`-anonymity floor: any
coupling bucket with fewer than `k` borrowers is suppressed and counted rather than published.
See `docs/ENCLAVE.md`.

**Every USD figure is a measured lower bound.** The enclave samples the deepest markets and
the largest borrowers within an HTTP budget; it does not read every position on Ethereum.
Coverage against what protocols report for themselves runs a little over half. A consumer
that treats `debtUsd6` as total outstanding borrowing on Ethereum will be wrong, and wrong in
the safe direction only by luck.

## Cadence and lifecycle

| | |
|---|---|
| Produced by | Chainlink CRE workflow `sentinel`, `handlerInTee` |
| Schedule | every 5 minutes (`0 */5 * * * *`) |
| Signed by | the DON that runs the workflow, `f + 1` distinct signers |
| Freshness | `asOfBlock` is the *oldest* block any included deployment served |
| Version string | `sentinel-signal/1`, carried in field 0 of every report |

A report is produced on a schedule, so its *existence* carries no information: absence of an
alert is not silence, and a repeated report with an unchanged `asOfBlock` means the indexers
have not advanced, not that the world has not moved. Consumers must key on `asOfBlock`.

---

## Wire format

A report is three pieces. All three are required to authenticate it; the first alone is not a
signal, it is a claim.

```
rawReport      109-byte metadata header ‖ ABI-encoded signal body
reportContext  the DON's config digest and sequence number (opaque to a consumer)
signatures     N × 65-byte ECDSA (r ‖ s ‖ v) over the report hash
```

### The 109-byte metadata header

Big-endian throughout. Offsets are byte offsets into `rawReport`.

| offset | size | field | notes |
|---|---|---|---|
| 0 | 1 | `version` | report format version, not signal version |
| 1 | 32 | `executionId` | this workflow run |
| 33 | 4 | `timestamp` | seconds; when the DON spoke, **not** when the data was read |
| 37 | 4 | `donId` | |
| 41 | 4 | `donConfigVersion` | |
| 45 | 32 | `workflowId` | |
| 77 | 10 | `workflowName` | ASCII, right-padded with NUL bytes; strip trailing NULs |
| 87 | 20 | `workflowOwner` | address |
| 107 | 2 | `reportId` | |

The header is what makes a signature meaningful. A valid signature over an anonymous blob
proves only that *some* workflow the DON runs produced it, and anyone can deploy a workflow
to that DON. **A consumer that verifies signatures but not `workflowName` and
`workflowOwner` will accept an attacker's report.** This is the subtle forgery, and it is the
one most integrations get wrong.

### The report hash the DON signs

```
hash = keccak256( keccak256(rawReport) ‖ reportContext )
```

Note the inner hash: it is over `rawReport`, not over the body, so the header is signed too.
`v` appears in the wild as either `27`/`28` (Ethereum tooling) or `0`/`1` (raw recovery id);
accept both and normalise before recovering.

ECDSA recovery over the wrong bytes does not fail — it succeeds and yields an unrelated
address. So a tampered report surfaces as *unknown signer*, never as *bad signature*. The
pinned signer set is the thing that catches tampering, which is why pinning it is not
optional.

### The signal body

Everything after byte 109 is a standard ABI-encoded tuple:

```
string version, uint64 asOfBlock, uint32 borrowersObserved, uint256 debtUsd6,
uint256 evaluableDebtUsd6, uint256 multiProtocolDebtUsd6, uint16 multiProtocolShareBps,
uint16 leveredShareBps, uint16 worstShockBps, uint256 worstShockDistressedDebtUsd6,
uint16 systemicRiskScoreBps, uint16 couplingBuckets, uint16 suppressedBuckets,
uint32 emodeInferredBorrowers, uint256 emodeInferredDebtUsd6
```

ABI tuples are positional. **Appending a field is compatible; reordering or retyping one is
not, even if every name looks unchanged** — an old decoder reading a reordered tuple does not
error, it returns plausible numbers in the wrong fields. That is why the version string is
field 0 and why refusing an unrecognised version is mandatory rather than advisory.

---

## Fields

Units first, because they are the most common integration bug:

- `*Usd6` — USD scaled by 10^6, as an integer. Divide by 1,000,000 for dollars. Scaled at
  the boundary because a consumer contract cannot do arithmetic on a float, and rounding once
  here beats rounding in Solidity.
- `*Bps` — basis points, so 10000 = 100%. Saturating, never wrapping.
- `systemicRiskScoreBps` — the 0–100 score in basis points of 100, so 2201 means 22.01.

| field | type | meaning |
|---|---|---|
| `version` | `string` | `sentinel-signal/1`. Refuse anything else. |
| `asOfBlock` | `uint64` | The **oldest** block any included deployment served. The minimum, not the maximum: staleness must be judged against the least fresh input, or one lagging deployment hides behind a fresh one. `0` means no provenance — refuse it. |
| `borrowersObserved` | `uint32` | Borrowers in the sample. Not the population. |
| `debtUsd6` | `uint256` | Borrowed value observed across all included deployments. A lower bound. |
| `evaluableDebtUsd6` | `uint256` | **The denominator every published share is taken against.** Smaller than `debtUsd6`: books whose health factor contradicts the chain are observed but not evaluated. Dividing a share by `debtUsd6` is the obvious mistake and it understates. |
| `multiProtocolDebtUsd6` | `uint256` | Borrowed value held by addresses with positions on two or more included deployments. The headline quantity. |
| `multiProtocolShareBps` | `uint16` | `multiProtocolDebtUsd6 / evaluableDebtUsd6`, in bps. |
| `leveredShareBps` | `uint16` | Share of evaluable debt held by borrowers above the policy's leverage watch level. The threshold itself is confidential. |
| `worstShockBps` | `uint16` | The largest collateral shock the confidential policy evaluates, in bps (3000 = a 30% drop). Policy-dependent; read it, do not assume it. |
| `worstShockDistressedDebtUsd6` | `uint256` | Borrowed value that goes distressed at `worstShockBps`. Distress, not liquidation — no cascade rounds and no liquidator behaviour are modelled here. |
| `systemicRiskScoreBps` | `uint16` | Composite score, bps of 100. Bounded at 10000 (i.e. 100.00). Its weights are confidential; its *level* is not comparable across months, only its change. See below. |
| `couplingBuckets` | `uint16` | Protocol pairs sharing levered borrowers that cleared the `k`-anonymity floor. |
| `suppressedBuckets` | `uint16` | Pairs withheld for having too few borrowers to publish. **Non-zero is the floor working, not missing data.** A rising count is itself information: coupling exists and is too concentrated to name. |
| `emodeInferredBorrowers` | `uint32` | Borrowers whose risk parameters come from Sentinel's E-Mode reconstruction rather than published values. |
| `emodeInferredDebtUsd6` | `uint256` | Their borrowed value. Live, this is a large share of the evaluable book — a consumer that cannot see it is trusting rather than checking. |

### Using the score

The level is not a threshold. Backtesting over replayed cascades (`docs/BACKTEST.md`,
`docs/evidence/phase6-early-warning.md`) found that an absolute threshold on the score
detected **0 of 5** replayable cascade episodes, while a week-on-week *change* — the same
hour 168 hours earlier, so hour-of-day and day-of-week cancel — detected 3 of 5 at a median
24-hour lead. Composition of the sample drifts across months; the level drifts with it.

So a consumer that acts on the signal should store the score and compare against its own
history. Published operating points, each with the false-alarm rate measured on the same
ordinary-hour distribution that calibrated it:

| operating point | fires on a week-on-week rise of | stated false-alarm rate |
|---|---|---|
| watch | ≥ 0.61 (61 bps) | 30% |
| warn | ≥ 0.87 (87 bps) | 20% |
| alert | ≥ 2.39 (239 bps) | 10% |

All three are published rather than the best being chosen. `n = 5` — this is a demonstrated
direction with a stated lead time, not a significance claim. Do not act on a *fall*, however
large: August's structural break was a nine-point drop, and a policy keyed on magnitude would
have called it a crisis.

---

## Verifying a report

The order matters, and it is not merely an optimisation.

1. **Policy sanity.** `f >= 0`, and the pinned signer set has at least `f + 1` members.
   Otherwise quorum is unreachable and every report fails in a way that looks like an attack
   but is a misconfiguration.
2. **Length.** `rawReport.length >= 109`.
3. **Identity.** Parse the header; require `workflowOwner` (case-insensitive) and
   `workflowName` to equal the pinned values.
4. **Quorum.** Recover each signature against the report hash. Require `f + 1` **distinct**
   signers, all in the pinned set. A single signer's signature repeated is not a quorum;
   counting duplicates lets one compromised node satisfy `f + 1` alone.
5. **Decode** the body — *after* steps 3 and 4, never before. Decoding first is how an
   attacker's numbers reach a log line that somebody later trusts.
6. **Version.** Require exactly `sentinel-signal/1`.
7. **Provenance.** Reject `asOfBlock == 0`, and reject `asOfBlock > currentBlock` — a future
   block is either a clock problem or a fabrication, and neither is actionable.
8. **Freshness.** Reject `currentBlock - asOfBlock > maxBlockAge`.

Staleness is checked against `asOfBlock`, not the header `timestamp`. A DON can re-sign a
stale reading at any moment: the timestamp says when someone last spoke, the block says when
the world was last observed. Only the second is a freshness claim.

Suggested `maxBlockAge`: Ethereum runs ~298.4 blocks/hour. The workflow runs every 5 minutes,
so ~100 blocks (≈20 min) tolerates a few missed runs; a consumer moving money should use less
and a dashboard can use more. Publish whatever you choose — the number is part of your
consumer's security posture.

## What a consumer must not do

- Do not decode before authenticating.
- Do not skip `workflowName`/`workflowOwner` because the signatures verified.
- Do not count duplicate signers toward quorum.
- Do not accept an unknown `version` and hope the fields still line up.
- Do not use the header timestamp for staleness.
- Do not treat `debtUsd6` as total Ethereum borrowing, or as the denominator for shares.
- Do not treat `suppressedBuckets > 0` as an error, or retry to make it go away.
- Do not attempt to recover per-address detail. It is not in the report and no future version
  will add it; that is the point of the enclave.

---

## Reference consumers

Two, deliberately independent — different languages, different trust models, no shared code:

| | `lib/signal/consume.ts` | `contracts/src/SentinelConsumer.sol` |
|---|---|---|
| Written from | the producer's own types | **this document only** |
| Runtime | any JS host; viem only, no CRE toolchain | EVM |
| Verification | full: quorum, identity, version, freshness | full: quorum, identity, version, freshness |
| Behaviour | reports (`describeSignal`) | alters state — a guarded vault raises its collateral requirement and pauses new borrows |
| Tests | `lib/signal/__tests__/`, plus `npm run consume-signal` against a real payload | `forge test --fork-url`, including the negative cases |

`docs/evidence/consume-signal.md` records the TypeScript consumer accepting a real payload
from live subgraph data and refusing seven mutations of it.
`docs/evidence/phase8-forge.log` records the same for the Solidity one.

Minimal TypeScript integration:

```ts
import { verifySignalReport, describeSignal } from "sentinel/lib/signal/consume";

const verified = await verifySignalReport(
  { rawReport, reportContext, signatures },
  { signers: DON_SIGNERS, f: 1, workflowOwner: OWNER, workflowName: "sentinel", maxBlockAge: 100n },
  currentBlock,
);
console.log(describeSignal(verified)); // throws ReportRejected rather than returning a bad signal
```

`verifySignalReport` throws `ReportRejected` with a reason naming the failing value; it never
returns a partially-trusted result, and `describeSignal` accepts only a `VerifiedSignal`, so
the type system makes "format an unverified report" unrepresentable.
