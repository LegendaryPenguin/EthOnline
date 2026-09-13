# The three tracks, in the sponsors' own words

Verbatim from the ETHOnline 2026 prize pages, recorded here so `docs/EVIDENCE.md` can be
checked line by line against what was actually asked for rather than against a paraphrase of
it. Nothing in this file is our writing except the headings.

---

## The Graph — 🧩 Best Use of Composable or Standardized Graph Products — $5,000 (3 slots)

> Build on The Graph's composable and standardized data products. Use Standardized Subgraphs
> (one shared schema across every protocol of a type) to run a single query across many
> protocols, compose reusable Substreams packages into new pipelines, or layer the Subgraph MCP
> on top for cross-protocol analysis. Contributing a new composable Substreams module for an
> emerging standard, such as ERC-4626 tokenized-vault flows, also counts. The best submissions
> show the leverage of standards: one query pattern spanning many protocols, or one pipeline
> reused across chains.

**Qualification Requirements**

1. > Either compose two or more of The Graph's products, or build meaningfully on a
   > standardized schema (for example the Messari Standardized Subgraphs).
2. > Consume live data from a Graph provider, for example Subgraph Studio for Subgraphs or The
   > Graph Market for Substreams. Mocked, local-only, or static datasets do not qualify.
3. > Simply querying one Subgraph with no composition or standardization does not qualify;
   > consider the Best AI Use Case track instead.
4. > Authoring or extending a Standardized Subgraph, or contributing a reusable composable
   > Substreams module, is in scope.
5. > Make the standards leverage clear: show what became easier because a shared schema or
   > composed product was used.
6. > Submit a public repository and a short demo video (two to four minutes).

---

## The Graph — 🤖 Best AI Tooling or AI Use Case (From Scratch) — $5,000 (3 slots)

> One AI track, two ways to build. It rewards both the tooling that makes The Graph easier to
> use from AI environments like Claude, Cursor, and ChatGPT (new or extended MCP servers, agent
> SKILLs, x402 payment tooling, A2A integrations, framework plugins, or client configs) and the
> AI agents or apps that use The Graph as their live source of blockchain data (research
> assistants, trading and execution agents, portfolio copilots, risk monitors, and more).

Two eligibility pools. **We are in the Start Fresh (net-new) pool** — this project was begun
and built during the hackathon.

> **Net-new (Start Fresh)**: projects begun and built during the hackathon. Open-source starter
> kits are fine; project-specific prior code is not.

**Qualification Requirements**

1. > Use The Graph as a load-bearing part of the project: either the AI tooling targets The
   > Graph's products or AI Suite, or the agent/app uses The Graph (Subgraphs, the Subgraph MCP,
   > or Substreams) as its source of blockchain data.
2. > Consume live data from a Graph provider, for example querying Subgraphs with an API key
   > from Subgraph Studio, or streaming Substreams via The Graph Market. Mocked, local-only, or
   > static datasets do not qualify.
3. > Do meaningful work with the data: reasoning, decisions, automation, or a natural-language
   > interface, not just printing a raw query result. Tooling submissions must be reusable
   > infrastructure, not a single end-user app.
4. > Open-source the code with a clear README or SKILL.md so judges can run it, and submit a
   > public repository plus a short demo video (two to four minutes).
5. > Select the pool that matches how you built: Start Fresh for net-new, Continuity for
   > extending an existing repo or product. Follow that pool's ETHGlobal rules and document any
   > pre-existing work.

---

## Chainlink — 🔗 Best Confidential Workflow — $2,000 (2 slots, $1,000 each)

> Build a privacy-preserving Web3 application with Chainlink Runtime Environment (CRE)
> Confidential Workflows. With Confidential Workflows, developers can designate sensitive parts
> of a CRE Workflow to execute inside a hardware-isolated Trusted Execution Environment (TEE).
> Secrets can be fetched directly inside the enclave, while sensitive inputs, API responses, and
> intermediate computation remain protected during execution. Developers explicitly control what
> stays confidential and what leaves the enclave for DON consensus, external delivery, or onchain
> settlement.

Two of their own listed example use cases describe this project:

> - Automated liquidation protection using private risk thresholds and execution strategies
> - Privacy-preserving risk assessment and policy enforcement

**Qualification Requirements**

1. > Build a CRE Workflow that uses the Confidential Workflows to execute a meaningful part of
   > the application.
2. > The workflow must register and use a confidential TEE handler, such as `handlerInTee` in
   > TypeScript or `cre.HandlerInTee` in Go.
3. > The confidential portion of the workflow must process at least one sensitive input, secret,
   > confidential API response, private parameter, or intermediate value inside the enclave.
4. > The Confidential Workflow must be meaningfully integrated into the project's core
   > functionality. A placeholder handler or an isolated example that does not contribute to the
   > application will not qualify.
5. > Demonstrate a successful execution through either: A Confidential Workflow simulation using
   > the CRE CLI or a live deployment on the CRE network.
6. > Provide evidence of the successful simulation or deployment in the submission, such as a
   > demo video, terminal output, execution logs, or deployment details.
