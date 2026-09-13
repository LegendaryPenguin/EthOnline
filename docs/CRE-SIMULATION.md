# `cre workflow simulate` — the exact command, and where it is blocked

The Chainlink track accepts *either* a CLI simulation *or* a live deployment as proof of
execution. This document records exactly where we are on that, so nothing in
`docs/EVIDENCE.md` has to be taken on trust.

## Status

The CRE CLI is installed and the workflow is complete and typechecked against the real SDK. The
simulation is blocked on **authentication**, which needs the account holder at a browser — not
on anything about the workflow.

```
$ cre workflow simulate ./sentinel-signal --target staging-settings
Initializing...

! You are not logged in

✗ Authentication required: not logged in and no CRE_API_KEY set
  → Run 'cre login' interactively, or
  → Set CRE_API_KEY environment variable for non-interactive use
✗ authentication required: no credentials found: you are not logged in, run cre login and try again
```

Recorded verbatim on 2026-09-13.

## To finish it

```sh
export PATH="$HOME/.cre/bin:$PATH"
cre login                      # interactive; opens a browser
cd cre
cre workflow simulate ./sentinel-signal --target staging-settings -g \
  2>&1 | tee ../docs/evidence/cre-simulation.log
```

`-g` enables non-fatal engine logging, which is what makes the TEE handler's own lifecycle
visible in the transcript rather than only its result.

Two other things are needed for a *deployment* (not for a simulation):

1. **Confidential Workflows access.** Gated behind an access request form at the time of
   writing. The simulation path is what the track scopes in ("A Confidential Workflow simulation
   using the CRE CLI **or** a live deployment on the CRE network"), so this is not on the
   critical path.
2. `CRE_ETH_PRIVATE_KEY` in `cre/.env`, which is gitignored and never printed.

## What already stands in for it

Not a substitute for the CLI transcript, and not presented as one — but not nothing either:

| Evidence | Command | What it proves |
|---|---|---|
| `docs/evidence/enclave-local-run.log` | `npm run cre:test` (see `cre/sentinel-signal/local-run.ts`) | the handler runs end to end: both Vault secrets, the live gateway queries, the aggregation, k-anonymity suppression, and the signed report |
| workflow test suite | `npm run cre:test` | aggregation and suppression behaviour, including the buckets that get withheld |
| SDK typecheck | `npm run cre:typecheck` | `cre.handlerInTee`, `TeeRuntime<Config>`, `runtime.getSecret` all typecheck against the shipped SDK, so the confidential API is used as specified rather than approximated |
| `docs/ENCLAVE.md` | — | the confidentiality boundary field by field: what leaves the enclave and why each field is safe to publish |

The local run exercises the same `onCronTrigger` function the DON would invoke, through the same
`TeeRuntime` interface. What it cannot prove is attestation — that the code ran inside a real
Nitro enclave. That is precisely what the CLI simulation adds, which is why it is worth
finishing rather than arguing around.
