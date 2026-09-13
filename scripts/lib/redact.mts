/**
 * Redaction for anything this repo writes to disk or puts on screen.
 *
 * Extracted from `scripts/cre-simulate.mts` when the video recorder became a second consumer.
 * One copy, because two copies of a redaction rule is one copy that falls behind — and the
 * failure mode here is a published secret.
 *
 * Redaction is by pattern, not by comparison against the known key, because the point is to
 * survive a key we have never seen: a fresh clone with someone else's credentials must be just
 * as safe as ours.
 */

/**
 * The gateway URL is `https://gateway.thegraph.com/api/<key>/subgraphs/id/<id>`, so the key is a
 * path segment and any log line carrying a request URL carries the key. Three passes: the specific
 * shape first, then query-string forms, then any bare 32-hex token that is still sitting in a URL
 * or quoted. Subgraph IDs are base58 and longer, so they are not caught by the hex pattern.
 */
export function redact(text: string): string {
  return text
    .replace(/(gateway\.thegraph\.com\/api\/)[0-9a-fA-F]{32}/g, "$1<GRAPH_API_KEY redacted>")
    .replace(/([?&](?:api[-_]?key|key|token)=)[^&\s"']+/gi, "$1<redacted>")
    .replace(/\b[0-9a-f]{32}\b(?=[/"'\s])/g, "<32-hex redacted>");
}

/**
 * Everything `redact` does, plus the home directory. Only the recorder needs this: a screen
 * recording carries whatever the prompt and stack traces carry, and `/Users/<name>` in frame is
 * both noise and a small deanonymization of the author. Text destined for a log file keeps its
 * real paths, because a log is for debugging.
 */
export function redactForScreen(text: string, home: string = process.env.HOME ?? ""): string {
  const scrubbed = redact(text);
  return home.length > 1 ? scrubbed.split(home).join("~") : scrubbed;
}

/**
 * Guard against redacting into a false sense of safety: if a 32-hex token survives anywhere in
 * the text, the caller is expected to discard it rather than write it. Failing loudly beats
 * shipping a log we believe is clean. (Binary and config hashes in the CRE CLI banner are 64-hex,
 * so they are unaffected.)
 *
 * Returns the number of survivors so the caller can word its own refusal; 0 means clean.
 */
export function countSecretSurvivors(text: string): number {
  return text.match(/\b[0-9a-f]{32}\b/g)?.length ?? 0;
}
