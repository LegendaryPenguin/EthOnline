/**
 * npm run record:terminal — run the demo's commands for real and record what they printed, with
 * timings, into cast files the renderer replays.
 *
 * ## Why a cast instead of a screen recording
 *
 * The video's proof rules (`docs/VIDEO.md`) say every claim that has a command gets its command on
 * screen, uncut, ending on the returning prompt. There are two ways to satisfy that. A human can
 * point a screen recorder at Terminal.app; or the run can be captured to a transcript with
 * per-chunk timings and replayed into a real terminal emulator at the real speed. This does the
 * second, and it is the stronger of the two for exactly one reason: **the cast is committed, so a
 * judge can diff any frame of the video against the bytes the command actually produced.** A
 * screen recording is unfalsifiable in the wrong direction — you cannot check it against anything.
 *
 * What is *not* claimed: these are not photographs of a terminal window. `docs/VIDEO.md` says so on
 * the tin, and the closing card of the v2 cut names `docs/evidence/casts/` as the source of every
 * terminal frame in it, so the claim is in the video and not only in the repo.
 *
 * ## Real timings, and what we do with them
 *
 * Every output chunk is stamped with the millisecond it arrived, so a 46-second gateway-bound stage
 * looks like a 46-second gateway-bound stage. The renderer is allowed to speed-ramp a wait and must
 * mark the ramp on screen; it is not allowed to remove output. Both halves of that are enforced by
 * the timeline, not by good intentions.
 *
 * ## A pty, on purpose
 *
 * Commands are run under `script -q /dev/null …` so they get a pseudo-terminal. Without one, every
 * well-behaved CLI turns its colours off and its spinners into nothing, and the footage would be a
 * duller thing than the command really is. xterm.js in the renderer replays the resulting escape
 * sequences properly.
 *
 * ## Secrets
 *
 * Output is redacted through the shared patterns in `scripts/lib/redact.mts` before it is stored,
 * and a cast is refused outright if a 32-hex token survives. Chunks are flushed only on line
 * boundaries so a key can never be split across two events and slip past the pattern. The home
 * directory is scrubbed too: this text ends up in frame, and `/Users/<name>` in a hackathon video
 * is noise at best.
 *
 *   npm run record:terminal              # every shot
 *   npm run record:terminal -- snapshot  # just the named ones
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { countSecretSurvivors, redactForScreen } from "../lib/redact.mts";

const OUT_DIR = resolve("docs/evidence/casts");

/**
 * The prompt drawn before the command in the replay: the operator's own zsh prompt, so the footage
 * looks like the terminal the commands were actually run from. `~` rather than the repository path,
 * because a personal directory in frame is noise, and the working directory is not what any of these
 * commands prove.
 */
const PROMPT = process.env.SENTINEL_PROMPT ?? "nrawal@842f579e3dc8 ~ % ";

type Shot = {
  /** Cast file name, and the id the timeline refers to. */
  id: string;
  /** Exactly what appears after the prompt on screen, and exactly what is run. */
  command: string;
  /** Which section of docs/VIDEO.md this is footage for. */
  section: string;
  /** Non-zero exit is a recording failure for every shot here; all of these are supposed to pass. */
  expectExit?: number;
};

const SHOTS: Shot[] = [
  { id: "snapshot", command: "npm run snapshot", section: "2 — live, across five protocols" },
  { id: "leak-demo", command: "npm run leak-demo", section: "3 — what cannot be published" },
  {
    // The only command in the cut that succeeds silently — `tsc --noEmit` prints nothing when it
    // is happy, and a frame of nothing proves nothing to a viewer. So the shell is asked for the
    // exit code, which is the actual evidence, and the request is part of the command on screen.
    id: "cre-typecheck",
    command: 'npm run cre:typecheck; echo "tsc exit=$?"',
    section: "4b — compiles against the SDK",
  },
  { id: "cre-test", command: "npm run cre:test", section: "4c — the enclave aggregates and signs" },
  { id: "cre-simulate", command: "npm run cre:simulate", section: "4d — the CRE CLI simulation" },
  { id: "mcp-handshake", command: "npm run mcp:handshake", section: "6a — the tools over the wire" },
  { id: "consume-signal", command: "npm run consume-signal", section: "7 — an independent consumer" },
  { id: "forge-test", command: "npm run forge:test", section: "7 — the on-chain consumer" },
  { id: "verify", command: "npm run verify", section: "8b — all of it, one command" },
];

type Cast = {
  id: string;
  command: string;
  prompt: string;
  section: string;
  recordedAt: string;
  exitCode: number;
  durationMs: number;
  cols: number;
  rows: number;
  /** `[msSinceFirstByte, text]`, in arrival order. Text is redacted and line-terminated. */
  events: [number, string][];
};

