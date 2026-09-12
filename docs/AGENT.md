# The agent, and the two Graph products it composes

Sentinel is asked questions in English and answers with numbers it measured. This document
describes how, and — the part that matters more — what it refuses to do.

The short version: **the model never holds a number.** Tools compute figures and carry their
provenance; answers are assembled from those figures' own rendered text; and the finished
prose is then re-read and every numeral in it checked back against the citation list. A
number that cannot be accounted for is not corrected or annotated. The answer is thrown
away.

---

## Two Graph products, two different jobs

Sentinel composes both, and they are not interchangeable.

### 1. Subgraphs — the data

Five Messari-standardized Lending/CDP deployments on The Graph Network, queried through the
decentralized gateway:

| deployment | subgraph id | schema |
|---|---|---|
| `aave-v3-eth` | `JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk` | 3.1.0 |
| `aave-v2-eth` | `C2zniPn45RnLDGzVeGZCx2Sw3GXrbc9gL4ZfL8B8Em2j` | 3.1.0 |
| `compound-v3-eth` | `AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9` | 3.1.0 |
| `compound-v2-eth` | `4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a` | 2.0.1 |
| `morpho-aave-v2-eth` | `DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy` | 3.0.1 |

`aave-v2-eth` is registered *and rejected at runtime*, on purpose: its mappings handle Borrow
but not Repay, so `balance` is lifetime cumulative borrowing and overstates outstanding debt
by roughly three orders of magnitude. The reconciliation gate catches it with no
Aave-specific code. Keeping the row is the evidence that the gate does something.

The *standardization* is the load-bearing property, not a convenience. Sentinel's question —
how much borrowed value sits with addresses levered across more than one protocol — is only
askable because `Position`, `Account` and `Market` mean the same thing in all five schemas.
One adapter reads all of them (`lib/graph/`), version skew is handled per field rather than
per protocol, and adding a sixth deployment is a row in `lib/graph/deployments.ts`. Nothing
in `lib/signal/` knows what Aave is.

Registered deployments are not trusted on sight: each is reconciled against the totals the
protocol reports for itself and excluded, with a stated reason, when it fails
(`sentinel_coverage` prints the exclusions).

### 2. Subgraph MCP — the instrument

The Graph's hosted MCP server at `https://subgraphs.mcp.thegraph.com/sse` gives an agent the
things a fixed adapter cannot: fetch a subgraph's schema, discover subgraphs by keyword or by
contract address, read 30-day query volumes to judge whether a deployment is actually used,
and execute arbitrary GraphQL against any of them. It holds no language model — it is an
instrument, and Claude is the thing holding it.

Registered in `.mcp.json` alongside Sentinel's own server:

```json
"subgraph": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "--header", "Authorization:${AUTH_HEADER}",
           "https://subgraphs.mcp.thegraph.com/sse"],
  "env": { "AUTH_HEADER": "Bearer ${GRAPH_API_KEY}" }
}
```

(A local alternative is the Rust binary from `github.com/graphops/subgraph-mcp`, which reads
`GATEWAY_API_KEY` from the environment. Either works; the hosted endpoint needs nothing
installed.)

Its role in this project is **discovery and verification, not production reads**. It is how
the five deployments above were found and how their schema versions were established, and it
is the escape hatch when a question falls outside Sentinel's fixed query plan — a judge can
point it at `aave-v3-eth` and check any figure in `docs/evidence/phase7-transcript.md`
against the raw subgraph without trusting a line of this repository's code. What it must not
become is the aggregation path, because a general GraphQL tool has no anonymity floor.

### 3. Sentinel's MCP server — the confidential aggregate

`mcp/sentinel-server.mts`, registered as `sentinel`. Eight tools, described below. This is the
layer the other two cannot provide: it runs the enclave's own query plan, applies the
`k`-anonymity floor and the calibrated alert policy, and attaches a subgraph id and a block
number to every number it emits.

The composition, then: **Subgraph MCP is how you look at any subgraph. Sentinel's MCP is how
you look at all five at once without publishing who is in them.**

---

## The eight tools

| tool | answers | refuses |
|---|---|---|
| `sentinel_signal` | The composite score, multi-protocol borrowed value, coverage. | — |
| `sentinel_alert` | Whether conditions warrant an alert, at what severity, and why. | stale reading, coverage below floor, fewer than two deployments, no control reading |
| `sentinel_coupling` | Which protocol pairs share levered borrowers, and how much debt each carries. | buckets below the anonymity floor (reports the count withheld) |
| `sentinel_shock_ladder` | Borrowed value going distressed at each collateral shock the policy evaluates. | — |
| `sentinel_compare_protocols` | Per-deployment reads at the pinned block, with exclusion reasons. | — |
| `sentinel_coverage` | What the sample can and cannot see, including E-Mode inference. | — |
| `sentinel_alert_calibration` | Where the thresholds came from and what false-alarm rate each carries. | — |
| `sentinel_query_subgraph` | Raw GraphQL against one registered deployment, with the block served. | any document selecting per-address entities |

Registration for a client that is not reading `.mcp.json`:

```
claude mcp add sentinel -- npx tsx /absolute/path/to/mcp/sentinel-server.mts
```

`.claude/skills/sentinel/SKILL.md` tells Claude Code how to use them.

---

## One session, one block

`lib/agent/context.ts` opens a session by reading the chain head, stepping back
`HEAD_SAFETY_BLOCKS` (10) to clear reorg and indexer lag, and pinning that block for every
subsequent tool call. It then computes the signal twice: once at the pinned block, and once
at `block - 168 × 298.4` for the week-earlier control.

