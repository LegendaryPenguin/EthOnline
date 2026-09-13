# Demo video — script for approval

**Target:** 3:34, 1080p (1920×1080), 30 fps, burned-in captions, no voiceover required
(captions carry the narrative; music bed optional and quiet).
**Constraint the script is written against:** every frame is real footage of this repo — a live
terminal, the running dashboard, or a real file on screen. Nothing is mocked up for the camera.

**Proof rules (these drive the whole edit).** Six of the eight sections are terminal footage,
because a claim that runs is worth more than a claim that is stated:

1. **Every claim that has a command gets its command on screen.** The command is *typed and
   visible* before it runs — the frame shows `$ npm run cre:test`, not just its output. A judge
   should be able to pause, read the command, and run it themselves.
2. **A run is never cut mid-flight.** Speed-ramping a wait is fine; cutting from a command to a
   result is not, because that is exactly the edit that would let us fake one. Where a stage takes
   too long for the runtime, the ramp is visibly marked on screen (`⏩ 4×`) so the viewer knows
   nothing was removed.
3. **Results are shown at 1× and held**, long enough to read the actual numbers.
4. **Exit codes are in frame.** The prompt returning cleanly after each command is part of the
   proof; nothing is trimmed at the point where a failure would appear.
5. **Nothing is re-run for a prettier number.** Whatever the live run says is what ships in the
   caption, and if it disagrees with this script the caption changes, not the run.

**Approve or edit this before I render.** Nothing gets recorded until you say so.

---

## Shot list

Timings are cumulative. `CAPTION` is the on-screen text, verbatim. `SHOT` is what the frame shows.
Everything under `ASSET` already exists in the repo unless marked **[record]**.

---

### 1 — The number nobody publishes (0:00 → 0:22)

| | |
|---|---|
| **SHOT** | Black. Text only, one line at a time, centred, large. Then hard cut to the dashboard hero figure. |
| **CAPTION 1** | `Every lending protocol knows its own risk.` |
| **CAPTION 2** | `None of them know how much of their debt is levered somewhere else too.` |
| **CAPTION 3** | `That's the debt that liquidates twice in one price move.` |
| **ASSET** | `docs/evidence/screens/dashboard-dark.png` for the hard cut, held 3s on the `$35,923,754` figure with a subtle push-in. |

### 2 — Measured, live, across five protocols (0:22 → 0:52)

| | |
|---|---|
| **SHOT** | Split: left, `lib/graph/queries.ts` scrolling slowly to the `positionsQuery` doc-comment. Right, a live terminal with `$ npm run snapshot` typed and running — real output streaming, 5 deployments resolving, the reconciliation gate firing on Aave V2, ending on the returning prompt. |
| **CAPTION 1** | `One query document. Five lending protocols. Byte-identical against each.` |
| **CAPTION 2** | `Messari standardized schemas — so Account.id is the raw address in all of them.` |
| **CAPTION 3** | `The cross-protocol join is a primary-key join, not address guesswork. That's the whole trick.` |
| **CAPTION 4** | *(as the gate fires)* `Aave V2 is registered on purpose and rejected on purpose — its subgraph never handles Repay, so debt reads 1925× high. Zero Aave-specific code caught it.` |
| **ASSET** | **[record]** terminal capture of `npm run snapshot`; speed-ramped 4× where it's just waiting. |

### 3 — Why the raw answer can't be published (0:52 → 1:24)

| | |
|---|---|
| **SHOT** | Live terminal, `$ npm run leak-demo` typed and run uncut. Let the withheld/published columns land on screen at 1×. Then a still of `docs/ENCLAVE.md`'s boundary table. |
| **CAPTION 1** | `To compute that number you first need a per-address map of who is levered where.` |
| **CAPTION 2** | `Publish that map and you've published a hunting list for liquidation bots — and a deanonymization aid for everyone else.` |
| **CAPTION 3** | `So the map is the one thing that never leaves.` |
| **CAPTION 4** | `k-anonymity suppression on the output: 3 coupling buckets withheld, because fewer than k accounts stood behind them. Suppression that never fires is decoration.` |
| **ASSET** | **[record]** `npm run leak-demo`; still of `docs/ENCLAVE.md`. |

### 4 — Chainlink CRE: the aggregation runs in the enclave (1:24 → 2:06)

