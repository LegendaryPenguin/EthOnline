/*
 * The edit. This file is the shot list from `docs/VIDEO.md` in executable form: sections in order,
 * durations in seconds, and the caption cues with the exact text that goes on screen.
 *
 * Rules that live here rather than in a comment somewhere else:
 *
 *   - **Numbers in captions are copied from the run that is on screen behind them**, never from
 *     memory and never rounded. If a re-record moves a figure, the caption moves with it.
 *   - **A `zooms` entry does not contain its own text.** It names a line to match, and the engine
 *     slices that line out of the cast it is sitting on top of. So a callout cannot say something
 *     the command did not print, and if the output changes shape the render fails loudly instead of
 *     quoting a line that is no longer there.
 *   - **`plays` may change the rate of a run, never its range.** Every ramp puts a badge on screen.
 */

export const FPS = 30;

/** Rate helper: compress a stretch of a cast into a fixed number of seconds. */
const fit = (seconds) => ({ fit: seconds });

const TRACK = {
  graph: "The Graph — Composable / Standardized Graph Products",
  ai: "The Graph — AI Tooling or AI Use Case (Start Fresh)",
  cre: "Chainlink — Best Confidential Workflow",
};

export const EDIT = {
  segments: [
    // ── 1. The number nobody publishes ───────────────────────────────────────
    {
      kind: "card",
      id: "open",
      dur: 9,
      lines: [
        { at: 0.3, hold: 3.0, html: "Every lending protocol knows its own risk." },
        {
          at: 3.2,
          hold: 3.0,
          html: "None of them know how much of their debt is levered <em>somewhere else too</em>.",
        },
        {
          at: 6.1,
          hold: 2.9,
          class: "accent",
          html: "That's the debt that liquidates twice in one price move.",
        },
      ],
    },
    {
      kind: "image",
      id: "hero",
      src: "/repo/docs/evidence/screens/dashboard-dark.png",
      dur: 5,
      from: 1.0,
      to: 1.07,
      originY: "8%",
      captions: [
        {
          at: 0.4,
          dur: 4.2,
          html: "Sentinel measures it — and <b>cannot publish how it knows</b>.",
        },
      ],
    },

    // ── 2. Measured, live, across five protocols ─────────────────────────────
    {
      kind: "terminal",
      cast: "snapshot",
      track: TRACK.graph,
      dur: 19,
      hold: 0,
      zooms: [
        {
          at: 10.4,
          dur: 4.4,
          match: "excluded aave-v2-eth",
          lines: 1,
          fontSize: "20px",
          top: "330px",
          label: "the reconciliation gate, firing on live data",
        },
        {
          at: 15.0,
          dur: 3.9,
          match: "HEADLINE:",
          lines: 2,
          top: "360px",
          label: "npm run snapshot — the headline it printed",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 4.4,
          html: "<b>Messari Standardized Subgraphs.</b> Five lending protocols, one query document, byte-identical against each.",
        },
        {
          at: 4.8,
          dur: 5.2,
          html: "Live data from a Graph provider — no mocked, local-only or static datasets anywhere in this project. A test fails the build if one appears.",
        },
        {
          at: 10.4,
          dur: 4.4,
          html: "Aave V2 is registered on purpose and rejected on purpose: its mappings never handle <code>Repay</code>. <b>Zero Aave-specific code caught it.</b>",
        },
        {
          at: 15.0,
          dur: 3.8,
          html: "At least <b>9.06%</b> of sampled borrowed value sits with addresses levered across two or more protocols.",
        },
      ],
    },
    {
      kind: "code",
      file: "lib/graph/queries.ts",
      from: 1,
      to: 14,
      highlight: [4, 5, 6, 7],
      note: "one document, every deployment",
      track: TRACK.graph,
      dur: 7,
      scrollFrom: 0,
      scrollTo: 0,
      captions: [
        {
          at: 0.3,
          dur: 6.4,
          html: "One shared schema across every protocol of a type. <code>Account.id</code> is the raw address in all of them, so the cross-protocol join is a <b>primary-key join</b>, not address guesswork. That is what the standard bought us.",
        },
      ],
    },

    // ── 3. Why the raw answer cannot be published ────────────────────────────
    {
      kind: "terminal",
      cast: "leak-demo",
      track: TRACK.cre,
      dur: 18,
      hold: 0,
      zooms: [
        {
          at: 6.0,
          dur: 4.6,
          match: "borrowers profiled",
          lines: 1,
          top: "380px",
          label: "the same pipeline, with the enclave removed",
        },
        {
          at: 11.0,
          dur: 6.6,
          match: "| # | borrower",
          lines: 4,
          fontSize: "15px",
          top: "300px",
          label: "what the enclave refuses to publish",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 5.4,
          html: "To compute the aggregate you first need a per-address map of who is levered where.",
        },
        {
          at: 6.0,
          dur: 4.6,
          html: "<code>npm run leak-demo</code> runs the confidential workflow's own query plan and policy, and substitutes <em>one function call</em>.",
        },
        {
          at: 11.0,
          dur: 6.6,
          html: "Publish this and you have published a hunting list for liquidation bots, and a deanonymization aid for everyone else. <b>So the map is the one thing that never leaves.</b>",
        },
      ],
    },
    {
      kind: "doc",
      file: "docs/ENCLAVE.md",
      from: 77,
      to: 84,
      note: "what never crosses out",
      track: TRACK.cre,
      dur: 7,
      scrollAt: 6.9,
      captions: [
        {
          at: 0.3,
          dur: 6.4,
          html: "Twelve aggregate fields leave the enclave, specified one by one. <b>No address in any form, no per-address row, no coupling bucket below k = 3 borrowers.</b>",
        },
      ],
    },

    // ── 4. Chainlink CRE: the aggregation runs in the enclave ────────────────
    {
      kind: "code",
      file: "cre/sentinel-signal/workflow.ts",
      from: 525,
      to: 538,
      highlight: [534, 535, 536],
      note: "workflow.ts:534",
      track: TRACK.cre,
      dur: 7,
      scrollTo: 0,
      captions: [
        {
          at: 0.3,
          dur: 6.4,
          html: "A registered confidential TEE handler: <code>cre.handlerInTee</code>, not <code>handler</code>. <b>There is no non-TEE path in this workflow</b> — the signal has exactly one producer.",
        },
      ],
    },
    {
      kind: "code",
      file: "cre/sentinel-signal/workflow.ts",
      from: 147,
      to: 160,
      highlight: [149, 157, 158],
      note: "workflow.ts:149, :157–158",
      track: TRACK.cre,
      dur: 7,
      scrollTo: 0,
      captions: [
        {
          at: 0.3,
          dur: 6.4,
          html: "<b>Secrets fetched directly inside the enclave</b> — the gateway API key, and the risk policy itself. Publish a threshold and a borrower sits one basis point under it.",
        },
      ],
    },
    {
      kind: "terminal",
      cast: "cre-typecheck",
      track: TRACK.cre,
      dur: 5.5,
      hold: 0,
      captions: [
        {
          at: 0.2,
          dur: 5.1,
          html: "It compiles against the real CRE SDK — <code>handlerInTee</code>, <code>TeeRuntime&lt;Config&gt;</code>, <code>getSecret</code>. Not an approximation of the confidential API.",
        },
      ],
    },
    {
      kind: "terminal",
      cast: "cre-test",
      track: TRACK.cre,
      dur: 5.5,
      hold: 0,
      captions: [
        {
          at: 0.2,
          dur: 5.1,
          html: "20 tests over the enclave's own path: aggregation, k-anonymity suppression, signing. 0 fail.",
        },
      ],
    },
    {
      kind: "terminal",
      cast: "cre-simulate",
      track: TRACK.cre,
      dur: 24,
      hold: 0,
      zooms: [
        {
          at: 11.9,
          dur: 5.6,
          match: "Trigger requested TEE Execution",
          lines: 7,
          fontSize: "23px",
          top: "290px",
          label: "the CRE CLI's own output — not ours",
          emphasise: "will not be visible, and will not leave the TEE",
        },
        {
          at: 17.9,
          dur: 5.7,
          match: "Workflow Simulation Result",
          lines: 3,
          fontSize: "20px",
          top: "360px",
          label: "exit 0",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 4.0,
          html: "The confidential workflow, dispatched by Chainlink's own CLI.",
        },
        {
          at: 4.4,
          dur: 3.6,
          html: "Compiled to WASM, then the trigger fires. Simulation limits, binary hash, engine up.",
        },
        {
          at: 8.2,
          dur: 3.4,
          html: "Then the CLI says where this handler runs:",
        },
        // Deliberate silence from 11.6 to 15.6: the TEE box gets four seconds with no caption
        // competing with it. It is the one frame in this video that an independent tool wrote.
        {
          at: 15.6,
          dur: 1.9,
          html: "That is Chainlink's tooling stating this project's core property.",
        },
        {
          at: 17.9,
          dur: 5.7,
          html: "<b>Exit 0.</b> Score 22.0 at block 25966362 — 4 protocols, 90 borrowers, and 3 coupling buckets withheld for k-anonymity.",
        },
      ],
    },

    // ── 5. The cascade, driven live ──────────────────────────────────────────
    {
      kind: "video",
      // The all-intra intermediate that `scripts/record/render.mts` derives from
      // `record/assets/dashboard.webm`, because the recorder's VP8 output is not seekable.
      src: "/clip/dashboard.mp4",
      // Clip times, from `record/assets/dashboard.json`: hero 1.0s, scroll 3.2s, focus 4.6s,
      // drive 5.5s→13.2s, the app's own fps line read at 16.6s, the coupling graph at 19.2s.
      from: 2.0,
      track: TRACK.graph,
      dur: 20,
      captions: [
        {
          at: 0.4,
          dur: 3.8,
          html: "A liquidation you cannot sell into real depth is not a liquidation.",
        },
        {
          at: 4.4,
          dur: 3.4,
          html: "Driven from the keyboard alone, with a visible focus ring. 41 rungs, precomputed on the server.",
        },
        {
          at: 8.0,
          dur: 5.0,
          html: "The cascade reads exit liquidity from four <b>DEX AMM</b> subgraphs — 636 live depth queries over 159 pairs, deduplicated by pool.",
        },
        {
          at: 13.4,
          dur: 3.0,
          html: "<b>Two standardized schemas, composed into one pipeline.</b> Lending risk parameters meet actual market depth.",
        },
        {
          at: 16.6,
          dur: 3.2,
          html: "The page measures itself while it is used: <b>60 fps over 487 frames, worst single frame 16.8 ms.</b>",
        },
      ],
    },

    // ── 6. And an agent can use all of it ────────────────────────────────────
    {
      kind: "terminal",
      cast: "mcp-handshake",
      track: TRACK.ai,
      dur: 13,
      hold: 0,
      captions: [
        {
          at: 0.2,
          dur: 4.8,
          html: "An <b>MCP server</b> and an agent <b>SKILL</b>: making The Graph easier to use from AI environments. Reusable infrastructure, not a single end-user app.",
        },
        {
          at: 5.2,
          dur: 3.8,
          html: "A real JSON-RPC exchange — <code>initialize</code>, <code>tools/list</code>, <code>tools/call</code>. 8 tools, discoverable over the wire.",
        },
        {
          at: 9.2,
          dur: 3.6,
          html: "Every tool queries Standardized Subgraphs live. One session pins one block: <b>25966353</b>.",
        },
      ],
    },
    {
      kind: "chat",
      file: "docs/evidence/phase7-transcript.md",
      track: TRACK.ai,
      dur: 16,
      turns: [
        { who: "user", label: "asked", lines: [22, 22], transform: "heading", at: 0.3 },
        { who: "tool", label: "routed to", lines: [24, 24], at: 1.5 },
        { who: "agent", label: "answered", lines: [26, 26], at: 2.4 },
        { who: "tool", label: "citations", lines: [28, 36], transform: "table", at: 4.4 },
        { who: "user", label: "then asked", lines: [159, 159], transform: "heading", at: 8.4 },
        { who: "tool", label: "routed to", lines: [161, 161], at: 9.4 },
        { who: "tool", label: "the document it was given", lines: [163, 168], transform: "code", at: 10.2 },
        { who: "agent", kind: "refusal", label: "answered", lines: [170, 170], at: 11.6 },
        { who: "agent", kind: "refusal", label: "gate", lines: [172, 172], at: 13.6 },
      ],
      captions: [
        { at: 0.3, dur: 3.7, html: "Ask it what the risk is." },
        {
          at: 4.2,
          dur: 3.9,
          html: "Every figure arrives with the subgraph and the block it was read at. The SKILL's one rule: <b>never state a number a tool did not return.</b>",
        },
        {
          at: 8.4,
          dur: 3.0,
          html: "Then ask for the address list — the actual thing this project computes.",
        },
        {
          at: 11.6,
          dur: 4.0,
          html: "<b>The refusal is in the server, not in a prompt.</b> It survives an adversarial user.",
        },
      ],
    },

    // ── 7. It ends on-chain ──────────────────────────────────────────────────
    {
      kind: "terminal",
      cast: "consume-signal",
      track: TRACK.cre,
      dur: 9,
      hold: 0,
      zooms: [
        {
          at: 3.4,
          dur: 5.3,
          match: "7 of 7 mutations refused",
          lines: 1,
          top: "400px",
          label: "an independent consumer, viem only",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 3.0,
          html: "We control exactly what leaves the enclave — for <b>DON consensus, external delivery, and onchain settlement</b>.",
        },
        {
          at: 3.4,
          dur: 5.3,
          html: "A stranger's consumer verifies the signer quorum from the signed report alone. No trust in us required.",
        },
      ],
    },
    {
      kind: "terminal",
      cast: "forge-test",
      track: TRACK.cre,
      dur: 8,
      hold: 0,
      zooms: [
        {
          at: 2.7,
          dur: 5.0,
          match: "37 tests passed",
          lines: 1,
          top: "400px",
          label: "contracts/ — forge test",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 2.3,
          html: "And it settles on-chain.",
        },
        {
          at: 2.7,
          dur: 5.0,
          html: "<code>GuardedVault</code> pauses new borrowing under alert — <b>automated liquidation protection using private risk thresholds</b>. Quorum, staleness and replay all verified in Solidity.",
        },
      ],
    },

    // ── 8. What we do not claim, and one command for all of it ───────────────
    {
      kind: "doc",
      file: "docs/EVIDENCE.md",
      from: 333,
      to: 352,
      note: "the claims we do not make",
      dur: 8,
      scrollAt: 1.0,
      captions: [
        {
          at: 0.3,
          dur: 3.6,
          html: "We did not author a subgraph — we consume two. The backtest publishes its misses.",
        },
        {
          at: 4.1,
          dur: 3.6,
          html: "Distress figures are <b>bounds</b>, because E-Mode is absent from the standardized schema. Only 2 of 5 deployments support time-travel, so the backtest replays 96 of 319 episodes.",
        },
      ],
    },
    {
      kind: "terminal",
      cast: "verify",
      dur: 23.5,
      hold: 0,
      plays: [
        [0, 8000, 1],
        [8000, -9000, fit(4.4)],
        [-9000, null, 1],
      ],
      captions: [
        {
          at: 0.2,
          dur: 4.4,
          html: "Everything in this video re-verifies in one command.",
        },
        {
          at: 4.8,
          dur: 4.6,
          html: "18 stages, live: preflight, the snapshot, the cascade, the enclave, the CRE simulation, the consumer, Solidity, and a real browser.",
        },
        {
          at: 10.2,
          dur: 3.4,
          html: "The ramp is marked because time was compressed. <b>No output was removed.</b>",
        },
        {
          at: 15.0,
          dur: 8.0,
          html: "<b>Every stage green, on live data.</b> Nothing in this project needs a mock to pass.",
        },
      ],
    },
    {
      kind: "card",
      id: "close",
      dur: 6,
      lines: [
        { at: 0.2, hold: 5.6, html: "Sentinel" },
        {
          at: 1.1,
          hold: 4.7,
          class: "sub",
          html: "<code style=\"font-family:ui-monospace,Menlo,monospace;color:var(--color-accent)\">npm run verify</code>",
        },
        { at: 1.9, hold: 3.9, class: "sub", html: "github.com/LegendaryPenguin/EthOnline" },
        {
          at: 3.0,
          hold: 2.8,
          class: "sub",
          html: "<span style=\"font-size:0.7em\">The Graph · Composable &amp; Standardized Graph Products &nbsp;·&nbsp; The Graph · AI Tooling (Start Fresh) &nbsp;·&nbsp; Chainlink · Best Confidential Workflow</span>",
        },
      ],
    },
  ],
};
