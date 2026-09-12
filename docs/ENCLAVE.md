# The enclave boundary

Every value that crosses into or out of the TEE, and why it is on the side it is on.

Sentinel's confidentiality claim is narrow and worth stating precisely: **per-address
cross-protocol leverage is computed and then destroyed inside the enclave, and only
aggregates leave it.** This document is the enumeration that makes that claim
checkable rather than asserted. If a value is not listed here, it does not cross.

The reason there is anything to protect at all: publishing which addresses are levered
across which protocols, on which collateral, and at what shock they liquidate is
itself the harm — it is a pre-sorted queue for liquidation bots and a permanent
cross-protocol linkage of otherwise-unlinked positions. `npm run leak-demo` prints
that table, from the same pipeline, to show it is real. See
`docs/evidence/leak-demo.md`.

---

## What runs inside

`cre/sentinel-signal/workflow.ts`, registered with **`cre.handlerInTee`** rather than
`cre.handler`. The distinction is the whole design: with `cre.handler` the aggregation
would run on ordinary DON compute and the per-address intermediate would be visible to
node operators.

Attestation is AWS Nitro, `us-west-2` only.

### The boundary the TEE does *not* give you

**The workflow binary is revealed to node operators.** CRE's confidentiality protects
the *data* the workflow computes over, not the workflow itself. So the code is public
(this repo), and nothing here relies on the logic being secret. What is protected is
the borrower data flowing through it and the secrets it holds.

---

## Crossing IN

| Value | Source | Confidential? | Why |
|---|---|---|---|
| `GRAPH_API_KEY` | Vault DON secret, via `runtime.getSecret({id}).result().value` | **Yes** | The Graph's gateway takes the key as a **path segment** (`/api/{KEY}/subgraphs/id/{ID}`), so the request URL *is* the secret. It is never logged, never in an error message, and never passed to `usingTheDons()`. |
| `SENTINEL_RISK_POLICY` | Vault DON secret, same mechanism | **Yes** | Shock ladder, per-asset betas, k-anonymity threshold, score weights, and the E-Mode groups. As sensitive as the key: the betas and shock ladder are the model, and the thresholds tell an attacker exactly where the published signal stops resolving. |
| Subgraph responses | `new cre.capabilities.HTTPClient().sendRequest(teeRuntime, …)` | **Yes** | Raw `Position` rows — account, protocol, side, asset, amount. This is the per-address data the enclave exists to hold. `sendRequest` has a `TeeRuntime` overload; passing the TEE runtime is what keeps the response inside. |
| `config.*` (schedule, gateway base URL, subgraph IDs, schema versions, sampling sizes, `httpCallBudget`, `maxBlockLag`) | `workflow.yaml` / `config.*.json`, committed | No | Public parameters. A reviewer must be able to see the sampling plan to judge the coverage claim; hiding it would make the numbers unfalsifiable. Note the gateway *base* URL is public — only the key-bearing full URL is not. |
| Cron trigger time | CRE cron capability | No | A schedule, `0 */5 * * * *`. |

## Crossing OUT

Exactly one thing leaves: the ABI-encoded report, via
`runtime.usingTheDons().report({ encodedPayload, encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' })`.

`usingTheDons()` returns a plain `Runtime`, not a `TeeRuntime`. **Anything handed to it
has left the enclave.** That single call site is therefore the entire egress surface,
which is what makes the enumeration below complete.

The fifteen published fields, defined once in `lib/signal/report.ts`
(`SIGNAL_ABI_PARAMS`) and documented in `docs/SIGNAL.md`:

| # | Field | What it is | Why it is safe to publish |
|---|---|---|---|
| 1 | `version` | `sentinel-signal/1` | A schema tag. |
| 2 | `asOfBlock` | The **oldest** block any included deployment served | Minimum, not maximum: a consumer's staleness check must bind on the least fresh input. |
| 3 | `borrowersObserved` | Count of distinct accounts with debt in the sample | A count, not a set. |
| 4 | `debtUsd6` | Observed debt, 6 decimals | A sampled lower bound over ≥3 accounts per aggregate. |
| 5 | `evaluableDebtUsd6` | Observed debt on books whose risk parameters are self-consistent | The denominator every share below is taken against. Published because without it `debtUsd6` is the obvious wrong guess. |
| 6 | `multiProtocolDebtUsd6` | Debt held by addresses levered on 2+ protocols | The headline. An aggregate over the whole sample. |
| 7 | `multiProtocolShareBps` | (6) ÷ (5) | Ratio of two published aggregates. |
| 8 | `leveredShareBps` | Share of debt at or below the policy's leverage watch level | Same. |
| 9 | `worstShockBps` | The deepest shock on the ladder | A policy parameter, echoed so the next field has units. |
| 10 | `worstShockDistressedDebtUsd6` | Debt that becomes distressed at that shock | An aggregate. Crucially *not* per-address: it says how much, never whose. |
| 11 | `systemicRiskScoreBps` | The composite score | A weighted function of the above. |
| 12 | `couplingBuckets` | Number of protocol-pair buckets that cleared *k* | Buckets are keyed by **protocol pair**, never by address. |
| 13 | `suppressedBuckets` | Number withheld for *k*-anonymity | Published deliberately: silent suppression would understate coupling and read as good news. |
| 14 | `emodeInferredBorrowers` | Borrowers whose solvency rests on the E-Mode reconstruction | A count. Published so the signal discloses how much of itself is inference rather than published risk parameters — live, that is most of it. |
| 15 | `emodeInferredDebtUsd6` | Their debt | Same. |

