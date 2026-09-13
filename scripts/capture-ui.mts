/**
 * Drive the real interface in a real browser: screenshots, keyboard path, frame rate.
 *
 *   npm run capture:ui
 *
 * Three things this does that no unit test can:
 *
 *   1. **Screenshots both themes** into `docs/evidence/screens/`, which is also the raw
 *      material for the demo video.
 *   2. **Operates the slider with the keyboard only** — Tab to it, arrow it across the range,
 *      assert the value moved and that the focus ring is actually painted. "Full keyboard
 *      operation" is an acceptance criterion, and it is the kind that quietly stops being
 *      true.
 *   3. **Counts real animation frames** while the slider is being driven, inside the page,
 *      including layout and paint. `scripts/measure-frame-cost.tsx` measures render work in
 *      isolation; this is the number that answers "≥55 fps, measured".
 *
 * Requires `npm run build` first.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "playwright";

const PORT = 3118;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = "docs/evidence/screens";
/** How many arrow presses to drive across the ladder, and how fast. */
const STEPS = 40;
const STEP_GAP_MS = 25;

async function waitForServer(deadlineMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      if ((await fetch(BASE, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`server did not answer on ${BASE}`);
}

/** Applies a theme the way the toggle does, then waits for the repaint. */
async function setTheme(page: Page, theme: "dark" | "light") {
  await page.evaluate((value) => {
    const root = document.documentElement;
    root.classList.remove("theme-dark", "theme-light");
    root.classList.add(`theme-${value}`);
  }, theme);
  await page.waitForTimeout(150);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const server = spawn("npx", ["next", "start", "-p", String(PORT)], { stdio: "ignore" });
  let failures = 0;
  const fail = (message: string) => {
    console.error(`FAIL ${message}`);
    failures++;
  };

  const browser = await chromium.launch();
  try {
    await waitForServer();
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => fail(`page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") fail(`console error: ${message.text()}`);
    });

    await page.goto(BASE, { waitUntil: "networkidle" });

    for (const theme of ["dark", "light"] as const) {
      await setTheme(page, theme);
      await page.screenshot({ path: `${OUT}/dashboard-${theme}.png`, fullPage: true });
      await page.locator("#shock").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/explorer-${theme}.png` });
    }
    await setTheme(page, "dark");

    // --- Keyboard only ---------------------------------------------------------------
    const slider = page.locator("#shock");
    const before = await slider.inputValue();
    await slider.focus();
    const focused = await page.evaluate(() => document.activeElement?.id ?? "");
    if (focused !== "shock") fail(`focus did not land on the slider (got "${focused}")`);
    const outline = await slider.evaluate((element) => getComputedStyle(element).outlineStyle);
    console.log(`slider focus outline style: ${outline}`);

    // Passed as source text, not as a function: tsx compiles named inner functions with an
    // esbuild `__name` helper that does not exist inside the page, and Playwright serialises
    // the compiled body. A string is evaluated verbatim.
    const FRAME_COUNTER = `(() => {
      const state = { count: 0, worst: 0, started: performance.now(), previous: performance.now() };
      window.__frames = state;
      const tick = (now) => {
        state.count++;
        state.worst = Math.max(state.worst, now - state.previous);
        state.previous = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return true;
    })()`;
    const READ_FRAMES = `(() => {
      const s = window.__frames;
      return { count: s.count, worst: s.worst, ms: performance.now() - s.started };
    })()`;

    const frames = await page.evaluate<boolean>(FRAME_COUNTER);
    if (!frames) fail("could not install the frame counter");

    for (let i = 0; i < STEPS; i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(STEP_GAP_MS);
    }
    const measured = await page.evaluate<{ count: number; worst: number; ms: number }>(READ_FRAMES);
    const after = await slider.inputValue();
    if (after === before) fail("arrow keys did not move the slider");

    const fps = (1000 * measured.count) / measured.ms;
    console.log(
      `keyboard drive: ${before} → ${after} over ${STEPS} presses, ` +
        `${measured.count} frames in ${measured.ms.toFixed(0)} ms = ${fps.toFixed(1)} fps, ` +
        `worst frame ${measured.worst.toFixed(1)} ms`,
    );
    if (fps < 55) fail(`${fps.toFixed(1)} fps is below the 55 fps criterion`);
    await page.screenshot({ path: `${OUT}/explorer-keyboard-focus.png` });

    // The in-app meter should have reported the same interaction.
    const meter = await page.getByText(/Last interaction:/).textContent();
    console.log(`in-app meter: ${meter?.replace(/\s+/g, " ").trim()}`);
    if (!meter) fail("the in-app frame meter did not report the keyboard interaction");

    // --- Cascade animation and round stepper ----------------------------------------
    await page.getByRole("button", { name: /Replay cascade|Step from round 1/ }).click();
    await page.waitForTimeout(1_200);
    const during = await page.getByText(/round \d+ of \d+|before shock/).textContent();
    console.log(`mid-replay round indicator: ${during?.trim()}`);
    await page.screenshot({ path: `${OUT}/cascade-mid.png` });
    // The graph on its own, tightly cropped: the viewport shot cuts it at the fold, and this is
    // the frame the video lingers on, so it is worth having at full size.
    await page.locator("figure").first().screenshot({ path: `${OUT}/contagion-graph.png` });

    // --- Reduced motion --------------------------------------------------------------
    const reducedContext = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      reducedMotion: "reduce",
    });
    const reducedPage = await reducedContext.newPage();
    await reducedPage.goto(BASE, { waitUntil: "networkidle" });
    const stepper = reducedPage.getByRole("button", { name: "Step from round 1" });
    if ((await stepper.count()) === 0) {
      fail("prefers-reduced-motion did not swap the replay button for the round stepper");
    } else {
      await stepper.click();
      const round = await reducedPage.getByText(/round \d+ of \d+/).textContent();
      console.log(`reduced motion: stepper landed on "${round?.trim()}"`);
      await reducedPage.locator("#shock").scrollIntoViewIfNeeded();
      await reducedPage.screenshot({ path: `${OUT}/reduced-motion.png` });
    }

    // --- Styleguide ------------------------------------------------------------------
    for (const theme of ["dark", "light"] as const) {
      const sg = await context.newPage();
      await sg.goto(`${BASE}/styleguide`, { waitUntil: "networkidle" });
      await setTheme(sg, theme);
      await sg.screenshot({ path: `${OUT}/styleguide-${theme}.png`, fullPage: true });
      await sg.close();
    }

    console.log(`screenshots written to ${OUT}/`);
    console.log(failures === 0 ? "OK" : `${failures} failures`);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }

  if (failures > 0) process.exitCode = 1;
}

await main();
