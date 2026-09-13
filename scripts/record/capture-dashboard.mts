/**
 * npm run record:dashboard — one continuous take of the real dashboard, for section 5 of the video.
 *
 * Requires `npm run build` first, because this drives `next start`, not `next dev`: the video should
 * show the production bundle, which is the one the frame-rate claim is about.
 *
 * ## Why the slider is driven from the keyboard, not the mouse
 *
 * `docs/VIDEO.md` originally called for a visible cursor dragging the slider. Playwright's video
 * recorder does not draw the pointer — it captures the page, not the compositor's cursor layer — and
 * the alternative is to paint a fake cursor into the page, which is precisely the kind of thing this
 * project does not do. So the slider is driven with the arrow keys instead, and the caption says so.
 *
 * That is not a downgrade. "Full keyboard operation" is one of the project's own acceptance criteria
 * (`scripts/capture-ui.mts` asserts it), so keyboard footage proves a claim that mouse footage
 * cannot, and the focus ring being visible in frame is part of the proof.
 *
 * ## The frame rate in frame
 *
 * The explorer measures the frame rate of your own interaction with `requestAnimationFrame` and
 * prints it in the page (`components/ShockExplorer.tsx`). So the fps number in the video is not a
 * caption we wrote over footage — it is the app measuring itself while being operated, on screen.
 * This script also reads that line back out of the DOM and stores it in the manifest, so the
 * timeline can quote it verbatim rather than from memory.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Page } from "playwright";

const PORT = 3119;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = resolve("record/assets");
const CLIP = resolve(OUT_DIR, "dashboard.webm");
const MANIFEST = resolve(OUT_DIR, "dashboard.json");

/** 40 presses at this gap is the drive: long enough to read the cascade filling, not a blur. */
const PRESSES = 40;
const PRESS_GAP_MS = 190;

async function waitForServer(deadlineMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      if ((await fetch(BASE, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`server did not answer on ${BASE} — did you run \`npm run build\`?`);
}

/** A wheel-scroll in small increments, so the take shows the page moving rather than jumping. */
async function glide(page: Page, totalPx: number, ms: number) {
  const steps = Math.max(1, Math.round(ms / 33));
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, totalPx / steps);
    await page.waitForTimeout(33);
  }
}

async function main() {
  if (!existsSync(".next")) {
    console.error("no .next build found — run `npm run build` first.");
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(resolve(OUT_DIR, "raw"), { recursive: true, force: true });

  const server = spawn("npx", ["next", "start", "-p", String(PORT)], { stdio: "ignore" });
  const browser = await chromium.launch();
  const marks: { at: number; what: string }[] = [];
  let fpsLine = "";
  let sliderLabel = "";

  try {
    await waitForServer();
    // Recording starts the moment the context does, so this is the zero of the clip's own timeline;
    // `leadInMs` below turns the marks into times the player can seek to directly.
    const recordingStarted = Date.now();
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      // The theme toggle's default is "system", and this is how you tell it what the system says.
      // Setting `.theme-dark` on <html> by hand does not survive hydration — React restores the
      // class attribute the server rendered — and clicking the DARK radio would film a preference
      // being overridden rather than the page a reader with a dark desktop actually gets.
      colorScheme: "dark",
      recordVideo: { dir: resolve(OUT_DIR, "raw"), size: { width: 1920, height: 1080 } },
    });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && problems.push(`console error: ${m.text()}`));

    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);

    // Everything from here is in the clip, so the timings are the edit. `mark` records where each
    // beat lands so the timeline can cut to it instead of guessing from a stopwatch.
    const t0 = Date.now();
    const mark = (what: string) => marks.push({ at: Date.now() - t0, what });

    mark("hero");
    await page.waitForTimeout(2_200);

    mark("scroll-to-explorer");
    await page.locator("#shock").scrollIntoViewIfNeeded();
    await glide(page, 120, 500);
    await page.waitForTimeout(600);

    const slider = page.locator("#shock");
    await slider.focus();
    mark("focus-slider");
    await page.waitForTimeout(900);

    mark("drive");
    for (let i = 0; i < PRESSES; i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(PRESS_GAP_MS);
    }
    mark("propagated");
    await page.waitForTimeout(3_400);

    mark("read-fps");
    // The app's own measurement of the interaction that just happened, read from the DOM so the
    // caption can quote it exactly.
    fpsLine = (await page.locator("text=/Last interaction:/").first().innerText()).replace(/\s+/g, " ").trim();
    sliderLabel = (await page.locator("label[for='shock']").first().innerText()).replace(/\s+/g, " ").trim();
    await page.waitForTimeout(2_600);

    mark("graph");
    await glide(page, 520, 900);
    await page.waitForTimeout(3_200);
    mark("end");

    if (problems.length > 0) {
      console.error(`the page reported ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
    }

    await context.close(); // the video is only flushed on close
    const raw = resolve(OUT_DIR, "raw");
    const { readdirSync } = await import("node:fs");
    const file = readdirSync(raw).find((f) => f.endsWith(".webm"));
    if (!file) throw new Error("playwright wrote no video");
    renameSync(resolve(raw, file), CLIP);
    rmSync(raw, { recursive: true, force: true });

    writeFileSync(
      MANIFEST,
      JSON.stringify(
        {
          clip: "dashboard.webm",
          recordedAt: new Date(t0).toISOString(),
          durationMs: marks.at(-1)!.at,
          /** Where mark 0 sits inside the clip: the page had to load before the take began. */
          leadInMs: t0 - recordingStarted,
          presses: PRESSES,
          pressGapMs: PRESS_GAP_MS,
          driver: "keyboard (ArrowRight), Playwright — Playwright's recorder does not draw a cursor",
          /** Read out of the live DOM after the drive; the app measured this about itself. */
          fpsLine,
          sliderLabel,
          marks,
        },
        null,
        2,
      ) + "\n",
    );

    console.log(`clip: ${CLIP}`);
    console.log(`lead-in: ${((t0 - recordingStarted) / 1000).toFixed(2)}s before the first mark`);
    console.log(`marks (clip time): ${marks.map((m) => `${m.what}@${((m.at + t0 - recordingStarted) / 1000).toFixed(1)}s`).join("  ")}`);
    console.log(`in-page measurement: ${fpsLine}`);
  } finally {
    await browser.close();
    server.kill();
  }
}

await main();
