/*
 * The second cut. Same engine, same casts, same rules as `edit.mjs`; a different edit.
 *
 * Three things changed, and all three are answers to watching the first cut back:
 *
 *   1. **The terminal is a terminal.** The first cut put the cast file name and a recording
 *      timestamp in the title bar. Honest, and nothing any terminal has ever shown. Here the window
 *      is what macOS draws and the prompt is the operator's own, so a viewer reads the footage as a
 *      session rather than as a widget. The provenance lives in `docs/VIDEO.md` and in the casts
 *      themselves, and is not narrated on screen: a demo talks about the product, not about itself.
 *   2. **The callouts explain instead of decorating.** A `zooms` entry in this cut carries a `label`
 *      (what you are looking at), the cast's own bytes (unchanged: the engine still slices them out
 *      of the cast, so a card cannot quote a line the command did not print), and an `explain` line
 *      that is the video's voice and is styled as the video's voice.
 *   3. **The captions assume the judge has not used this technology.** Each cue has three registers:
 *      a `kicker` naming the sponsor product being used, an `html` claim, and a `detail` line saying
 *      what that product actually does here and why the project needed it. A judge should be able to
 *      answer "what did they use The Graph for, and what did they use Chainlink CRE for" from the
 *      lower third alone.
 *
 * And one hard constraint, enforced in `scripts/record/render.mts` rather than by proofreading: no em
 * dash appears anywhere in this cut's own writing. The render fails if one does.
 *
 * The rules inherited from `edit.mjs` are unchanged and non negotiable:
 *
 *   - **Numbers in captions are copied from the run on screen behind them**, never from memory and
 *     never rounded. Every figure below comes from the casts in `docs/evidence/casts/` as recorded on
 *     2026-09-13 at block 25,966,798.
 *   - **A `zooms` entry does not contain its own text.** It names a line to match and the engine
 *     slices it out of the cast, so the render fails loudly if the output changes shape.
 *   - **`plays` may change the rate of a run, never its range.** Every ramp puts a badge on screen.
 */

export const FPS = 30;

/** Rate helper: compress a stretch of a cast into a fixed number of seconds. */
const fit = (seconds) => ({ fit: seconds });

/**
 * The track tag, in each sponsor's own words. Middot rather than a dash, per the no em dash rule, and
 * the prize titles are quoted exactly as the tracks are written so a judge can match them by eye.
 */
const TRACK = {
  graph: "The Graph · Best Use of Composable or Standardized Graph Products",
  ai: "The Graph · Best AI Tooling or AI Use Case (From Scratch)",
  cre: "Chainlink · Best Confidential Workflow",
};

