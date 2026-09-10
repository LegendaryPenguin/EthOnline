# Sentinel — Build Plan

**A confidential systemic-risk oracle for DeFi lending.**

Sentinel measures something no lending protocol can see: how much of the borrowed
value in DeFi sits with addresses that are levered across *multiple* protocols on the
*same* collateral. That is the mechanism behind every cascading bad-debt event — and
nobody publishes it, because publishing per-address leverage maps is itself the harm.

So we compute it inside a TEE and publish only the aggregate.

---

## Target tracks (3 max)

| Track | Pool | Slots |
|---|---|---|
| The Graph — Best Use of Composable or Standardized Graph Products | $5,000 | 3 |
| The Graph — Best AI Tooling or AI Use Case (From Scratch) | $5,000 | 3 |
| Chainlink — Best Confidential Workflow | $2,000 | 2 |

**$12,000 across 8 winning slots.**

## Verified foundations

Checked before planning, not assumed:

- `schema-lending.graphql` (Messari Lending/CDP 3.1.0) exposes `Account.id: Bytes!` —
  the raw address. Identical key in every protocol's subgraph, so the cross-protocol
  join is a primary-key join, not heuristic matching.
- `Position { account, market, asset, side, isCollateral, balance, principal }`
- `Market { maximumLTV, liquidationThreshold, liquidationPenalty, inputTokenPriceUSD }`
  — the full risk-parameter set, so health factors are computable from standard fields.
- `Account.liquidations` (as liquidatee) + the `Liquidate` event entity — **real
  historical liquidations as ground truth**, which makes the risk model backtestable
  rather than merely assertable.

## Known risks

| Risk | Impact | Mitigation |
|---|---|---|
| `messari/subgraphs` last shipped 2025-03; deployments may be unsynced | "live data" is a hard qualification bar | Fallback: author conformant subgraphs ourselves — the prize explicitly scopes in "authoring or extending a Standardized Subgraph". Scores better, costs time. |
| Both Graph tracks may not accept one project | loses $5,000 | Confirm in Discord. Fallback: Uniswap Stack ($3,000/3 slots) with a v4 hook consuming the signal. |
| Cross-protocol overlap may be rarer than expected | weakens the headline claim | Phase 2 quantifies it early and honestly; if overlap is thin, the finding pivots to per-asset collateral crowding, which uses the same engine. |
| CRE Confidential tooling is new | loses $2,000 | CLI *simulation* satisfies the requirement — no deployment needed. De-risked to a local run. |

## Non-negotiables

- **No mocked data in the product path.** Fixtures exist only for unit tests. Every
  number shown in the UI or the video comes from a live query, with block number and
  timestamp recorded.
- **Fresh code.** No files copied from any prior project. Prior work disclosed in
  writing to ETHGlobal regardless.
- **Granular commit history.** ETHGlobal defaults single-large-commit repos to
  unqualified.
- **Honest reporting.** Backtest misses get published alongside hits.

---

# Phase 1 — Live data spine

**Goal:** one query shape, many protocols, real data, proven.

**Work**
- Resolve synced Messari Lending/CDP deployments via Graph Explorer; record subgraph
  IDs, networks, and sync lag.
- Typed GraphQL client against the real schema (codegen from `schema-lending.graphql`).
- A single query *document* executed unmodified across every protocol endpoint.
- Snapshot recorder: persists each response with block number + timestamp for audit.

**Acceptance criteria**
- [ ] One unmodified query document returns non-empty `Position` data from **≥3
      distinct lending protocols**.
- [ ] Sync lag logged per deployment; any deployment >1000 blocks behind head is
      excluded with the reason recorded.
- [ ] Zero mocked data in `lib/` product paths — enforced by a test that greps for
      fixture imports outside `__tests__`.
- [ ] `npm run snapshot` writes an auditable JSON snapshot with provenance metadata.
- [ ] Query cost measured; a full refresh completes under 30s.

**Blocked on:** Subgraph Studio API key.

---

# Phase 2 — Cross-protocol exposure graph

**Goal:** produce the headline number.

**Work**
- Address-keyed join of positions across all protocols into one exposure graph
  (accounts ↔ markets, typed as a bipartite graph).
- Per-address aggregation: total collateral USD, total debt USD, per-asset breakdown,
  protocol count.
- Coverage report quantifying multi-protocol leverage.

**Acceptance criteria**
- [ ] ≥1 address with live positions on **≥2 distinct protocols**, verified by hand
      against a block explorer (screenshot committed to `docs/verification/`).
- [ ] The join is purely address-keyed — no fuzzy or heuristic matching anywhere.
- [ ] Coverage report emits the money-shot metric: **"X% of borrowed value sits with
      addresses levered across 2+ protocols."**
- [ ] Unit tests cover the join on fixtures, including the collision and
      single-protocol edge cases.
- [ ] Report is deterministic — same snapshot in, same numbers out.

---

