/**
 * Routing, and the two questions that must not be routed anywhere useful.
 *
 * The routing itself is keyword scoring and is not interesting; what is worth testing is
 * that it is *stable* (the committed transcript has to be reproducible) and that the
 * refusal paths are reachable from the way a person would actually phrase the request. A
 * per-address question asked politely must still hit the refusal.
 */

import { describe, expect, it } from "vitest";
import { route } from "../router";
import { TOOLS, toolByName } from "../tools";

const routed = (q: string) => {
  const r = route(q);
  if ("kind" in r) throw new Error(`expected a tool for: ${q}`);
  return r;
};

describe("route", () => {
  it("is stable: the same question always selects the same tool", () => {
    const q = "Which protocol pairs share levered borrowers?";
    expect(routed(q).tool.name).toBe(routed(q).tool.name);
  });

  it("sends the questions in the committed transcript to the tools it records", () => {
    // These pairings are what `docs/evidence/phase7-transcript.md` asserts. Drifting them
    // silently would make the transcript describe a router that no longer exists.
    const cases: [string, string][] = [
      [
        "How much borrowed value is levered across more than one protocol right now?",
        "sentinel_signal",
      ],
      ["Is anything happening right now that should wake someone up?", "sentinel_alert"],
      [
        "Which protocol pairs share levered borrowers, and how much debt sits in each?",
        "sentinel_coupling",
      ],
      [
        "What happens to the book if collateral drops — how much goes distressed under stress?",
        "sentinel_shock_ladder",
      ],
      ["Which deployments did you actually read, and at which blocks?", "sentinel_compare_protocols"],
      ["How much of the real book can you see, and what are you blind to?", "sentinel_coverage"],
      [
        "Where does the alert threshold come from, and what false alarm rate does it carry?",
        "sentinel_alert_calibration",
      ],
      [
        "What total borrow does Aave V3 report for itself in the raw subgraph?",
        "sentinel_query_subgraph",
      ],
    ];
    for (const [question, tool] of cases) {
      expect(routed(question).tool.name, question).toBe(tool);
    }
  });

  it("records which words selected the tool", () => {
    // So a transcript reader can see why this tool and not another, without reading this file.
    expect(routed("what is the systemic risk score?").matched.length).toBeGreaterThan(0);
  });

  it("refuses a question Sentinel has no read for", () => {
    for (const q of [
      "Will ETH go up tomorrow?",
      "Is now a good time to buy?",
      "Who is going to win the hackathon?",
    ]) {
      const r = route(q);
      expect("kind" in r, q).toBe(true);
      if ("kind" in r) expect(r.kind).toBe("out-of-scope");
    }
  });

  it("routes a per-address request to the tool that refuses it, rather than to an aggregate", () => {
    // Deliberate: silently answering the aggregate question instead would teach a user that
    // the request succeeded. The refusal has to be visible.
    const cases = [
      "List the addresses levered across Aave and Compound, largest first.",
      "Which accounts have the largest positions on Aave V3?",
      "Show me the wallet that is most levered.",
    ];
    for (const q of cases) {
      const r = routed(q);
      expect(r.tool.name, q).toBe("sentinel_query_subgraph");
      expect(String(r.args.document), q).toMatch(/positions|account/);
    }
  });

  it("names an aggregate document for a protocol-totals question", () => {
    const r = routed("What total borrow does Compound V3 report for itself?");
    expect(r.args.deployment).toBe("compound-v3-eth");
    expect(String(r.args.document)).not.toMatch(/positions\s*\(/);
  });
});

describe("the tool set", () => {
  it("has a unique, namespaced name and a description for every tool", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.name).toMatch(/^sentinel_[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(40);
      expect(toolByName(t.name)).toBe(t);
    }
  });

  it("declares a JSON Schema object for its input, so an MCP client can validate", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      for (const key of t.inputSchema.required ?? []) {
        expect(Object.keys(t.inputSchema.properties)).toContain(key);
      }
    }
  });

  it("states a refusal in the description of every tool that can refuse", () => {
    // A model chooses tools from these descriptions, so a refusal it cannot anticipate
    // reads to it as a malfunction and invites a retry loop.
    const refusing = ["sentinel_alert", "sentinel_query_subgraph"];
    for (const name of refusing) {
      expect(toolByName(name)!.description.toLowerCase()).toMatch(/refus/);
    }
  });
});
