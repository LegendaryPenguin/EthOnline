# Sentinel

**A confidential systemic-risk oracle for DeFi lending.**

Sentinel measures one number that nobody currently publishes: **how much borrowed value sits with
addresses that are levered across *multiple* lending protocols on the *same* collateral.** That is
the debt that liquidates twice in one price move, and it is where a cascade starts.

The measurement is easy to state and impossible to publish safely. Getting it requires a
per-address map of who is levered where — and that map is a hunting list for liquidation bots and
a deanonymization aid for everyone else. **So Sentinel computes it inside a TEE and publishes only
the aggregate.** The private intermediate value never leaves the enclave.

On live mainnet data, 2026-09-13, at block 25,966,506 — the run in the demo video, and the run
`npm run verify` reproduces:

| | |
|---|---|
| accounts scanned across 5 lending protocols | **37,862** |
| borrowing at 2 protocols | 1,042 |
| at 3 | 72 |
| at 4 | 2 |
| **debt levered across >1 protocol on the same collateral** | **$35.9M** — 125 bps of evaluable debt |
| composite systemic risk score | 2201 bps *(a level that is only meaningful as a change; see `docs/SIGNAL.md`)* |

Every figure here moves with the chain, which is the point: these are readings, not constants. The
shape of the finding does not move — a four-figure population of addresses, low single-digit
percentages of debt, and a number nobody else publishes.

No mock mode exists. `lib/__tests__/no-mock-data.test.ts` fails the build if one appears.

---

## Architecture

```
   ┌────────────────────────── The Graph gateway ──────────────────────────┐
   │  Messari Lending/CDP schema          Messari DEX AMM schema           │
   │  Aave V3 · Aave V2 · Compound V3     Uniswap V3 · SushiSwap V2/V3     │
   │  Compound V2 · Morpho Aave V2        Curve                            │
   │  → risk params, positions, debt      → exit liquidity / pool depth    │
   └───────────────┬───────────────────────────────┬───────────────────────┘
                   │  one query document,          │  636 depth queries,
                   │  byte-identical per protocol  │  159 pairs, deduped by poolId
                   ▼                               ▼
   ╔═══════════════════════ Chainlink CRE — inside the enclave ════════════════════════╗
   ║  cre.handlerInTee(cron, onCronTrigger, [{ tee: 'nitro' }])                        ║
   ║                                                                                  ║
   ║   Vault secrets ──▶ GRAPH_API_KEY          (never reaches Workflow DON memory)    ║
   ║                 ──▶ SENTINEL_RISK_POLICY   (thresholds are themselves sensitive)   ║
   ║                                                                                  ║
   ║   raw Position rows  ──▶  per-address cross-protocol leverage map                 ║
   ║   (37,862 accounts)         ▲ THE PRIVATE INTERMEDIATE VALUE — never emitted      ║
   ║                             │                                                    ║
   ║                        aggregate · k-anonymity suppress · sign                    ║
   ╚═════════════════════════════════════╪════════════════════════════════════════════╝
                                         │  12 aggregate fields + signer quorum
                    ┌────────────────────┴────────────────────┐
                    ▼                    ▼                    ▼
            Next.js dashboard     GuardedVault.sol      MCP server + SKILL.md
            cascade + shock       pauses new borrowing   8 tools, every figure
            explorer, 60 fps      under alert            cited to block + subgraph
```

Three consumers, one signal. The dashboard verifies the signer quorum before rendering a single
figure; `npm run check:ui` proves **zero** 40-hex strings cross the wire on either route.

---

## Run it

```sh
cp .env.example .env.local     # GRAPH_API_KEY + SENTINEL_RISK_POLICY, both documented in the file
npm install
npm run preflight              # does your setup produce real numbers? checks key, sync lag, artifacts
npm run verify                 # 18 stages, live, ~2 min — re-verifies every claim in this README
npm run dev                    # the dashboard
```

`npm run verify -- --fast` skips the two slowest stages and says so in its summary, so a fast run
can never be mistaken for a full one.

Three toolchains are not vendored, and preflight names each one before anything runs: **bun** (the
CRE workflow is a bun package with its own lockfile — `npm install` does not reach it, so the
`cre:*` scripts install it themselves), **forge** for the Solidity consumer, and the **cre** CLI for
the TEE simulation. Only bun is blocking; the other two gate stages that skip with a reason.