/**
 * 120×34 matches the recording checklist in docs/VIDEO.md. It is also what the commands are told
 * they have, via COLUMNS/LINES — otherwise a CLI that wraps to the terminal width would wrap to
 * whatever this shell happens to be, and the replay would show wrapping that doesn't match its own
 * frame.
 */
const COLS = 120;
const ROWS = 34;

/**
 * macOS `script` echoes the EOF it gets on the closed stdin, so every capture opens with a literal
 * `^D\b\b` that the command did not print. Dropped rather than rendered: it is an artifact of how
 * the recording is made, and leaving it in frame would be the recorder talking over the command.
 * Only the leading occurrence is touched — anything later is the command's own output.
 */
function stripPtyEofEcho(text: string): string {
  return text.replace(/^\^D\x08*\r?\n?/, "");
}

function capture(shot: Shot): Promise<Cast> {
  const started = Date.now();
  let firstByteAt: number | null = null;
  const events: [number, string][] = [];

  // Line-buffered, so redaction always sees whole lines. A 32-hex key contains no newline, so it
  // cannot straddle two events, so it cannot survive by being cut in half.
  let pending = "";
  const flush = (force: boolean) => {
    const cut = force ? pending.length : Math.max(pending.lastIndexOf("\n"), pending.lastIndexOf("\r")) + 1;
    if (cut === 0) return;
    const raw = pending.slice(0, cut);
    pending = pending.slice(cut);
    const text = redactForScreen(events.length === 0 ? stripPtyEofEcho(raw) : raw);
    if (text.length === 0) return;
    events.push([firstByteAt === null ? 0 : Date.now() - firstByteAt, text]);
  };

  return new Promise((done, fail) => {
    const child = spawn("/usr/bin/script", ["-q", "/dev/null", "/bin/sh", "-c", shot.command], {
      env: {
        ...process.env,
        COLUMNS: String(COLS),
        LINES: String(ROWS),
        // Ask for colour explicitly: under `script` the child sees a tty, but some tools also
        // check CI/FORCE_COLOR before deciding.
        FORCE_COLOR: "1",
        TERM: "xterm-256color",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        firstByteAt ??= Date.now();
        pending += chunk.toString();
        flush(false);
        process.stdout.write("."); // a progress dot for the operator, not part of the cast
      });
    }

    child.on("error", fail);
    child.on("close", (code) => {
      flush(true);
      done({
        id: shot.id,
        command: shot.command,
        prompt: PROMPT,
        section: shot.section,
        recordedAt: new Date(started).toISOString(),
        exitCode: code ?? 1,
        durationMs: Date.now() - started,
        cols: COLS,
        rows: ROWS,
        events,
      });
    });
  });
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const shots = only.length > 0 ? SHOTS.filter((s) => only.includes(s.id)) : SHOTS;
  if (shots.length === 0) {
    console.error(`no shot matched ${only.join(", ")}. Known: ${SHOTS.map((s) => s.id).join(", ")}`);
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const failures: string[] = [];

  for (const [i, shot] of shots.entries()) {
    process.stdout.write(`[${i + 1}/${shots.length}] ${shot.command} `);
    const cast = await capture(shot);
    const body = JSON.stringify(cast, null, 2);

    const survivors = countSecretSurvivors(body);
    if (survivors > 0) {
      console.log("");
      console.error(
        `refusing to write ${shot.id}.json: ${survivors} 32-hex token(s) survived redaction.\n` +
          `Widen redact() in scripts/lib/redact.mts and re-run. Nothing was written.`,
      );
      process.exit(1);
    }

    const expected = shot.expectExit ?? 0;
    const bytes = cast.events.reduce((n, [, text]) => n + text.length, 0);
    writeFileSync(resolve(OUT_DIR, `${shot.id}.json`), body);
    console.log(
      ` exit ${cast.exitCode} · ${(cast.durationMs / 1000).toFixed(1)}s · ` +
        `${cast.events.length} events · ${bytes} chars`,
    );
    if (cast.exitCode !== expected) {
      failures.push(`${shot.id} exited ${cast.exitCode}, expected ${expected}`);
    }
  }

  console.log(`\n${"═".repeat(78)}`);
  if (failures.length > 0) {
    console.error(
      `\n${failures.length} shot(s) did not exit as expected:\n  ${failures.join("\n  ")}\n\n` +
        `The casts were still written, because the failure is the thing to look at. Fix the ` +
        `command before rendering — a red exit code in the footage is a red exit code in the video.`,
    );
    process.exit(1);
  }
  console.log(`${shots.length} cast(s) written to ${OUT_DIR} — every command exited as expected.`);
}

await main();