export const EDIT = {
  style: "v2",
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
          kicker: "Sentinel",
          html: "A systemic risk oracle that <b>cannot publish how it knows</b>.",
          detail:
            "Measuring cross protocol leverage requires a per address map of who is levered where. That map is the harm. So the measuring happens inside a confidential enclave and only the aggregate comes out.",
        },
      ],
    },

    // ── 2. Measured, live, across five protocols ─────────────────────────────
    {
      kind: "terminal",
      cast: "snapshot",
      track: TRACK.graph,
      dur: 20,
      hold: 0,
      zooms: [
        {
          at: 5.6,
          dur: 4.4,
          match: "excluded aave-v2-eth",
          lines: 1,
          fontSize: "18px",
          top: "300px",
          width: "1500px",
          label: "a subgraph rejected by the gate, live",
          source: "npm run snapshot",
          explain:
            "Every deployment has to reconcile: the debt summed from its positions must land near the debt it reports for itself. Aave V2's mappings never handle <code>Repay</code>, so its positions sum to 1924.8x its own reported total. It is registered on purpose and rejected on purpose, by a rule that names no protocol.",
        },
        {
          at: 10.4,
          dur: 4.2,
          match: "Cross-protocol exposure",
          lines: 7,
          fontSize: "21px",
          side: "right",
          top: "290px",
          label: "the cross protocol join",
          source: "npm run snapshot",
          explain:
            "Because all five deployments share one schema, <code>Account.id</code> is the raw address in every one of them. Grouping by it is a primary key join, not address matching. <b>1,116 addresses appear on two or more protocols; 67 of them are borrowing.</b>",
        },
        {
          at: 15.0,
          dur: 4.8,
          match: "HEADLINE:",
          lines: 2,
          top: "330px",
          label: "the figure the run printed",
          source: "npm run snapshot",
          explain:
            "The share of borrowed value sitting with addresses levered across more than one protocol. No single protocol's own dashboard can compute this number, because no protocol can see the other four.",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 5.2,
          kicker: "The Graph · standardized subgraphs",
          html: "Five lending protocols, <b>one query document</b>, byte identical against each.",
          detail:
            "A subgraph is an indexed, queryable view of a protocol's onchain history. The Messari lending standard makes five different protocols answer the <i>same</i> GraphQL document, which is the only reason a single pipeline can read all of them.",
        },
        {
          at: 5.6,
          dur: 4.4,
          kicker: "Composability, and its cost",
          html: "Aave V2 is rejected because its own numbers disagree with each other.",
          detail:
            "Standardized does not mean correct. Sentinel treats every deployment as untrusted and gates on self consistency. <b>Zero Aave specific code caught this.</b>",
        },
        {
          at: 10.4,
          dur: 4.2,
          kicker: "What the standard bought",
          html: "Sampled live: <b>37,860 accounts</b> across four surviving deployments.",
          detail:
            "Read from a Graph Network gateway at block 25,966,798. No mocked, local only or static dataset exists anywhere in this project, and a test fails the build if one appears.",
        },
        {
          at: 15.0,
          dur: 4.8,
          kicker: "The result",
          html: "At least <b>9.07%</b> of sampled borrowed value is levered across two or more protocols.",
          detail:
            "That is $906,281,853 of debt held by 67 addresses that each look like a separate, comfortable borrower to every protocol lending to them.",
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
      dur: 8,
      scrollFrom: 0,
      scrollTo: 0,
      captions: [
        {
          at: 0.3,
          dur: 7.4,
          kicker: "The Graph · why standardized matters here",
          html: "One document, sent unchanged to every deployment.",
          detail:
            "Without the shared schema this project is five bespoke integrations plus an address matching heuristic, and adding a sixth protocol is a rewrite. With it, adding a protocol is adding a deployment id. <b>That is the composability claim, and this file is the whole of it.</b>",
        },
      ],
    },

    // ── 3. Why the raw answer cannot be published ────────────────────────────
    {
      kind: "terminal",
      cast: "leak-demo",
      track: TRACK.cre,
      dur: 19,
      hold: 0,
      zooms: [
        {
          at: 6.4,
          dur: 4.6,
          match: "borrowers profiled",
          lines: 1,
          fontSize: "20px",
          top: "330px",
          width: "1520px",
          label: "the same pipeline, enclave removed",
          source: "npm run leak-demo",
          explain:
            "One function call is substituted: where the confidential workflow calls <code>aggregateSignal</code>, this calls <code>perAddressRowsForLeakDemoOnly</code>. Everything else, the query plan, the normalizer, the risk policy, is the workflow's own code.",
        },
        {
          at: 11.4,
          dur: 7.0,
          match: "| # | borrower",
          lines: 4,
          fontSize: "14px",
          side: "right",
          top: "290px",
          width: "1600px",
          label: "what the enclave refuses to emit",
          source: "npm run leak-demo",
          explain:
            "Each row is individually actionable: <b>trigger</b> is the price decline at which the position becomes liquidatable, and <b>top collateral</b> is what to sell into. Publish this and you have published a target list.",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 5.8,
          kicker: "Why this needs to be confidential",
          html: "The aggregate cannot be computed without first building the thing that must never be seen.",
          detail:
            "To know how much debt is cross levered you must first know, per address, where it is levered. There is no way around that step, only a question of where it runs.",
        },
        {
          at: 6.4,
          dur: 4.6,
          kicker: "The counterfactual, run for real",
          html: "<code>npm run leak-demo</code> is Sentinel with the enclave taken out.",
          detail:
            "90 borrowers profiled. 17 levered across more than one protocol, carrying $1,201,345,660. 29 become distressed inside the policy's shock ladder.",
        },
        {
          at: 11.4,
          dur: 7.0,
          kicker: "The harm is the output, not the leak",
          html: "<b>This is the one thing that never leaves.</b>",
          detail:
            "Cross protocol rows are the novel damage: each protocol's own interface shows only its slice, and that slice can look comfortable while the aggregate does not. A liquidation bot with this table front runs every one of them.",
        },
      ],
    },
    {
      kind: "doc",
      file: "docs/ENCLAVE.md",
      from: 77,
      to: 84,
      note: "the egress specification",
      track: TRACK.cre,
      dur: 8,
      scrollAt: 6.9,
      captions: [
        {
          at: 0.3,
          dur: 7.4,
          kicker: "Chainlink CRE · the confidential boundary",
          html: "Fifteen fields leave the enclave, and every one is specified in advance.",
          detail:
            "<b>No address in any form. No per address row. No coupling bucket below k = 3 borrowers.</b> A runtime check walks the output and throws on anything address shaped, keys as well as values, so the boundary is enforced by code and not by review.",
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
      dur: 8,
      scrollTo: 0,
      captions: [
        {
          at: 0.3,
          dur: 7.4,
          kicker: "Chainlink CRE · handlerInTee",
          html: "The workflow registers a <b>confidential TEE handler</b>, not an ordinary one.",
          detail:
            "CRE is Chainlink's runtime for offchain workflows. Registering with <code>cre.handlerInTee</code> instead of <code>cre.handler</code> is what makes this code run inside a Trusted Execution Environment, where the node operator cannot read its memory. <b>There is no non TEE path in this workflow</b>, so the signal has exactly one producer.",
        },
      ],
    },
    {
      kind: "code",
      file: "cre/sentinel-signal/workflow.ts",
      from: 147,
      to: 160,
      highlight: [149, 157, 158],
      note: "workflow.ts:149, :157, :158",
      track: TRACK.cre,
      dur: 8,
      scrollTo: 0,
      captions: [
        {
          at: 0.3,
          dur: 7.4,
          kicker: "Chainlink CRE · getSecret inside the TEE",
          html: "Two secrets are fetched <b>inside</b> the enclave: the gateway key, and the risk policy itself.",
          detail:
            "<code>runtime.getSecret</code> resolves through CRE's secrets vault at execution time, so neither value is in the workflow binary or in this repository. The policy is secret for the same reason the addresses are: publish a liquidation threshold and a borrower parks one basis point under it.",
        },
      ],
    },
    {
      kind: "terminal",
      cast: "cre-typecheck",
      track: TRACK.cre,
      dur: 6,
      hold: 0,
      zooms: [
        {
          at: 4.1,
          dur: 1.7,
          match: "tsc exit=0",
          lines: 1,
          top: "360px",
          label: "the only evidence a silent command gives",
          source: 'npm run cre:typecheck; echo "tsc exit=$?"',
          explain:
            "<code>tsc --noEmit</code> prints nothing when it is happy, so the shell is asked for the exit code and the ask is part of the command on screen.",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 5.6,
          kicker: "Chainlink CRE · the real SDK",
          html: "It typechecks against Chainlink's own CRE SDK.",
          detail:
            "<code>handlerInTee</code>, <code>TeeRuntime&lt;Config&gt;</code> and <code>getSecret</code> are resolved from <code>@chainlink/cre-sdk</code>, not from a local approximation of the confidential API.",
        },
      ],
    },
    {
      kind: "terminal",
      cast: "cre-test",
      track: TRACK.cre,
      dur: 6,
      hold: 0,
      zooms: [
        {
          at: 2.5,
          dur: 3.3,
          match: "20 pass",
          lines: 3,
          top: "360px",
          label: "the enclave's own logic, under test",
          source: "npm run cre:test",
          explain:
            "Aggregation, k anonymity suppression and report signing, run under <code>bun test</code> the way the enclave runs them.",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 5.6,
          kicker: "Chainlink CRE · what runs in the TEE",
          html: "20 tests over the enclave's path. 0 fail.",
          detail:
            "Including the suppression rule: a coupling bucket with fewer than three borrowers in it is withheld, because a bucket of one is an address.",
        },
      ],
    },
    {
      kind: "terminal",
      cast: "cre-simulate",
      track: TRACK.cre,
      dur: 25,
      hold: 0,
      zooms: [
        {
          at: 11.2,
          dur: 5.8,
          match: "Trigger requested TEE Execution",
          lines: 6,
          fontSize: "20px",
          side: "right",
          top: "270px",
          width: "1560px",
          label: "the CRE CLI's own output",
          source: "cre workflow simulate",
          emphasise: "will not be visible, and will not leave the TEE",
          explain:
            "Chainlink's tooling naming the enclave it dispatched to, and stating the property this whole project is built on: in real execution these logs never leave the TEE.",
        },
        {
          at: 17.4,
          dur: 6.0,
          match: "Workflow Simulation Result",
          lines: 2,
          fontSize: "18px",
          top: "320px",
          width: "1560px",
          label: "the aggregate, and only the aggregate",
          source: "cre workflow simulate",
          explain:
            "Everything the enclave chose to emit, in one string: a score, a multi protocol share, distressed value at the deepest shock, and a count of buckets it withheld. <b>No address, no row, no per borrower field.</b>",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 4.2,
          kicker: "Chainlink CRE · the CLI, end to end",
          html: "The confidential workflow, compiled and dispatched by <b>Chainlink's own CLI</b>.",
          detail:
            "<code>cre workflow simulate</code> builds the TypeScript to WASM, loads the secrets from <code>secrets.yaml</code>, starts the engine and fires the cron trigger. Every line in this shot is Chainlink's CLI.",
        },
        {
          at: 4.6,
          dur: 3.6,
          kicker: "What the CLI is doing",
          html: "WASM built, binary hashed, simulation limits set, engine up.",
          detail:
            "The same pipeline a deployed workflow goes through, run locally against live subgraph data.",
        },
        {
          at: 8.4,
          dur: 2.6,
          kicker: "Then it says where the handler runs",
          html: "Watch the next line.",
          detail: "Chainlink's own tooling is about to state the property this project is built on.",
        },
        // Deliberate silence from 11.2 to 17.4: the TEE box gets six seconds with nothing competing
        // with it. It is the one thing on screen in this video that an independent tool wrote.
        {
          at: 17.4,
          dur: 6.0,
          kicker: "Exit 0",
          html: "Score <b>22.0</b> at block 25,966,825. 4 protocols, 90 borrowers, <b>3 coupling buckets withheld</b>.",
          detail:
            "1.25% of evaluable debt is multi protocol, and $1,215,530,120 is distressed at the deepest shock. The three withheld buckets are the k anonymity floor doing its job on live data.",
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
      // drive 5.5s to 13.2s, the app's own fps line read at 16.6s, the coupling graph at 19.2s.
      from: 2.0,
      track: TRACK.graph,
      dur: 20,
      captions: [
        {
          at: 0.4,
          dur: 3.8,
          kicker: "The second schema",
          html: "A liquidation you cannot sell into real depth is not a liquidation.",
          detail:
            "Lending subgraphs say what is owed. They say nothing about whether the collateral can actually be sold at that price.",
        },
        {
          at: 4.4,
          dur: 3.4,
          kicker: "Operable, and measured",
          html: "Driven from the keyboard alone, with a visible focus ring.",
          detail: "41 shock rungs, precomputed once on the server so the slider never blocks on a query.",
        },
        {
          at: 8.0,
          dur: 5.0,
          kicker: "The Graph · a second standardized schema",
          html: "Exit liquidity read from four <b>DEX AMM</b> subgraphs: 636 live depth queries over 159 pairs.",
          detail:
            "Uniswap V2, Uniswap V3, Sushiswap and Balancer, answering one document again because they too share a standard. Queries are deduplicated by pool, so the same pool is never paid for twice.",
        },
        {
          at: 13.4,
          dur: 3.0,
          kicker: "Composed, not concatenated",
          html: "<b>Two standardized schemas in one pipeline.</b>",
          detail:
            "Lending risk parameters from one standard meet actual market depth from the other, and the cascade runs round after round until it stops.",
        },
        {
          at: 16.6,
          dur: 3.2,
          kicker: "The page measures itself",
          html: "<b>60 fps over 487 frames, worst single frame 16.8 ms.</b>",
          detail: "Measured in the browser while it is being used, not asserted in a README.",
        },
      ],
    },

    // ── 6. And an agent can use all of it ────────────────────────────────────
    {
      kind: "terminal",
      cast: "mcp-handshake",
      track: TRACK.ai,
      dur: 14,
      hold: 0,
      zooms: [
        {
          at: 3.2,
          dur: 4.6,
          match: "MCP server ready",
          lines: 1,
          // Low enough to leave the handshake it is quoting visible above it, rather than sitting
          // directly on the line and reading as a duplicate.
          top: "420px",
          label: "the server, over real JSON-RPC",
          source: "npm run mcp:handshake",
          explain:
            "MCP is the protocol an AI client uses to discover and call tools. This is a genuine <code>initialize</code> and <code>tools/list</code> exchange on stdio, not a description of one: <b>8 tools, backed by 5 deployments.</b>",
        },
        {
          at: 8.2,
          dur: 5.4,
          match: "handshake ok",
          lines: 1,
          side: "right",
          top: "330px",
          label: "a tool call, answered from live data",
          source: "npm run mcp:handshake",
          explain:
            "<code>sentinel_alert</code> pinned head 25,966,800 back to 25,966,790, scored it at 22.01, compared it against the same hour last week at 21.84, and returned 1760 characters saying <b>no alert</b>, because 0.16 points is below the weakest calibrated threshold.",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 2.8,
          kicker: "The Graph · AI tooling, built from scratch",
          html: "An <b>MCP server</b> and an agent <b>SKILL</b> for querying The Graph.",
          detail:
            "Reusable infrastructure any agent can mount, not a single end user chatbot. Every tool reads standardized subgraphs live.",
        },
        {
          at: 3.2,
          dur: 4.6,
          kicker: "Discoverable over the wire",
          html: "8 tools, and the handshake is in frame.",
          detail:
            "Score, cross protocol exposure, cascade, coupling, deployment health, raw subgraph query, and the alert comparison.",
        },
        {
          at: 8.2,
          dur: 5.4,
          kicker: "One block per session",
          html: "Every answer is pinned to a single block: <b>25,966,790</b>.",
          detail:
            "An agent that reads a different block per tool call produces a coherent looking answer about a state that never existed. Pinning is what makes the citations mean anything.",
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
        {
          at: 0.3,
          dur: 3.7,
          kicker: "The SKILL, answering",
          html: "Ask it what the risk is.",
          detail: "The SKILL is the routing layer: a question, the tool it picks, and the answer it is allowed to give.",
        },
        {
          at: 4.2,
          dur: 3.9,
          kicker: "Citations are the contract",
          html: "Every figure arrives with <b>the subgraph and the block it was read at</b>.",
          detail:
            "The SKILL has one rule above all others: never state a number a tool did not return. That is what stops the agent from smoothing over a gap in the data.",
        },
        {
          at: 8.4,
          dur: 3.0,
          kicker: "Now ask for the harm",
          html: "Ask it for the address list, which is the thing this project actually computes.",
          detail: "The agent has a tool that can run arbitrary subgraph queries, so it has the means.",
        },
        {
          at: 11.6,
          dur: 4.2,
          kicker: "Refused in the server",
          html: "<b>The refusal is code, not a prompt instruction.</b>",
          detail:
            "The MCP tool inspects its own result and throws on anything address shaped before it is ever returned, so the refusal survives an adversarial user and a jailbroken model alike.",
        },
      ],
    },

    // ── 7. It ends on-chain ──────────────────────────────────────────────────
    {
      kind: "terminal",
      cast: "consume-signal",
      track: TRACK.cre,
      dur: 10,
      hold: 0,
      zooms: [
        {
          at: 3.0,
          dur: 3.2,
          match: "sentinel-signal/1 from sentinel",
          lines: 1,
          fontSize: "17px",
          top: "300px",
          width: "1560px",
          label: "accepted, and what it says",
          source: "npm run consume-signal",
          explain:
            "The whole payload, decoded by a consumer that has never seen the workflow's code. Thirteen aggregate numbers, a block, and a version string. Nothing else fits through.",
        },
        {
          at: 6.4,
          dur: 3.4,
          match: "7 of 7 mutations refused",
          lines: 1,
          side: "right",
          top: "340px",
          label: "and what it refuses",
          source: "npm run consume-signal",
          explain:
            "A flipped body byte, a rewritten DON id, a replay under a new sequence number, an outside signer, a duplicated signature faking a quorum, another workflow's report, and a genuine report that is simply too old. <b>All seven rejected.</b>",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 2.6,
          kicker: "Chainlink CRE · what leaves the enclave",
          html: "A signed report, for <b>DON consensus, external delivery and onchain settlement</b>.",
          detail:
            "The enclave signs its aggregate, so a reader can check the signal without trusting the machine that ran it.",
        },
        {
          at: 3.0,
          dur: 3.2,
          kicker: "Verified by a stranger",
          html: "This consumer is <code>viem</code> only, with no CRE toolchain installed.",
          detail: "It reconstructs the report identity and checks the signer quorum from the bytes alone.",
        },
        {
          at: 6.4,
          dur: 3.4,
          kicker: "No trust in the publisher required",
          html: "<b>7 of 7 tampered variants refused, 1 genuine report accepted.</b>",
          detail: "Every rejection prints the reason, which is the part that would be easy to fake and is not faked here.",
        },
      ],
    },
    {
      kind: "terminal",
      cast: "forge-test",
      track: TRACK.cre,
      dur: 9,
      hold: 0,
      zooms: [
        {
          at: 2.6,
          dur: 6.0,
          match: "tests passed",
          lines: 1,
          fontSize: "20px",
          top: "340px",
          width: "1520px",
          label: "the same checks, in Solidity",
          source: "cd contracts && forge test",
          explain:
            "<code>SentinelConsumer</code> parses the report identity and verifies the signer quorum onchain; <code>GuardedVault</code> is a lending vault that pauses new borrowing when the signal goes to alert. <b>Automated liquidation protection driven by risk thresholds that stay private.</b>",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 2.2,
          kicker: "It settles onchain",
          html: "24 consumer tests, 13 vault tests.",
          detail: "Quorum, staleness, replay, duplicated signers and a wrong workflow name, all checked in Solidity.",
        },
        {
          at: 2.6,
          dur: 6.0,
          kicker: "The end of the confidential workflow",
          html: "A contract acts on a number whose <b>inputs it can never see</b>.",
          detail:
            "That is the shape of the whole system: the addresses stay in the enclave, the score comes out signed, and a vault tightens its own lending against it without anyone learning who was levered where.",
        },
      ],
    },

    // ── 8. The backtest, and one command for all of it ────────────────────────
    //
    // The backtest earns its place here rather than in the results sections, because what it
    // measured is an argument against the alert policy. `npm run backtest:cascades` writes this
    // table; the shot is the file it wrote, not a slide about it.
    {
      kind: "doc",
      file: "docs/evidence/phase6-early-warning.md",
      from: 28,
      to: 36,
      note: "npm run backtest:cascades · 5 episodes, 20 controls",
      dur: 13,
      captions: [
        {
          at: 0.2,
          dur: 4.2,
          kicker: "Backtested against real liquidations",
          html: "<b>3 of 5 episodes detected, at a 24 hour median lead time.</b>",
          detail:
            "Each episode is paired against the same hour of the previous week, so a detection has to beat the ordinary weekly drift and not just the calm.",
        },
        {
          at: 4.6,
          dur: 4.2,
          kicker: "The unflattering row is the result",
          html: "<b>At the strictest operating point it detects nothing.</b>",
          detail:
            "All three operating points are published rather than the best one chosen. With only 5 episodes, picking between them by which detects more is fitting the policy to the labels.",
        },
        {
          at: 9.2,
          dur: 3.6,
          kicker: "Stated bounds, not estimates",
          html: "The backtest replays <b>96 of 319</b> known episodes.",
          detail:
            "Only 2 of the 5 deployments answer time travel queries on The Graph, so the rest cannot be read at a past block. The coverage is printed rather than the sample being presented as the whole.",
        },
      ],
    },
    {
      kind: "terminal",
      cast: "verify",
      dur: 23.5,
      hold: 0,
      // 6s at real speed, then the 113s middle compressed into 6s with the badge on screen, then the
      // last 0.6s at real speed so the summary lands live. The rest of the segment holds on it.
      plays: [
        [0, 6000, 1],
        [6000, -600, fit(6.0)],
        [-600, null, 1],
      ],
      zooms: [
        {
          at: 15.2,
          dur: 8.0,
          // The summary block is legible in the terminal underneath, so the card quotes the last
          // line instead of repeating what is already on screen, and sits high enough not to cover it.
          match: "verify OK",
          lines: 1,
          fontSize: "27px",
          top: "180px",
          width: "1240px",
          label: "one command, every claim above",
          source: "npm run verify",
          explain:
            "18 of 18 stages in 120.5 seconds, and the run is dominated by one of them on purpose: <code>cascade</code> makes 636 live DEX depth queries and is gateway bound, not client bound. Nothing here is cached and nothing is mocked.",
        },
      ],
      captions: [
        {
          at: 0.2,
          dur: 4.0,
          kicker: "Reproducible",
          html: "Every claim above re-verifies in <b>one command</b>.",
          detail: "<code>npm run verify</code>, on a clean checkout, against live data.",
        },
        {
          at: 4.4,
          dur: 5.0,
          kicker: "18 stages, live",
          html: "Preflight, the snapshot, the cascade, the enclave, the CRE simulation, the consumer, Solidity, and a real browser.",
          detail:
            "Each stage prints what it proves, so the output is a checklist a judge can read against the tracks rather than a wall of green.",
        },
        {
          at: 9.8,
          dur: 4.4,
          kicker: "The ramp is marked",
          html: "Time was compressed here. <b>No output was removed.</b>",
          detail:
            "The badge is on screen for exactly the stretch that is sped up. Every line the command printed is still here, in order.",
        },
        {
          at: 15.2,
          dur: 8.0,
          kicker: "Every stage green",
          html: "<b>18 of 18, in 120.5 seconds, on live data.</b>",
          detail:
            "A cold start path of 61.4 seconds from nothing to a signed signal. Nothing in this project needs a mock to pass.",
        },
      ],
    },
    {
      kind: "card",
      id: "close",
      // Three lines and out. The provenance sentence and the track list that used to close the card
      // were both about the submission rather than about the product, and a demo ends on the product.
      dur: 5.5,
      lines: [
        { at: 0.2, hold: 5.1, html: "Sentinel" },
        {
          at: 0.9,
          hold: 4.4,
          class: "sub",
          html: "<code style=\"font-family:ui-monospace,Menlo,monospace;color:var(--color-accent)\">npm run verify</code>",
        },
        { at: 1.7, hold: 3.6, class: "sub", html: "github.com/LegendaryPenguin/EthOnline" },
      ],
    },
  ],
};