Last full run: **18 stages green, 120.5s total** (`docs/evidence/casts/verify.json` — the run in
the video). The cold-start flow — API key to rendered dashboard — took **61.4s**, so it straddles
the 60-second target we set ourselves and misses it on some runs. One gateway-bound stage accounts
for nearly all of it: `cascade` makes 636 live DEX-depth queries and took 47.5s of the 120.5s.
Measured in `docs/EVIDENCE.md`.

## The interesting parts

**One query document, five protocols.** `Account.id` is `Bytes!` — the raw address — and it is the
same key in every Messari subgraph, so the cross-protocol join is a primary-key join rather than
heuristic address matching. That is the only reason this project can exist. Adding a sixth lending
protocol means adding a row to `lib/graph/deployments.ts`: no adapter, no new query, no mapping
code.

**Aave V2 is registered on purpose and rejected at runtime on purpose.** Its mappings handle
`Borrow` but not `Repay`, so `balance` is lifetime cumulative borrowing and overstates outstanding
debt by three orders of magnitude — 1925× on one snapshot, 1011× on another. The multiple moves
with whichever positions the sample draws; the gate keys on the part that doesn't move, which is
that a subset cannot exceed its own total. Zero Aave-specific code, and the reason is recorded in
provenance. Keeping that row is the evidence the gate does something.

**Where the standard breaks down is quantified, not ignored.** Aave V3 E-Mode is absent from the
standardized schema, so 116 of 360 completed multi-protocol borrowers compute as `HF < 1` while
being live and un-liquidated, carrying $1.07B. That is our parameters being wrong, not those
borrowers being unsafe — so every distress figure on the dashboard is printed as a **bound**.

**The refusals live in the server, not in a prompt.** Ask the agent tools for the per-address
leverage map — the actual thing this project computes — and they refuse, so the refusal survives an
adversarial user. The SKILL's one rule is that no number may be stated which a tool did not
return, down to forbidding rounding and derived arithmetic.

**`npm run leak-demo` argues the confidentiality boundary in the negative:** exactly what the
enclave withholds, and what an attacker gains if you remove it. The recorded report suppresses 3
of its coupling buckets under k-anonymity and publishes 0 rather than a number that would identify
someone. Suppression that never fires is decoration.

## What this is not

Listed here rather than buried, because it is the fastest way to judge the rest:

- We **consume** two standardized schemas; we did not author or extend one.
- `sampleCoverageOfReported` is **13.97%**, not 62.66% (that is a different quantity —
  `multiProtocolDebtShareOfSample`). Conflating them would inflate the project 4.5×.
- The composite score's **level** is not comparable across months; only its change is.
- Distress figures are bounds, not point estimates.
- The backtest **publishes its misses**, and only 2 of 5 deployments support time-travel queries,
  so it replays 96 of 319 liquidation episodes.
- The CRE CLI **simulation passes** (`npm run cre:simulate`, transcript in
  `docs/evidence/cre-simulation.log`). We have **not** deployed to the CRE network — that needs
  deploy access, and the track scopes in either one.

## Docs

| | |
|---|---|
| `docs/EVIDENCE.md` | every track's qualification bullets → file, line, artifact |
| `docs/TRACKS.md` | those bullets quoted verbatim, so the above can be checked |
| `docs/ENCLAVE.md` | the confidentiality boundary, field by field |
| `docs/SIGNAL.md` | the 12 published fields and what each one means |
| `docs/AGENT.md` | the MCP tools and why they constrain the model |
| `docs/BACKTEST.md` | recall over replayed liquidations, hits and misses; lead time is in `docs/evidence/phase6-early-warning.md` |
| `docs/DATAVIZ.md` | the design system's rules and the reason for each |
| `docs/DISCLOSURE.md` | prior-work disclosure, unprompted |
| `docs/evidence/` | the raw artifacts every claim above is drawn from |

## Tracks

The Graph — Best Use of Composable or Standardized Graph Products · The Graph — Best AI Tooling or
AI Use Case (Start Fresh) · Chainlink — Best Confidential Workflow.

Built solo during ETHOnline 2026 with Claude Code, stated plainly in `docs/DISCLOSURE.md`.
