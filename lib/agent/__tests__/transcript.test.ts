/**
 * The committed transcript, re-audited.
 *
 * `scripts/agent-ask.mts` checks its own output before writing, which protects against a
 * bug in a tool. This protects against something the script cannot: a *hand edit*. The
 * transcript is the artifact a judge or a reviewer reads, and the whole claim it carries is
 * that no number in it was written by a human or a model — so the file on disk is parsed
 * back apart here, and every numeral in every answer is checked against the citation table
 * printed beneath it.
 *
 * If someone tidies a figure in that file, this test fails and names the number.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../tools";

const PATH = "docs/evidence/phase7-transcript.md";
const MIN_QUESTIONS = 8;

const text = existsSync(PATH) ? readFileSync(PATH, "utf8") : "";

/**
 * One question section: its prose, its quoted blocks, and its citation table.
 *
 * Split on the numbered `## n.` headings the script writes. Anything before the first one
 * is preamble and anything after the last question's table is the closing section; neither
 * makes a numeric claim, and both are excluded rather than parsed.
 */
type Section = { heading: string; body: string };

function sections(md: string): Section[] {
  const out: Section[] = [];
  const parts = md.split(/\n## (?=\d+\. )/);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    // The closing "What this does and does not show" section trails the last question and
    // quotes Phase 6's figures, which are cited there rather than here.
    const body = part.slice(nl + 1).split("\n## ")[0];
    out.push({ heading: part.slice(0, nl).trim(), body });
  }
  return out;
}

/** Numbers a section is allowed to state: those in its own citation table, and its own question. */
function allowedNumbers(section: Section): Set<string> {
  const allowed = new Set<string>();
  const add = (s: string) => {
    for (const m of s.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
      allowed.add(m[0].replace(/,/g, ""));
      allowed.add(String(Number(m[0].replace(/,/g, ""))));
    }
  };
  add(section.heading);
  for (const line of section.body.split("\n")) {
    // Citation table rows, the routing line, quoted evidence, and the tool's arguments are
    // all sources rather than claims.
    if (/^\|/.test(line) || /^> /.test(line) || /^\*\*Tool\*\*/.test(line)) add(line);
  }
  // Fenced argument blocks: the document a tool was asked to run is an input, not an answer.
  for (const fence of section.body.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) add(fence[1]);
  return allowed;
}

/** The prose lines of a section: what Sentinel asserts in its own voice. */
function proseLines(section: Section): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const line of section.body.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\|/.test(line) || /^> /.test(line) || /^\*\*Tool\*\*/.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

describe("phase7 transcript", () => {
  it("exists — the phase's deliverable is the evidence, not the code", () => {
    expect(text.length).toBeGreaterThan(0);
  });

  it("covers at least the required number of questions", () => {
    expect(sections(text).length).toBeGreaterThanOrEqual(MIN_QUESTIONS);
  });

  it("states no number that its own citations do not account for", () => {
    const offences: string[] = [];
    for (const section of sections(text)) {
      const allowed = allowedNumbers(section);
      for (const line of proseLines(section)) {
        for (const m of line.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
          const before = m.index > 0 ? line[m.index - 1] : "";
          const after = line[m.index + m[0].length] ?? "";
          // Digits inside identifiers are names: aave-v3-eth, compound-v2-eth.
          if (/[a-zA-Z]/.test(before) || /[a-zA-Z]/.test(after)) continue;
          const raw = m[0].replace(/,/g, "");
          if (!allowed.has(raw) && !allowed.has(String(Number(raw)))) {
            offences.push(`${section.heading}: ${raw}`);
          }
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("cites a subgraph and a block for every answered question", () => {
    for (const section of sections(text)) {
      const answered = !/\*\*Refused\*\*|No tool ran/.test(section.body);
      if (!answered) continue;
      expect(section.body, section.heading).toContain("| number | value | subgraph | block |");
      // A subgraph id is 46 base58 characters; a table row without one is not provenance.
      expect(section.body, section.heading).toMatch(/`[1-9A-HJ-NP-Za-km-z]{40,}`/);
    }
  });

  it("records both refusals: the per-address request and the out-of-scope question", () => {
    // These are the two answers Sentinel must not give. Their absence from the transcript
    // would mean the refusal paths are untested against live data.
    expect(text).toMatch(/gate `per-address`/);
    expect(text).toMatch(/gate `out-of-scope`/);
  });

  it("never prints a per-address leverage row", () => {
    // The product thesis, asserted against the artifact: an 0x address in a *result* would
    // be the disclosure the enclave exists to prevent. Addresses appear in this file only
    // inside the refused query document, which is an input.
    const results = sections(text)
      .map((s) => proseLines(s).join("\n"))
      .join("\n");
    expect(results).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it("names a tool that exists for every routed question", () => {
    const names = new Set(TOOLS.map((t) => t.name));
    for (const section of sections(text)) {
      const m = section.body.match(/\*\*Tool\*\* `([a-z_]+)`/);
      if (!m) continue;
      expect(names, section.heading).toContain(m[1]);
    }
  });

  it("pins a single block for the session", () => {
    expect(text).toMatch(/pins one block/);
    expect(text).toMatch(/\*\*\d{8}\*\*/);
  });
});