### What never crosses out

- Any address, in any form — account, asset, or market id.
- Any per-address row: leverage, protocols, collateral composition, liquidation shock.
- Per-pair coupling below *k* = 3 borrowers.
- The secrets, or anything derived from them closely enough to invert: the raw beta
  table, the shock ladder's shape beyond `worstShockBps`, the E-Mode group membership.

## How that is enforced, not just intended

Three mechanisms, in order of how hard they are to defeat:

1. **`assertAggregateOnly(signal)`** — runs inside `aggregateSignal`, on its own return
   value, so the guard cannot be skipped by a later edit to `workflow.ts` that forgets
   to call it. It walks the whole tree rejecting any address-shaped **value or key**.
   Keys matter: a `Record` keyed by account leaks just as thoroughly as a list of
   accounts. Case-insensitive, so a checksummed address does not slip past.
   (`lib/signal/aggregate.ts`; tested in `lib/signal/__tests__/aggregate.test.ts`.)
2. **The single egress call site.** Because only `usingTheDons().report(...)` leaves,
   and the payload comes only from `encodeSignal`, adding a field requires editing
   `SIGNAL_ABI_PARAMS` — which is a reviewable, typed, one-line diff rather than an
   accidental console log.
3. **`lib/__tests__/no-mock-data.test.ts`** — asserts the API key appears nowhere in
   committed source and is read only through `requireApiKey`, i.e. from exactly one
   place. It also refuses any fixture import or invented-number fallback, so the
   numbers above cannot quietly become fabricated ones.

Diagnostics are the residual risk, and are handled explicitly: the local harness log
(`docs/evidence/enclave-local-run.log`) is grepped for the API key, key-bearing
gateway URLs, any 40-hex address, and `SENTINEL_RISK_POLICY` on every regeneration.
The current log matches **zero** of them, and the run's own last line is
`OK: no address appears in the handler output.`

---

## After the boundary: the consumer

The enclave's guarantee ends when the report leaves it. From there the report is bytes
on an untrusted path, and a consumer that decodes without authenticating has gained
nothing from the TEE — it would act on numbers anyone could write.

`lib/signal/consume.ts` is the other half. It depends on **viem only**, so reading a
Sentinel signal does not require installing the CRE toolchain. It re-implements exactly
what the SDK does, read out of `@chainlink/cre-sdk/dist/sdk/report.js`:

- the **109-byte** metadata header, parsed at fixed offsets — version 0, executionId 1,
  timestamp 33, donId 37, donConfigVersion 41, workflowId 45, workflowName 77 (ten
  bytes, NUL-padded), workflowOwner 87, reportId 107, body from 109;
- `reportHash = keccak256(keccak256(rawReport) ‖ reportContext)`;
- **`f + 1` distinct** recovered signers from a pinned set, 65-byte signatures, `v` of
  27/28 normalized.

And then four checks that are the consumer's own, not the DON's:

| Check | The attack it stops |
|---|---|
| `workflowOwner` and `workflowName` must match the trusted pair | The subtle forgery. The DON signs whatever it runs, so an attacker only needs to deploy *their own* workflow to get a real signature on fabricated numbers. A consumer that checks signatures but not provenance accepts it. |
| `f + 1` **distinct** signers | One compromised node replaying its own signature to reach quorum alone. |
| `version` must be known | Field order *is* the ABI. An unknown version decoded anyway yields plausible numbers in the wrong slots — worse than an error, because it looks like data. |
| `asOfBlock` within `maxBlockAge`, non-zero, not ahead of head | A genuine but stale reading replayed later, and a report whose provenance is unverifiable. Staleness binds on the block the *data* was read at, not the report timestamp: a DON can re-sign an old reading at any time, so the timestamp says when someone last spoke and the block says when the world was last observed. |

One detail worth knowing when reading rejection messages: ECDSA recovery over the wrong
bytes does not fail, it succeeds and returns an unrelated address. So a tampered report
surfaces as `unknown signer`, not `bad signature` — the **pinned signer set** is what
catches tampering, which is why pinning it is not optional.

`npm run consume-signal` demonstrates one accept and seven refusals against the real
payload from the recorded live run; output in `docs/evidence/consume-signal.md`.

## What is not yet proven

Honest limits, so nothing above is read as more than it is:

- **No Nitro attestation has been verified end to end.** `cre workflow simulate` is
  login-gated and the workflow is not deployed, so the evidence is a local harness that
  runs every line of `workflow.ts` against the live gateway with the secrets from
  `cre/.env` — and says so in its own header: `attestation NONE — this is not a TEE`.
- **The signatures in `consume-signal` are throwaway dev keys**
  (`lib/signal/dev-sign.ts`), because a DON cannot sign a report for a workflow that
  has not been deployed. The payload, wire format, hash construction, quorum rule and
  every check are real; substituting the registry-published signer set is a config
  change, not a code change.
