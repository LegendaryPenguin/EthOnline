/**
 * Architectural tests.
 *
 * Sentinel's entire claim is that its numbers come from live subgraph data. A
 * README promising "no mock data" is worth nothing; a failing build is worth
 * something. These tests read the source tree and fail if the promise is broken.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url).pathname;
const SEARCH_DIRS = ["lib", "app", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "data", "__tests__"]);

async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // A directory that does not exist yet is not a violation.
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  }

  for (const dir of SEARCH_DIRS) await walk(join(ROOT, dir));
  return out;
}

async function read(files: string[]) {
  return Promise.all(
    files.map(async (f) => ({ path: relative(ROOT, f), text: await readFile(f, "utf8") })),
  );
}

describe("no mock data outside tests", () => {
  it("finds source files to check", async () => {
    // Guards the guard: a walker that silently returns nothing would make every
    // test below pass vacuously.
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(5);
  });

  it("imports no fixture, mock, sample or seed module", async () => {
    const sources = await read(await sourceFiles());
    const offenders: string[] = [];

    for (const { path, text } of sources) {
      for (const m of text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
        if (/(^|\/)(fixtures?|mocks?|__mocks__|stubs?|samples?|seed(-?data)?|dummy)(\/|$|\.)/i.test(m[1])) {
          offenders.push(`${path} imports ${m[1]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("has no fallback that substitutes invented numbers for a failed query", async () => {
    // The specific failure mode this forbids: catching a gateway error and
    // returning a plausible-looking constant, which would make every downstream
    // claim unfalsifiable.
    const sources = await read(await sourceFiles());
    const offenders: string[] = [];

    for (const { path, text } of sources) {
      for (const m of text.matchAll(
        /\b(MOCK_|FAKE_|DUMMY_|SAMPLE_DATA|useMockData|USE_MOCK|mockMode|fallbackData)\w*/g,
      )) {
        offenders.push(`${path} references ${m[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps the API key out of committed source", async () => {
    const sources = await read(await sourceFiles());
    const offenders: string[] = [];

    for (const { path, text } of sources) {
      // A Graph API key is 32 hex characters. Any bare one in source is a leak.
      for (const m of text.matchAll(/\b[0-9a-f]{32}\b/g)) {
        offenders.push(`${path} contains what looks like an API key: ${m[0].slice(0, 6)}…`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("reads the API key only through requireApiKey", async () => {
    // One chokepoint means one place that throws a useful error, and no module
    // that quietly proceeds with an undefined key.
    const sources = await read(await sourceFiles());
    const offenders: string[] = [];

    for (const { path, text } of sources) {
      if (path === "lib/graph/client.ts") continue;
      if (/process\.env\.GRAPH_API_KEY/.test(text)) {
        offenders.push(`${path} reads GRAPH_API_KEY directly instead of via requireApiKey()`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