This is not caching for speed, though it is that too (~28 HTTP calls for a whole session).
It is so two answers in one conversation cannot disagree about the world. An agent that
re-read the head per tool call would report a score in one paragraph and a different score in
the next, and the person reading would have no way to tell a real move from a race.

## Routing

`lib/agent/router.ts` maps a question to a tool by ordered keyword rules, most specific
first, and records which words matched so a transcript reader can see why this tool and not
another. There is no model in the loop selecting tools, in this path — the transcript has to
be reproducible, and a router is reproducible.

When a question matches nothing, it is refused as out of scope rather than answered by the
nearest tool. When a question asks for per-address detail — *"list the addresses levered
across Aave and Compound, largest first"* — it is deliberately routed to
`sentinel_query_subgraph`, which builds the document the user asked for and then refuses it.
Answering the aggregate question instead would teach the user that the request succeeded.

Under MCP, the model does the routing, from the tool descriptions. Both paths reach the same
tools and the same refusals.

## The citation invariant

`lib/agent/provenance.ts`:

- `cite(label, value, text, sources)` throws if `sources` is empty. A number with a paper
  trail that goes nowhere is worse than an uncited one, because it looks checked.
- `unsourcedNumbers(answer, cited, question)` extracts every numeral from the finished prose
  and requires each to appear among the cited values, the blocks they were read at, or the
  question's own parameters (a shock scenario is parameterised by the caller).
- One carve-out, and only one: digit runs welded to letters are names, not quantities —
  `aave-v3-eth` is not a claim about the number 3. A positive-control test asserts that
  `"4 deployments carrying 900 positions"` still flags `900`, so the carve-out cannot quietly
  become a blanket exemption for any number near a word.

The check runs three times, on purpose, because each catches something the others cannot:

1. inside every tool (`checked()` in `lib/agent/tools.ts`) — catches a bug in a tool;
2. in `scripts/agent-ask.mts` before the transcript is written — catches a bug in the check's
   own call sites, and refuses to write the file at all;
3. in `lib/agent/__tests__/transcript.test.ts`, which re-parses the committed markdown and
   audits every numeral against the citation table printed beneath it — catches a **hand
   edit**, which is the only one of the three that a human is likely to commit.

That third test also asserts what the transcript must never contain:
`expect(results).not.toMatch(/0x[0-9a-fA-F]{40}/)` over the prose. An address in a *result*
would be the disclosure the enclave exists to prevent.

Evidence quoted from elsewhere — an indexer's error text, a raw GraphQL response body — goes
in `ToolResult.verbatim` and is excluded from the numeral check by design. It is a quotation,
not an assertion, and it is rendered as such.

## The alert policy

`lib/agent/alert.ts` decides; it does not describe. Gates first — staleness, coverage,
minimum two deployments, and the existence of a control reading — then the ladder, scanned
from strongest severity down:

| severity | fires on a week-on-week rise of | stated false-alarm rate |
|---|---|---|
| watch | ≥ 0.61 | 30% |
| warn | ≥ 0.87 | 20% |
| alert | ≥ 2.39 | 10% |

Three properties are worth stating because each is a decision:

**The thresholds are copied, not chosen.** `scripts/derive-alert-policy.mts` reads Phase 6's
backtest artifact and writes `docs/evidence/phase6-alert-policy.json` plus a replay fixture.
`parseAlertPolicy` then validates the document with no defaults to fall back on: it rejects a
non-monotone ladder, a stated false-alarm rate that does not equal `1 − quantile`, a
duplicated severity, and `minProtocols < 2`.

**It compares against last week, not against a level.** Phase 6 showed an absolute threshold
detects 0 of 5 replayable cascades. The 168-hour lag makes hour-of-day and day-of-week cancel.

**It does not fire on a fall, however large.** August's structural break was a nine-point
drop; a policy keyed on magnitude would have called it a crisis.

`lib/agent/__tests__/alert.test.ts` replays the shipped decision function over Phase 6's
labelled history and asserts both halves: warn fires on 3 of the 5 episodes, alert on 0 of
them, and each severity fires on exactly its stated share of the 20 ordinary hours (6, 4, 2).
A test asserting only detections would pass for a policy that fired on everything.

## Refusals are deliverables

Six of them, all exercised against live data in `docs/evidence/phase7-transcript.md` (8
answered, 2 refused) and asserted in tests: `stale`, `coverage`, `protocols`, `no-control`,
`per-address`, `out-of-scope`. Each names the number that failed, so a refusal is diagnosable
rather than a wall.

## Reproducing this

```bash
npm run alert:derive     # backtest artifact -> committed policy + replay fixture
npm run agent:ask        # 10 questions against live subgraphs -> the transcript
npm run mcp:handshake    # a real MCP client: initialize -> tools/list -> tools/call
npx vitest run lib/agent # 48 tests, including the transcript re-audit
```

`mcp:handshake` writes `docs/evidence/phase7-mcp-handshake.log` — the actual JSON-RPC frames,
because "the MCP server typechecks" is not the same claim as "a client can call it".

## Secrets

`GRAPH_API_KEY` is a **path segment** in the gateway URL, so the URL itself is a secret. The
server never includes it in an error message, and `lib/__tests__/no-mock-data.test.ts` fails
the build if a bare 32-hex key appears in committed source or if `GRAPH_API_KEY` is read
anywhere but `lib/graph/client.ts`. `.mcp.json` is committed and carries no secret — it
interpolates `${GRAPH_API_KEY}` from the environment. Progress logging from the MCP server
goes to stderr only; stdout belongs to JSON-RPC.