The longest section, and the most terminal-heavy, because "the confidential part actually executes"
is the entire ask of this track and a source screenshot does not demonstrate execution.

| | |
|---|---|
| **SHOT 4a** *(source, ~8s)* | `cre/sentinel-signal/workflow.ts` at line 534, `cre.handlerInTee` highlighted. Cut to lines 157–158, the two `getSecret` calls highlighted. Filename and line numbers visible in frame so each can be checked. |
| **CAPTION 1** | `handlerInTee, not handler. There is no non-TEE path in this workflow.` |
| **CAPTION 2** | `Both secrets are fetched from the Vault DON inside the enclave — the gateway API key, and the risk policy itself. Publish a threshold and a borrower sits one basis point under it.` |
| **SHOT 4b** *(terminal, ~10s)* | `$ npm run cre:typecheck` typed and run, uncut, to a clean exit. |
| **CAPTION 3** | `It compiles against the real CRE SDK — handlerInTee, TeeRuntime<Config>, getSecret. Not an approximation of the confidential API.` |
| **SHOT 4c** *(terminal, ~16s)* | `$ npm run cre:test` typed and run, uncut. Hold at 1× on the section of output where both Vault secrets resolve, the live gateway queries run, the aggregate is computed, buckets are suppressed, and the report is signed. Then the passing test count and the returning prompt. |
| **CAPTION 4** | `In: 37,866 raw position rows, and a per-address leverage map computed in the enclave.` |
| **CAPTION 5** | `Out: 12 aggregate fields, signed. The map is not one of them.` |
| **SHOT 4d** *(terminal, ~8s)* | `$ cre workflow simulate ./sentinel-signal --target staging-settings` typed and run — **including the run that fails**, if `cre login` hasn't happened by render time. The auth error stays in frame. |
| **CAPTION 6** *(if blocked)* | `The CRE CLI simulation is blocked on an interactive login, and we're showing you that rather than cropping it. Exact command and status: docs/CRE-SIMULATION.md` |
| **CAPTION 6** *(if logged in)* | `And the CRE CLI simulation, running the same handler on the network's own simulator.` |
| **ASSET** | source stills; **[record]** all three terminal runs. Blocked-path error text already captured verbatim in `docs/CRE-SIMULATION.md`. |

> **Approval note.** Showing a failing command on camera is a deliberate choice: the alternative is
> to imply a simulation ran when it didn't, and a judge who tries it themselves finds out either
> way. If you run `! cre login` before I render, shot 4d becomes the real simulation transcript,
> which is strictly better footage — say the word and I'll re-record just that shot.

### 5 — The cascade, driven live (2:06 → 2:34)

| | |
|---|---|
| **SHOT** | Screen recording of the running dashboard. Drag the shock slider from 0% to −40% in one smooth pass; the contagion graph fills and the cascade rounds tick over. Hold on the fully-propagated state. Then the in-app frame meter. |
| **CAPTION 1** | `A liquidation you can't sell into real depth isn't a liquidation.` |
| **CAPTION 2** | `So the cascade model reads exit liquidity from four DEX AMM subgraphs — 636 live depth queries, deduped by pool.` |
| **CAPTION 3** | `Two standardized schemas, composed. Lending risk parameters meet actual market depth.` |
| **CAPTION 4** | `41 rungs, precomputed. 61 fps measured over 71 frames, worst frame 16.8 ms.` |
| **ASSET** | **[record]** dashboard screen capture at 1080p60, downsampled to 30 fps for delivery (slider motion still reads smooth). Real cursor visible. |

### 6 — And an agent can use all of it (2:34 → 3:02)

| | |
|---|---|
| **SHOT 6a** *(terminal, ~7s)* | `$ npm run mcp:handshake` typed and run, uncut — the real JSON-RPC `initialize` / `tools/list` / `tools/call` exchange scrolling past, held at 1× on `MCP server ready: 8 tools, 5 deployments` and the pinned-block line. |
| **SHOT 6b** *(app, ~19s)* | Claude Code session with the Sentinel MCP server mounted. Real prompt typed: *"What's the current systemic risk and what can't you evaluate?"* Answer arrives with its citation table. Then a second prompt: *"Give me the list of addresses levered across three protocols."* The refusal lands. |
| **CAPTION 1** | `8 MCP tools, discoverable over the wire. Reusable infrastructure, not bolted to our dashboard.` |
| **CAPTION 2** | `Every figure cites the subgraph and the block it was read at. One session pins one block — two figures from two blocks were never true at the same time.` |
| **CAPTION 3** | `Then ask for the address list.` |
| **CAPTION 4** | `The refusal is in the server, not in a prompt. It survives an adversarial user.` |
| **ASSET** | **[record]** live Claude Code session; existing transcript `docs/evidence/phase7-transcript.md` as the fallback still if the live take is slow. |

