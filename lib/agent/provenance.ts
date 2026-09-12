/**
 * Provenance for every number an answer contains.
 *
 * An agent that answers "about 1.4% of borrowed value is cross-protocol" is worth
 * nothing to a risk desk unless the desk can ask *which books, at which block*. And a
 * language model asked to summarise tool output will, given the chance, round a number,
 * carry one over from an earlier turn, or supply a plausible one from nowhere. None of
 * those failures announce themselves in prose.
 *
 * So numbers do not travel as numbers here. They travel as `Cited` values that carry
 * their own rendering and their own sources, answers are assembled out of those
 * renderings, and `unsourcedNumbers` re-reads the finished text to confirm that every
 * numeral in it came from one. That check is what `lib/agent/__tests__/transcript.test.ts`
 * runs over the committed transcript, so an unsourced number fails the build rather
 * than shipping as a sentence that reads fine.
 *
 * The invariant is deliberately mechanical and deliberately not about truth: it proves
 * a number came from a tool call at a stated block. Whether the tool is right is what
 * Phases 3 and 6 measure.
 */

/** Where a number was read. Deployment key, subgraph id, and the block served. */
export type Provenance = {
  /** Key from `lib/graph/deployments.ts`, e.g. `aave-v3-eth`. */
  deployment: string;
  /**
   * The Graph subgraph id. Recorded rather than the gateway URL, because the URL
   * embeds the API key as a path segment — see `lib/graph/client.ts`.
   */
  subgraphId: string;
  /** The block the indexer served this read at. */
  block: number;
};

/**
 * One number, its exact rendering, and the reads it rests on.
 *
 * `text` is the source of truth for how the number appears in prose. Formatting a
 * `Cited` a second way at the point of use would defeat the check, since the answer
 * would then contain a numeral no citation produced.
 */
export type Cited = {
  /** What the number is, in words, for the citation table. */
  label: string;
  /** Exactly as it appears in the answer. */
  text: string;
  /** The underlying value, for tests and for consumers that want to compute on it. */
  value: number;
  sources: Provenance[];
};

export function cite(
  label: string,
  value: number,
  text: string,
  sources: Provenance[],
): Cited {
  if (sources.length === 0) {
    // A citation with no source is the exact failure this module exists to prevent,
    // and it is cheaper to reject it here than to detect it in prose later.
    throw new Error(`cite(${label}): no sources`);
  }
  return { label, text, value, sources };
}

/** `1234567.8` -> `$1,234,568`. Whole dollars: cents on a sampled aggregate are noise. */
export function usd(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** `0.01432` -> `1.43%`. */
export function pct(fraction: number, digits = 2): string {
  return `${(100 * fraction).toFixed(digits)}%`;
}

/**
 * Every maximal digit run in a string, normalised so `1,234` and `1234` compare equal.
 *
 * Digits welded to letters are not quantities and are skipped: `aave-v3-eth` and
 * `compound-v2-eth` are names, and a check that demanded a citation for the 3 in "V3"
 * would push every tool into paraphrasing protocol names, which is worse than the
 * problem. A quantity in prose always has a non-letter on both sides.
 */
function numerals(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const before = m.index > 0 ? text[m.index - 1] : "";
    const after = text[m.index + m[0].length] ?? "";
    if (/[a-zA-Z]/.test(before) || /[a-zA-Z]/.test(after)) continue;
    const raw = m[0].replace(/,/g, "").replace(/\.$/, "");
    // Trailing zeros after a decimal point are cosmetic: 1.40 and 1.4 are the same
    // number and a renderer may legitimately choose either.
    out.push(raw.includes(".") ? String(Number(raw)) : raw);
  }
  return out;
}

/**
 * Numerals in `answer` that no citation, source block, or the question itself accounts for.
 *
 * The question is allowed as a source because a shock scenario is *parameterised* by a
 * number the caller supplied — "what if stETH drops 15%" must be able to say 15% back —
 * and that number is sourced, just not from a subgraph.
 *
 * Returns the offending tokens rather than a boolean so a failure names the number.
 */
export function unsourcedNumbers(
  answer: string,
  cited: Cited[],
  question = "",
): string[] {
  const allowed = new Set<string>();
  for (const c of cited) {
    for (const n of numerals(c.text)) allowed.add(n);
    for (const s of c.sources) allowed.add(String(s.block));
  }
  for (const n of numerals(question)) allowed.add(n);
  return numerals(answer).filter((n) => !allowed.has(n));
}

/** The citation table that follows every answer. One row per number, with its block. */
export function renderCitations(cited: Cited[]): string {
  const lines = ["| number | value | subgraph | block |", "|---|---|---|---|"];
  for (const c of cited) {
    const srcs = c.sources
      .map((s) => `\`${s.deployment}\` (\`${s.subgraphId}\`)`)
      .join("<br>");
    const blocks = c.sources.map((s) => s.block).join("<br>");
    lines.push(`| ${c.label} | ${c.text} | ${srcs} | ${blocks} |`);
  }
  return lines.join("\n");
}
