# Demo video — script, and how it is rendered

**As rendered:** v1 3:47 (226.5s, 6795 frames), v2 3:53 (233.0s, 6990 frames). Both 1080p
(1920×1080), 30 fps, burned-in captions, no voiceover (captions carry the narrative; silent).
**Constraint the script is written against:** every frame is real footage of this repo — a real
command's real output, the running dashboard, or a real file on screen. Nothing is mocked up for the
camera.

**The video is a build artifact, not a performance.** `npm run record:render` renders it frame by
frame from committed inputs; there is no screen recorder anywhere in the pipeline. Three programs:

| | |
|---|---|
| `npm run record:terminal` | Runs each demo command for real under a pty and writes `docs/evidence/casts/<id>.json` — every output chunk stamped with the millisecond it arrived, redacted through `scripts/lib/redact.mts`, and refused outright if a 32-hex token survives. |
| `npm run record:dashboard` | Drives the running dashboard in Playwright and records `record/assets/dashboard.webm`. The slider is driven by `ArrowRight` keypresses, not a mouse — Playwright's recorder does not draw a cursor, and keyboard operation is a stated acceptance criterion of the interface anyway. |
| `npm run record:render` | Serves `record/player/` (the video as a web page whose entire visual state is a pure function of `SENTINEL.seek(t)`), replays the casts into a real xterm.js terminal, screenshots every frame at 30 fps and pipes them into ffmpeg. |

Why this way rather than pointing a recorder at a screen:

- **The casts are committed**, so a judge can diff any frame of the video against the bytes the
  command actually produced. A screen recording is unfalsifiable in the wrong direction — there is
  nothing to check it against.
- **Frame-exactness.** The 30th frame is at t = 1.0000s on a slow machine and a fast one. No dropped
  frames, no variable-rate output.
- **Reproducibility.** Re-running the renderer on the same inputs produces the same mp4.

What is *not* claimed: the terminal sections are not photographs of a terminal window. In v1 every one
is labelled on screen for its full duration with the cast it replays, the timestamp it was recorded at
(`docs/evidence/casts/verify.json · recorded 2026-09-13T…Z`) and its exit code. In v2 that chrome is
gone, because no terminal has it, and the claim is not narrated on screen at all: it is stated here and
in the casts themselves. See *The second cut* below.

`record/player/edit.mjs` (v1) and `record/player/edit.v2.mjs` (v2) are the executable shot lists:
segment order, durations, caption text and cues. Where they and the script below disagree, they are
what shipped.

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

**Status:** approved, captured and rendered. Two cuts exist.

| cut | shot list | output | length |
|---|---|---|---|
| v1 | `record/player/edit.mjs` | `record/out/sentinel-demo.mp4` | 3:46 |
| v2 | `record/player/edit.v2.mjs` | `record/out/sentinel-demo-v2.mp4` | 3:53 |

---

## The second cut

One engine, two edits: `?cut=v2` in the player URL and `RENDER_CUT=v2` for the renderer select
`edit.v2.mjs` and write to their own mp4, so re-rendering one can never overwrite the other. Same
casts, same proof rules, same figures. Four things differ, and all four are answers to watching v1
back.

**The terminal is a terminal.** v1's title bar carried the cast file name and the recording
timestamp. Honest, and nothing any terminal has ever shown, which made every terminal shot read as a
widget. v2 draws what macOS draws (three lights and the session) and the prompt is the operator's own,
`nrawal@842f579e3dc8 ~ %`, captured from the pty rather than substituted at draw time: the casts were
re-recorded with `SENTINEL_PROMPT` set, so the prompt on screen is a string the recording actually
contains. Each shot also ends on that prompt returning, which is how a real terminal shows a command
finished. The prompt is the one string in frame the cast did not record, because `script` captures the
child and not the interactive shell that spawned it, so it is the cast's own prompt written a second
time and nothing more. It claims no more than the recorded exit code, which is 0 for all nine shots
(`npm run record:terminal` refuses to finish otherwise).

