# CRE simulation — the confidential workflow, executed

The Chainlink track asks for evidence of a successful execution: *"A Confidential Workflow
simulation using the CRE CLI or a live deployment on the CRE network."* This is the simulation,
and it passed.

Full transcript: **`docs/evidence/cre-simulation.log`** (redacted — see the warning at the bottom,
which matters).

## Reproduce it

```sh
export PATH="$HOME/.cre/bin:$PATH"
cre login                       # interactive, opens a browser
npm run cre:simulate            # wraps the CLI and redacts the log; see the warning below
```

The wrapper runs exactly this, and nothing else:

```sh
cd cre && cre workflow simulate ./sentinel-signal --target staging-settings -g
```

`-g` enables engine logging, which is what makes the TEE handler's lifecycle visible rather than
only its return value.

## What the run proves

**The simulator itself confirms the handler was dispatched for TEE execution** — this is the CLI's
output, not ours:

```
╭────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Trigger requested TEE Execution your trigger will run in one of the following Tees:                │
│     - AWS Nitro in us-west-2                                                                       │
│ The simulator is not a real TEE, and is meant to debug.                                            │
│ Do not use it for sensitive information.                                                           │
│ During real execution, user logs for this trigger will not be visible, and will not leave the TEE. │
│ They are presented in the simulator for debugging only.                                            │
╰────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

That box is worth reading twice, because it independently corroborates the central design claim of
this project: **in real execution the handler's logs do not leave the enclave.** The two `[USER LOG]`
lines below are visible *only* because this is the debug simulator. On the DON, the per-address
leverage map they summarise would be unobservable — which is exactly why the aggregation was put
here in the first place.

The workflow compiled, registered its trigger, ran end to end against live subgraphs, and returned:

```
2026-09-13T01:47:44Z [USER LOG] enclave: 90 borrowers, score 22.0, 0 coupling buckets,
                                3 suppressed, 1 deployment notes
2026-09-13T01:47:44Z [USER LOG] enclave: aave-v2-eth excluded at discovery: sampled debt is
                                1011.0x the protocol-reported total, so its position mappings
                                disagree with its own totals

✓ Workflow Simulation Result:
"score 22.0/100, block 25966510, 4 protocols, 90 borrowers, 1.25% of evaluable debt is
 multi-protocol, 2867M USD evaluable of 5718M observed, 1215254005 USD distressed at the
 deepest shock, 3 buckets suppressed for k-anonymity, 1 deployment notes"

2026-09-13T01:47:44Z [SIMULATION] Execution finished signal received
```

Exit code 0. Reading that result against the track's bullets:

| Bullet | What the transcript shows |
|---|---|
| registers and uses a confidential TEE handler | the CLI's own "Trigger requested TEE Execution … AWS Nitro in us-west-2" box |
| processes a **secret** in the enclave | `Loaded secrets from ../secrets.yaml`; both `GRAPH_API_KEY` and `SENTINEL_RISK_POLICY` resolve inside the handler |
| processes a **confidential API response** | 4 live Messari deployments queried at block 25966510 from inside the handler |
| processes a **private intermediate value** | 90 multi-protocol borrowers aggregated; the per-address map is never in the result string |
| **meaningfully integrated**, not a placeholder | the reconciliation gate fires *inside* the enclave and excludes `aave-v2-eth` on its own evidence; k-anonymity withholds 3 of the coupling buckets. Both are real decisions taken on data the operator cannot see. |
| successful execution with evidence | exit 0, full transcript committed |

Note the k-anonymity suppression firing at **3 buckets** and independently agreeing with the local
enclave run. Suppression that never fires would be decoration.

Also note `1011.0x` where `docs/evidence/phase2-cross-protocol.md` recorded `1925x`. Both are real;
the multiple moves with whichever positions the sample draws. The gate keys on the invariant — a
subset cannot exceed its own total — not on the size of the miss.

## Deployment, as distinct from simulation

`cre whoami` reports **Deploy Access: Not enabled**, and `cre account access` is the request path.
The track scopes in simulation *or* deployment, so this is not outstanding work; it is the other
branch of the same requirement. Deployment would additionally need `CRE_ETH_PRIVATE_KEY` in
`cre/.env`, which is gitignored and never printed.

## ⚠️ The simulator's debug mode prints your API key

Found the hard way, and recorded because anyone reproducing this hits it too:

**With `-g`, the engine logs full outbound request URLs. The Graph gateway embeds the API key as a
path segment, so the raw log contained the live key 28 times.**

The committed transcript is redacted. `npm run cre:simulate` performs that redaction as part of the
run rather than leaving it to whoever remembers, because a log that leaks a key is exactly the
class of mistake this whole project is about. Consequences:

- Never commit a raw `cre workflow simulate -g` log.
- Never put one on screen — it is excluded from the demo recording for this reason.
- If you have run one, treat the key as disclosed and rotate it.

Two other warnings the CLI raised, both benign and both left alone deliberately:

- *Secret "GRAPH_API_KEY" uses itself as the env var name.* The CLI suggests a `CRE_`-prefixed
  alias. Left as-is so the name matches `.env.example` and the rest of the repo; one name for one
  secret is worth more here than the CLI's preference.
- *`[ethereum-testnet-sepolia]` failed RPC health check.* A public RPC endpoint timing out. Sentinel
  reads its data from The Graph, not from that RPC, so it does not affect the run — and the
  transcript keeps the warning rather than hiding it.