# Phase 3 — Risk engine

**Goal:** health factors and shock response, validated against reality.

**Work**
- Per-position health factor from `liquidationThreshold`, `balance`,
  `inputTokenPriceUSD`.
- Shock simulator: apply a price vector to collateral assets, recompute health,
  emit the liquidatable set.
- **Backtest harness**: run the engine at the block *before* a real `Liquidate` event
  and check whether the liquidatee was flagged.

**Acceptance criteria**
- [ ] Health factors reconcile with each protocol's own reported values within 1% on
      a 20-position sample.
- [ ] Engine is deterministic and pure — no network calls inside the computation.
- [ ] **Backtest: ≥50 real historical `Liquidate` events replayed**, with precision,
      recall, and false-positive rate published in `docs/BACKTEST.md`.
- [ ] Misses are documented with root-cause analysis, not omitted.
- [ ] Monotonicity property test: larger shock never produces a smaller liquidatable set.

---

# Phase 4 — Cascade model

**Goal:** second-order contagion, priced off real DEX liquidity.

**Work**
- Multi-round simulation: liquidations → forced selling → price impact → new
  liquidations → repeat to convergence.
- Price impact sourced from the **DEX AMM standardized schema** — a *second*
  standardized schema, deepening the standards-leverage story.
- Protocol×protocol coupling matrix from shared borrowers and shared collateral.
- Split total damage into `systemic` (cascade-driven) vs `idiosyncratic` (first-round).

**Acceptance criteria**
- [ ] Simulation converges on all live snapshots; hard iteration cap with a logged
      non-convergence path.
- [ ] Output includes rounds-to-convergence, liquidation volume per protocol per
      round, and the systemic/idiosyncratic split.
- [ ] Coupling matrix is symmetric where the definition requires it; asymmetry is
      justified in code comments where intended.
- [ ] Sensitivity table across shock magnitudes {5,10,15,20,30}% committed.
- [ ] Uses two distinct standardized schemas (Lending/CDP + DEX AMM) — documented
      with the specific fields consumed from each.

---

# Phase 5 — Confidential aggregation (CRE)

**Goal:** the enclave earns its place.

**Work**
- CRE workflow with `handlerInTee` wrapping the exposure aggregation.
- Private inputs: per-address positions **and** the risk policy parameters
  (thresholds, shock vectors, weighting).
- Public output: aggregate risk signal only — never a per-address row.
- Explicit enclave boundary manifest.

**Acceptance criteria**
- [ ] `handlerInTee` registered and used; TEE handles the aggregation, not a
      placeholder side-path.
- [ ] CRE CLI simulation succeeds; full terminal logs captured to
      `docs/evidence/cre-simulation.log`.
- [ ] `docs/ENCLAVE.md` enumerates every field crossing the boundary, in and out.
- [ ] **Leak demo**: a documented run with the TEE bypassed shows per-address
      exposure escaping — proving the enclave is load-bearing, not decorative.
- [ ] Attested output is consumed downstream; a tampered attestation is rejected.

---

# Phase 6 — Early-warning validation

**Goal:** the credibility anchor. Not "this could work" — *this did*.

**Work**
- Identify the largest real liquidation cascades in the historical data.
- Replay Sentinel at T−1h, T−6h, T−24h, T−72h before each.
- Compute lead time: how far ahead did cascade risk go abnormal?
- ROC/AUC over a labeled window set, with a naive baseline for comparison.

**Acceptance criteria**
- [ ] **≥3 historical cascade events replayed** end-to-end.
- [ ] Median and per-event **lead time** reported in hours.
- [ ] ROC curve + AUC against a labeled set, benchmarked against a naive
      "total-TVL-only" baseline — Sentinel must beat it.
- [ ] Reproducible by a single command: `npm run backtest:cascades`.
- [ ] **Failures published**, including any event Sentinel missed and why.
- [ ] No lookahead leakage — a test asserts the replay reads no data past the
      simulated block.

---

# Phase 7 — Agent + natural-language interrogation

**Goal:** meaningful reasoning and autonomous decisions, not query printing.

**Work**
- Agent with real tools: `querySubgraphs` (via **Subgraph MCP** — the composed second
  Graph product), `runShockScenario`, `explainExposure`, `compareProtocols`.
- Natural-language interface: *"What happens to Aave if stETH drops 15%?"* → runs the
  actual simulation, answers with sourced numbers and block provenance.
- **Autonomous monitor**: a decision policy that judges when risk warrants an alert —
  not a fixed cron. It decides *whether*, *what severity*, and *why*.

**Acceptance criteria**
- [ ] ≥8 natural-language questions answered correctly, each citing subgraph source +
      block number; transcript committed.
- [ ] Every agent answer traces to a real tool call — a test fails the build if any
      number in a response is unsourced.
- [ ] Alert policy documented, and demonstrated firing correctly on replayed history
      from Phase 6 (right alerts, at the right times).