**The provenance moved out of frame, not out of the repo.** Every terminal frame in either cut is a
replay of a run committed in `docs/evidence/casts/` with per-chunk timings, and a judge can diff any
frame against it. But that is a claim about the video rather than about the product, and a demo that
narrates its own construction spends its closing seconds on itself. It was on v2's closing card for one
render and was cut; it lives here, where someone checking the work will look for it. For the same
reason v2 carries no self referential lines anywhere: no *we did not write this*, no *not our tooling*,
no track list on the outro. The track each section answers is already in the corner of every shot.

**Callouts explain instead of decorating.** A v2 card has three registers, styled differently on
purpose so a viewer can tell which one is speaking: a `label` naming what they are looking at, the
cast's own bytes in the terminal's typeface (still sliced out of the cast by the engine, so a card
cannot quote a line the command did not print), and an `explain` line that is the video's voice and is
set in the video's typeface. The card snaps in over four frames and then holds absolutely still; v1's
slow continuous zoom is what made it read as a template.

**The lower third assumes the judge has not used this technology.** Each cue has a `kicker` naming the
sponsor product in use, an `html` claim, and a `detail` line saying what that product does here and
why the project needed it. A judge should be able to answer *what did they use The Graph for, and what
did they use Chainlink CRE for* from the lower third alone.

And one hard constraint on v2: **no em dash anywhere in its own writing.** It is enforced in
`scripts/record/render.mts`, which refuses to encode if any v2 caption register contains one, rather
than trusted to proofreading. The casts are clean of them too, which is why `cre/secrets.yaml` now
uses the `CRE_`-prefixed env var names the CRE CLI asks for: those two warnings were the last em dashes
left in any recorded output. See `docs/CRE-SIMULATION.md`.

---

## Shot list

Timings are cumulative. `CAPTION` is the on-screen text, verbatim. `SHOT` is what the frame shows.
Everything under `ASSET` already exists in the repo unless marked **[record]**.

---

### 1 — The number nobody publishes (0:00 → 0:14)

| | |
|---|---|
| **SHOT** | Black. Text only, one line at a time, centred, large. Then hard cut to the dashboard hero figure. |
| **CAPTION 1** | `Every lending protocol knows its own risk.` |
| **CAPTION 2** | `None of them know how much of their debt is levered somewhere else too.` |
| **CAPTION 3** | `That's the debt that liquidates twice in one price move.` |
| **ASSET** | `docs/evidence/screens/dashboard-dark.png` for the hard cut, held 3s on the `$35,923,754` figure with a subtle push-in. |

### 2 — Measured, live, across five protocols (0:14 → 0:40)

| | |
|---|---|
| **SHOT** | Split: left, `lib/graph/queries.ts` scrolling slowly to the `positionsQuery` doc-comment. Right, a live terminal with `$ npm run snapshot` typed and running — real output streaming, 5 deployments resolving, the reconciliation gate firing on Aave V2, ending on the returning prompt. |
| **CAPTION 1** | `One shared schema across every protocol of a type — so one query pattern spans many protocols.` |
| **CAPTION 2** | `Messari Standardized Subgraphs. Five lending protocols, one query document, byte-identical against each.` |
| **CAPTION 3** | `Live data from a Graph provider — no mocked, local-only or static datasets anywhere in this project.` |
| **CAPTION 3b** | `Account.id is the raw address in all of them, so the cross-protocol join is a primary-key join, not address guesswork. That's what the standard bought us.` |
| **CAPTION 4** | *(as the gate fires)* `Aave V2 is registered on purpose and rejected on purpose — its subgraph never handles Repay, so its own debt total is off by three orders of magnitude. Zero Aave-specific code caught it.` |