### 7 — It ends on-chain (3:02 → 3:16)

| | |
|---|---|
| **SHOT** | Terminal, two commands typed and run uncut: `$ npm run consume-signal` — an independent consumer verifying the signer quorum and reacting — then `$ npm run forge:test`, held at 1× on the passing Solidity test count and the returning prompt. |
| **CAPTION 1** | `A stranger's consumer verifies the quorum from the signed report alone. No trust in us required.` |
| **CAPTION 2** | `GuardedVault consumes the signal on-chain and pauses new borrowing under alert. Advisory dashboards don't stop cascades.` |
| **CAPTION 3** | `Signer quorum, staleness and replay, all verified in Solidity.` |
| **ASSET** | **[record]** both commands. |

### 8 — What we don't claim, and one command for all of it (3:16 → 3:34)

| | |
|---|---|
| **SHOT 8a** *(source, ~6s)* | The "claims we do not make" section of `docs/EVIDENCE.md`, scrolling. |
| **CAPTION 1** | `We didn't author a subgraph — we consume two. The backtest publishes its misses. Distress figures are bounds, because E-Mode isn't in the standardized schema.` |
| **SHOT 8b** *(terminal, ~10s)* | `$ npm run verify` typed and run. Ramp the run visibly (`⏩ 8×`), then drop to 1× and hold on the full summary block: every stage marked `ok`, the totals, and `verify OK — every stage green on live data.` |
| **CAPTION 2** | `17 stages. Live data, no mock mode — a test enforces that there isn't one.` |
| **CAPTION 3** | `Everything in this video re-verifies in one command.` |
| **CLOSING CARD** | `Sentinel` / `npm run verify` / `github.com/LegendaryPenguin/EthOnline` |
| **ASSET** | still; **[record]** a full `npm run verify` run — the same run whose numbers the captions quote. |

---

## Caption style

- Bottom-third, 48px, the dashboard's own type stack, `#F2F4F8` on a 70%-opacity `#0B0D12` plate
  so it stays legible over terminal output.
- One clause per card. Nothing on screen longer than ~4.5s or shorter than ~1.6s.
- Numbers are never rounded in a caption — the same rule the SKILL enforces on the agent applies
  to our own marketing. `$35,923,754` stays `$35,923,754`.
- Code and terminal footage: 15px minimum after scaling, and every highlighted line is legible at
  720p, since that's what a judge on a laptop actually gets.

## Recording checklist

1. `npm run verify` green immediately before recording, so on-screen figures match the repo.
2. Fresh terminal, 120×34, dashboard-dark palette, no personal paths visible in the prompt.
3. **`.env.local` never on screen**; no `env`, no `cat`, no error that could echo a gateway URL.
4. Dashboard on the dark theme throughout (light theme is in the screenshots, not the video).
5. Two takes of the slider drag; keep the one where the graph fills without a stutter.
6. Speed-ramp waits, never the results — a sped-up number is a number the viewer can't check. Any
   ramp is labelled on screen.
7. Every terminal command is typed on camera and every run ends with the prompt back. Ten commands
   run live across the cut: `snapshot`, `leak-demo`, `cre:typecheck`, `cre:test`,
   `cre workflow simulate`, `mcp:handshake`, `consume-signal`, `forge:test`, `verify`, plus the
   dashboard on `dev`.
8. Record the terminal sections in one session, after a single `npm run verify`, so every number
   across the whole video comes from the same block and the same run.

## Open question for you

Section 6 is the only part that needs a live Claude Code session on screen. If you'd rather not
have your editor on camera, I'll shoot it as an animated replay of
`docs/evidence/phase7-transcript.md` instead — slightly weaker footage, identical content, and
I'd caption it as a transcript so it isn't passed off as live.