- [ ] Agent refuses to answer when data is stale or coverage is insufficient, rather
      than guessing.
- [ ] Graph product composition documented: Subgraphs + Subgraph MCP, with the role
      of each.

---

# Phase 8 — The oracle: publish the signal, prove reuse

**Goal:** reusable infrastructure, not a single end-user app. (Explicit Graph AI requirement.)

**Work**
- Versioned public signal with a documented JSON schema and stable semantics.
- Signed/attested feed derived from the Phase 5 TEE output.
- A thin consumer SDK.
- **Two independent consumers** to prove reusability: (a) a Solidity contract that
  changes behavior on the signal, tested on a Foundry fork; (b) a webhook/CLI consumer.

**Acceptance criteria**
- [ ] Signal schema versioned and documented in `docs/SIGNAL.md` with field semantics
      and update cadence.
- [ ] Consumer contract reads the attested signal and demonstrably alters behavior;
      `forge test --fork-url` passes.
- [ ] Contract rejects stale and tampered signals — negative tests included.
- [ ] Second, independent consumer works against the same schema with no changes to
      the producer.
- [ ] A third party could integrate from `docs/SIGNAL.md` alone — validated by writing
      the second consumer *only* from the doc.

---

# Phase 9 — The interface

**Goal:** the visual centerpiece. Make contagion legible at a glance.

**Work**
- Animated contagion graph: accounts and markets as nodes, edges weighted by exposure,
  cascade propagating in rounds.
- Live shock slider — drag to 20% and watch the cascade unfold.
- Protocol coupling heatmap.
- Cascade timeline: rounds, volume, which protocol absorbs which loss.
- Design system built fresh (no copied assets), with a `/styleguide` route.

**Acceptance criteria**
- [ ] Shock slider stays ≥55fps on live data (measured, not eyeballed).
- [ ] Renders from a **live snapshot**, not fixtures.
- [ ] Accessible: full keyboard operation, `prefers-reduced-motion` honored, WCAG AA
      contrast verified by automated check.
- [ ] Light and dark both correct.
- [ ] Loading, empty, stale-data, and error states all explicitly designed — no
      unhandled spinner-forever path.
- [ ] `/styleguide` documents every token and component.
- [ ] Charts follow the project dataviz rules; no default library palettes.

---

# Phase 10 — Polished full working flow + submission

**Goal:** a stranger clones it and everything works. Then we win the video.

**Work**
- One-command cold start; `.env.example` complete; preflight check that validates
  the API key and reports sync status before anything else runs.
- README with architecture diagram, the headline finding, and per-track evidence maps.
- `docs/EVIDENCE.md` mapping **every prize bullet → file:line + artifact**.
- Prior-work disclosure to ETHGlobal.
- **Video**: Playwright records 1080p app walkthroughs + terminal capture of the CRE
  simulation; HTML-rendered title cards and lower-thirds; styled ASS captions burned
  in; ffmpeg edit with cuts, crossfades, speed ramps over slow queries, freeze-frame
  on the headline number.

**Acceptance criteria**
- [ ] **Fresh-clone test passes on a clean checkout**: clone → `npm i` → set one key →
      `npm run verify` → live data, TEE sim, signal, consumer, and UI all green.
- [ ] Preflight fails loudly and usefully on a bad/missing key — never a silent
      fallback to mock data.
- [ ] Every acceptance criterion from Phases 1–9 re-verified green in one run.
- [ ] `docs/EVIDENCE.md` maps all three tracks' bullets to concrete artifacts.
- [ ] Video is **2:00–4:00**, 1080p, captioned, edited, with no dead air; script
      approved before render.
- [ ] Video shows: the headline finding, one query spanning many protocols, the TEE
      simulation logs, the backtest result with lead time, the cascade animation, and
      a consumer reacting to the signal.
- [ ] No secrets in git history (scanned).
- [ ] Commit history granular and honest across the whole build.
- [ ] Three submission drafts written, each in the sponsor's own vocabulary.
- [ ] Full flow completes in under 60s from cold start on live data.

---

## Time budget (48h solo, agent-driven)

| Phases | Hours | Notes |
|---|---|---|
| 1–2 | 6 | blocked on API key; the headline number lands here |
| 3–4 | 10 | the real intellectual work |
| 5 | 5 | you have the CRE pattern already |
| 6 | 6 | highest judge-impact hours in the plan |
| 7 | 6 | |
| 8 | 4 | |
| 9 | 7 | |
| 10 | 4 | video render + submissions |

**Cut order if time runs short:** Phase 8's second consumer → Phase 4's coupling
matrix → Phase 6 drops to 1 replayed event. Phases 1–3, 5, 9, 10 are load-bearing and
do not get cut.

## What we need from you

1. **Subgraph Studio API key** — the only hard blocker.
2. Confirm in Discord whether one project may enter both Graph tracks.
3. Approve the video script before render (Phase 10).