> **Caption note.** The caption deliberately says "three orders of magnitude" rather than a
> specific multiple: the ratio is sample-dependent (1925× on one snapshot, 1011× in the CRE
> simulation), so a hardcoded number would eventually disagree with the footage next to it. Whatever
> the live run prints on screen is the only number in frame.
| **ASSET** | **[record]** terminal capture of `npm run snapshot`; speed-ramped 4× where it's just waiting. |

### 3 — Why the raw answer can't be published (0:40 → 1:05)

| | |
|---|---|
| **SHOT** | Live terminal, `$ npm run leak-demo` typed and run uncut. Let the withheld/published columns land on screen at 1×. Then a still of `docs/ENCLAVE.md`'s boundary table. |
| **CAPTION 1** | `To compute that number you first need a per-address map of who is levered where.` |
| **CAPTION 2** | `Publish that map and you've published a hunting list for liquidation bots — and a deanonymization aid for everyone else.` |
| **CAPTION 3** | `So the map is the one thing that never leaves.` |
| **CAPTION 4** | `k-anonymity suppression on the output: 3 coupling buckets withheld, because fewer than k accounts stood behind them. Suppression that never fires is decoration.` |
| **ASSET** | **[record]** `npm run leak-demo`; still of `docs/ENCLAVE.md`. |

### 4 — Chainlink CRE: the aggregation runs in the enclave (1:05 → 1:54)

The longest section, and the most terminal-heavy, because "the confidential part actually executes"
is the entire ask of this track and a source screenshot does not demonstrate execution.

| | |
|---|---|
| **SHOT 4a** *(source, ~8s)* | `cre/sentinel-signal/workflow.ts` at line 534, `cre.handlerInTee` highlighted. Cut to lines 157–158, the two `getSecret` calls highlighted. Filename and line numbers visible in frame so each can be checked. |
| **CAPTION 1** | `A registered confidential TEE handler: handlerInTee. Not handler — there is no non-TEE path in this workflow.` |
| **CAPTION 2** | `Secrets fetched directly inside the enclave — the gateway API key, and the risk policy itself. Publish a threshold and a borrower sits one basis point under it.` |
| **SHOT 4b** *(terminal, ~10s)* | `$ npm run cre:typecheck` typed and run, uncut, to a clean exit. |
| **CAPTION 3** | `It compiles against the real CRE SDK — handlerInTee, TeeRuntime<Config>, getSecret. Not an approximation of the confidential API.` |
| **SHOT 4c** *(terminal, ~16s)* | `$ npm run cre:test` typed and run, uncut. Hold at 1× on the section of output where both Vault secrets resolve, the live gateway queries run, the aggregate is computed, buckets are suppressed, and the report is signed. Then the passing test count and the returning prompt. |
| **CAPTION 4** | `Sensitive inputs, confidential API responses, and intermediate computation — all four categories, all inside the enclave.` |
| **CAPTION 5** | `The intermediate value is the per-address leverage map. Out come 12 aggregate fields, signed. The map is not one of them.` |
| **SHOT 4d** *(terminal, ~14s — the money shot)* | `$ npm run cre:simulate` typed and run. Hold on `✓ Workflow compiled`, then **the CLI's own TEE box**, then the `[USER LOG]` lines and `✓ Workflow Simulation Result`, then exit 0. |
| **CAPTION 6** | `And the CRE CLI's own simulator agrees about where it ran:` |
| **CAPTION 7** | *(the TEE box on screen, zoomed, held 4s — no caption competing with it; this is Chainlink's tooling stating our core claim for us)* |
| **CAPTION 8** | `"During real execution, user logs for this trigger will not be visible, and will not leave the TEE." — that's the CLI, not us.` |
| **CAPTION 9** | `Exit 0. Score 22.0 at block 25966825 — 4 protocols, 90 borrowers, and 3 coupling buckets withheld for k-anonymity.` |
| **ASSET** | source stills; **[record]** all four terminal runs. Transcript already committed at `docs/evidence/cre-simulation.log`. |

> **Editing note — do not skip.** The frame that shows the CLI's TEE box is the single most
> valuable frame in the video: an independent tool asserting that the handler's logs do not leave
> the enclave. Give it four full seconds with no competing caption.
>
> **Recording constraint, mandatory.** The simulation is run through `npm run cre:simulate`, never
> the bare CLI, because with `-g` the engine logs full request URLs and the Graph gateway carries
> the API key as a path segment — the first raw transcript contained the live key 28 times. The
> wrapper redacts in-flight. Even so: **do not scroll the engine's JSON output on camera.** Frame
> the shot on the human-readable header and footer, which is where everything worth showing is.

### 5 — The cascade, driven live (1:54 → 2:14)

| | |
|---|---|
| **SHOT** | Screen recording of the running dashboard. Drag the shock slider from 0% to −40% in one smooth pass; the contagion graph fills and the cascade rounds tick over. Hold on the fully-propagated state. Then the in-app frame meter. |
| **CAPTION 1** | `A liquidation you can't sell into real depth isn't a liquidation.` |
| **CAPTION 2** | `So the cascade model reads exit liquidity from four DEX AMM subgraphs — 636 live depth queries, deduped by pool.` |
| **CAPTION 3** | `Two standardized schemas, composed into one pipeline. Lending risk parameters meet actual market depth.` |
| **CAPTION 4** | `The page measures itself while it is used: 60 fps over 487 frames, worst single frame 16.8 ms.` |
| **ASSET** | **[record]** `npm run record:dashboard` — a real browser against a real `next dev`, driven from the keyboard with a visible focus ring, recorded at 1920×1080 and re-seeked frame by frame at 30 fps by the renderer. No cursor: Playwright's recorder does not draw one, so rather than fake a cursor the shot uses keyboard operation, which the interface is required to support anyway. |

### 6 — And an agent can use all of it (2:14 → 2:43)

| | |
|---|---|
| **SHOT 6a** *(terminal, ~7s)* | `$ npm run mcp:handshake` typed and run, uncut — the real JSON-RPC `initialize` / `tools/list` / `tools/call` exchange scrolling past, held at 1× on `MCP server ready: 8 tools, 5 deployments` and the pinned-block line. |
| **SHOT 6b** *(animated transcript, ~19s)* | **Decided: animated replay of `docs/evidence/phase7-transcript.md`, not a live session.** The prompt types on, the tool call and its citation table appear, then the second prompt and the refusal. Rendered in the dashboard's own type stack, with a small persistent `recorded transcript · docs/evidence/phase7-transcript.md` label in the corner for the whole shot, so it is never mistaken for a live take. Prompts shown: *"What's the current systemic risk and what can't you evaluate?"* then *"Give me the list of addresses levered across three protocols."* |
| **CAPTION 1** | `An MCP server and an agent SKILL: making The Graph easier to use from AI environments. Reusable infrastructure, not a single end-user app.` |
| **CAPTION 1b** | `8 tools, discoverable over the wire. Every one of them queries Standardized Subgraphs live.` |
| **CAPTION 2** | `Every figure cites the subgraph and the block it was read at. One session pins one block — two figures from two blocks were never true at the same time.` |
| **CAPTION 3** | `Then ask for the address list.` |
| **CAPTION 4** | `The refusal is in the server, not in a prompt. It survives an adversarial user.` |
| **CAPTION 5** | `Reasoning, decisions and automation — not printing a raw query result. This is a risk monitor with The Graph as its live source of blockchain data.` |
| **ASSET** | **[record]** `npm run mcp:handshake`; animated replay built from `docs/evidence/phase7-transcript.md`. |

### 7 — It ends on-chain (2:43 → 3:00)

| | |
|---|---|
| **SHOT** | Terminal, two commands typed and run uncut: `$ npm run consume-signal` — an independent consumer verifying the signer quorum and reacting — then `$ npm run forge:test`, held at 1× on the passing Solidity test count and the returning prompt. |
| **CAPTION 1** | `We control exactly what leaves the enclave — for DON consensus, external delivery, and onchain settlement. Twelve aggregate fields, and nothing else.` |
| **CAPTION 2** | `A stranger's consumer verifies the signer quorum from the signed report alone. No trust in us required.` |
| **CAPTION 3** | `GuardedVault consumes the signal onchain and pauses new borrowing under alert. Advisory dashboards don't stop cascades.` |
| **CAPTION 4** | `Automated liquidation protection, using private risk thresholds. Signer quorum, staleness and replay all verified in Solidity.` |
| **ASSET** | **[record]** both commands. |

### 8 — What we don't claim, and one command for all of it (3:00 → 3:47)

| | |
|---|---|
| **SHOT 8a0** *(source, 9s)* | The operating-point table `npm run backtest:cascades` wrote, in `docs/evidence/phase6-early-warning.md`. Added after the first render, which had no backtest in it — an acceptance criterion asks the video to show the backtest result with lead time, and it wasn't there. |
| **CAPTION 0a** | `Backtested against real liquidation episodes, each paired against the same hour of the previous week: 3 of 5 detected at a 24-hour median lead time, at a 20% false-alarm rate.` |
| **CAPTION 0b** | `At the strictest operating point it detects nothing, and that row is the primary result. All three are published rather than the flattering one chosen — with 5 episodes, picking would be fitting the policy to the labels.` |
| **SHOT 8a** *(source, ~6s)* | The "claims we do not make" section of `docs/EVIDENCE.md`, scrolling. |
| **CAPTION 1** | `We didn't author a subgraph — we consume two. The backtest publishes its misses. Distress figures are bounds, because E-Mode isn't in the standardized schema.` |
| **SHOT 8b** *(terminal, ~10s)* | `$ npm run verify` typed and run. Ramp the run visibly (`⏩ 8×`), then drop to 1× and hold on the full summary block: every stage marked `ok`, the totals, and `verify OK — every stage green on live data.` |
| **CAPTION 2** | `18 stages. Live data, no mock mode — a test enforces that there isn't one.` |
| **CAPTION 3** | `Everything in this video re-verifies in one command.` |
| **CLOSING CARD** | `Sentinel` / `npm run verify` / `github.com/LegendaryPenguin/EthOnline` |
| **ASSET** | still; **[record]** a full `npm run verify` run — the same run whose numbers the captions quote. |

**v2 drops SHOT 8a.** A section headed *what this project does not claim*, over a doc pane headed
*the claims we do not make*, is a disclaimer slide, and a demo is not the place to argue with itself.
The one load-bearing fact in it — the backtest replays 96 of 319 known episodes, because only 2 of the
5 deployments answer time-travel queries — moved into SHOT 8a0 as a third caption, over the table that
figure comes from. The E-Mode bound it also stated is still on screen in the snapshot shot, in the
run's own words (`the remaining cause is Aave V3 E-Mode, which the standardized schema omits`). v2's
closing card is three lines and out.

---

## Track wording map — every requirement, and the second it lands

The captions above deliberately reuse the sponsors' own phrases rather than our paraphrases of them,
so a judge holding the prize page can tick bullets without translating. Verbatim requirements are in
`docs/TRACKS.md`; this table says where each one is on screen.

**The Graph — Best Use of Composable or Standardized Graph Products**

| Their words | Where |
|---|---|
| "one shared schema across every protocol of a type" · "a single query across many protocols" | **0:14** caption 1–2 |
| "build meaningfully on a standardized schema (for example the Messari Standardized Subgraphs)" | **0:14** caption 2, on screen as `lib/graph/deployments.ts` |
| "Consume live data from a Graph provider… Mocked, local-only, or static datasets do not qualify" | **0:14** caption 3, over a live `npm run snapshot` |
| "compose two or more of The Graph's products" | **1:54** caption 3 — two standardized schemas composed into one pipeline |
| "Simply querying one Subgraph… does not qualify" | answered by construction at **0:14** and **1:54**: nine deployments, two schemas |
| "Make the standards leverage clear: show what became easier" | **0:14** caption 3b — the primary-key join, stated as what the standard bought us |
| "Authoring or extending a Standardized Subgraph… is in scope" | **3:09** — stated as *not claimed*, out loud |
| "a short demo video (two to four minutes)" | v1 3:47, v2 3:53 |

**The Graph — Best AI Tooling or AI Use Case (Start Fresh)**

| Their words | Where |
|---|---|
| "makes The Graph easier to use from AI environments like Claude, Cursor, and ChatGPT (new or extended MCP servers, agent SKILLs…)" | **2:14** caption 1 |
| "reusable infrastructure, not a single end-user app" | **2:14** caption 1, verbatim |
| "Use The Graph as a load-bearing part of the project" | **2:14** caption 1b — every tool queries Standardized Subgraphs live |
| "risk monitors" *(their own example of a qualifying AI app)* | **2:14** caption 5, using their word |
| "Do meaningful work with the data: reasoning, decisions, automation… not just printing a raw query result" | **2:14** caption 5 and **2:43** (the vault acting on the signal) |
| "Consume live data… Mocked, local-only, or static datasets do not qualify" | **2:14** shot 6a, live handshake |
| "a clear README or SKILL.md so judges can run it" | closing card, both cuts |
| "document any pre-existing work" | `docs/DISCLOSURE.md`, linked in the submission — not in the cut, since a disclosure belongs in writing |

**Chainlink — Best Confidential Workflow**

| Their words | Where |
|---|---|
| "register and use a confidential TEE handler, such as `handlerInTee`" | **1:05** shot 4a + caption 1, `handlerInTee` on screen |
| "Secrets can be fetched directly inside the enclave" | **1:05** caption 2, both `getSecret` calls on screen |
| "sensitive inputs, API responses, and intermediate computation remain protected" | **1:05** captions 4–5, all four categories named |
| "hardware-isolated Trusted Execution Environment (TEE)" | **1:05** shot 4d — the CLI's own box naming AWS Nitro |
| "execute a meaningful part of the application" · "A placeholder handler… will not qualify" | **0:40** (leak-demo: remove the enclave and there is no safe product) and **1:05** caption 9 (suppression firing on real data) |
| "Developers explicitly control what stays confidential and what leaves the enclave for DON consensus, external delivery, or onchain settlement" | **2:43** caption 1, using all three of their destinations |
| "Demonstrate a successful execution through… A Confidential Workflow simulation using the CRE CLI" | **1:05** shot 4d, exit 0 in frame |
| "Provide evidence… such as a demo video, terminal output, execution logs" | the whole cut is terminal output; log committed at `docs/evidence/cre-simulation.log` |
| their example use case: "Automated liquidation protection using private risk thresholds" | **2:43** caption 4, using their phrase |
| their example use case: "Privacy-preserving risk assessment and policy enforcement" | **0:40** and **2:43** — the assessment is private, the vault is the enforcement |

One gap, named rather than hidden: the track description mentions layering **the Subgraph MCP** on
top for cross-protocol analysis. We ship our *own* MCP server over Standardized Subgraphs; we do not
use The Graph's Subgraph MCP. The composition claim rests on two standardized schemas, not on that.

## Caption style

- Bottom-third, 40px, `ui-sans-serif` — the dashboard's own stack — `#F2F4F8` on an 82%-opacity
  `#080B0F` plate so it stays legible over terminal output. Inline `code` at 36px in the accent
  colour; `<b>` is the accent colour too, and marks the figure or phrase the shot exists for.
- One clause per card. Nothing on screen longer than ~6.5s or shorter than ~1.9s. The caption engine
  throws if two cues overlap, so the plate can never show two claims at once.
- Numbers are never rounded in a caption — the same rule the SKILL enforces on the agent applies
  to our own marketing. `$35,923,754` stays `$35,923,754`. Every figure in a caption is copied from
  the run visible behind it, and the renderer refuses to encode any caption containing `TODO`.
- Terminal footage is 21px monospace at 1080p (120 columns, 30 rows), code panes 21px, doc panes
  25px — all legible at 720p, since that is what a judge on a laptop actually gets. Zoom callouts
  are enlargements *sliced out of the cast on screen behind them*: a callout cannot quote a line the
  command did not print, and if the output changes shape the render fails instead of misquoting.

## Recording checklist

1. `npm run record:terminal` captures all nine casts in one session, so every number across the
   whole video comes from the same block and the same run. **The `verify` cast is captured last**,
   after every code change, because its title bar shows its exit code and a red one is a red one.
2. The casts are 120×34 (`COLUMNS`/`LINES` are set for the child too, so a CLI that wraps to the
   terminal width wraps to the frame it will be replayed in). The prompt is `sentinel $` — no path,
   so no personal directory in frame; `$HOME` is scrubbed from the output as well.
3. **`.env.local` never on screen**; no `env`, no `cat`, no error that could echo a gateway URL. The
   capture refuses to write a cast in which a 32-hex token survived redaction.
4. The CRE simulation goes through `npm run cre:simulate`, never the bare CLI with `-g`: the engine
   logs full request URLs and the Graph gateway carries the API key as a path segment. The wrapper
   redacts in flight, and `<GRAPH_API_KEY redacted>` is visible in the footage doing it.
5. Dashboard on the dark theme, set via the browser's `colorScheme` — clicking DARK would film a
   preference being overridden rather than the page a reader with a dark desktop actually gets.
6. Speed-ramp waits, never the results — a sped-up number is a number the viewer can't check. A ramp
   changes the rate, never the range, and puts `⏩ N× — nothing removed, only sped up` on screen for
   as long as it runs. `npm run verify` is the only ramped shot.
7. Every terminal shot types its command after the prompt, plays the run, and holds the last frame.
   Nine commands across the cut: `snapshot`, `leak-demo`, `cre:typecheck`, `cre:test`,
   `cre:simulate`, `mcp:handshake`, `consume-signal`, `forge:test`, `verify` — plus the dashboard,
   captured separately against a real `next dev`.
8. `RENDER_STILLS=40,90,114 npm run record:render` writes those seconds as PNGs and stops; checking
   a layout should not cost a full render. `RENDER_SERVE=1` hosts the timeline so it can be scrubbed
   by hand in a browser.

## Decisions taken

- **Section 4d shows the real CRE simulation.** `cre login` is done, the simulation passes, and the
  transcript is committed. No failing command in the cut any more.
- **Section 6b is an animated transcript, not a live session** — labelled as such on screen for its
  full duration. It carries no weight it hasn't earned: section 6a runs `npm run mcp:handshake`
  live, which is what actually proves the tools are real and answering over the wire.
- **No cursor is drawn anywhere.** The obvious fix for a recorder that doesn't capture the pointer is
  to composite a fake one in. That would be a synthetic element in footage whose entire pitch is that
  it isn't synthetic, so the dashboard is driven from the keyboard instead and the caption says so.
- **The `⏩` badge names its own rate from the cast, not from the edit.** The edit asks for "this
  stretch, in 4.4 seconds"; the rate is computed against the recorded duration and printed. So
  re-recording `npm run verify` cannot silently produce a badge that lies about the compression, and
  cannot overrun the segment either — the player throws at load if the shot is too short for the run.
- **Section 4c's caption quotes the count the run printed:** 20 pass, 0 fail. The earlier draft's
  captions 4–5 described the four confidentiality categories instead; that argument is made where it
  is checkable — 4a's two source panes and the CLI's own TEE box at 4d — rather than asserted over
  a passing test count.
