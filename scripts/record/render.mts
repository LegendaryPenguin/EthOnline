/*
 * Renders the demo video.
 *
 * `record/player/` is the video as a web page whose entire visual state is a pure function of one
 * number: `SENTINEL.seek(t)` puts it at second `t`. This program serves that page, opens it in
 * Chromium at exactly 1920×1080, and for every frame of the timeline calls `seek(f / fps)`, takes a
 * screenshot, and pipes it into ffmpeg.
 *
 * Why render frames instead of screen-recording a playback:
 *
 *   - **Frame-exactness.** A screen recorder samples whatever the compositor managed to paint. Here
 *     every frame is the page settled at its exact time — no dropped frames, no tearing, no
 *     variable-rate output, and the 30th frame is at t = 1.0000s on a slow machine and a fast one.
 *   - **Reproducibility.** The inputs are committed: the casts in `docs/evidence/casts/`, the
 *     dashboard clip in `record/assets/`, and the repo's own source and docs. Re-running this
 *     produces the same mp4, so the video is a build artifact rather than a performance.
 *
 * It is slower than real time by a wide margin (the page is doing real work per frame: writing to a
 * terminal emulator, seeking a <video>, laying out text), which is exactly why the page may not
 * contain a single wall-clock animation. See the header of `record/player/player.mjs`.
 *
 * Output: `record/out/sentinel-demo.mp4` (H.264, yuv420p, 30 fps, silent).
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT_DIR = path.join(ROOT, "record/out");

/**
 * Two cuts, one engine. `RENDER_CUT=v2` renders `record/player/edit.v2.mjs` (the second mockup:
 * native terminal chrome, annotation cards, three-tier captions) to its own file, so rendering it can
 * never overwrite the first cut's mp4.
 */
const CUT = process.env.RENDER_CUT === "v2" ? "v2" : "v1";
const OUT_FILE = path.join(OUT_DIR, CUT === "v2" ? "sentinel-demo-v2.mp4" : "sentinel-demo.mp4");
const FFMPEG = "/opt/homebrew/bin/ffmpeg";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const PORT = Number(process.env.RENDER_PORT ?? 3129);

/**
 * The static server. Each prefix is mapped to one directory and nothing else is reachable, because
 * the page fetches repo files by path (`/repo/lib/graph/queries.ts`) and a path-traversal here would
 * happily serve `.env.local` to a page that then screenshots it. `resolveSafe` is the whole defence:
 * the resolved path must stay inside its root.
 */
const MOUNTS: [string, string][] = [
  ["/player/", path.join(ROOT, "record/player")],
  ["/casts/", path.join(ROOT, "docs/evidence/casts")],
  ["/assets/", path.join(ROOT, "record/assets")],
  ["/vendor/", path.join(ROOT, "record/vendor")],
  ["/clip/", OUT_DIR],
  ["/repo/", ROOT],
];

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".svg": "image/svg+xml",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/** Refuse anything that is not one of the extensions the page actually needs. */
const READABLE = new Set(Object.keys(TYPES));

function resolveSafe(root: string, rest: string): string | null {
  const target = path.resolve(root, decodeURIComponent(rest).replace(/^\/+/, ""));
  const within = target === root || target.startsWith(root + path.sep);
  if (!within) return null;
  if (!READABLE.has(path.extname(target))) return null;
  if (path.basename(target).startsWith(".env")) return null;
  return target;
}

function startServer(): Promise<() => Promise<void>> {
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const target =
      url === "/" || url === "/index.html"
        ? path.join(ROOT, "record/player/index.html")
        : (() => {
            for (const [prefix, root] of MOUNTS) {
              if (url.startsWith(prefix)) return resolveSafe(root, url.slice(prefix.length));
            }
            return null;
          })();

    if (!target || !existsSync(target)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not here");
      return;
    }

    // Range requests are not an optimisation here, they are the feature: a media element's
    // `seekable` range is empty unless the server honours `Range`, and every `currentTime =` on a
    // non-seekable element is silently ignored. Without this the dashboard section renders as
    // twenty seconds of whichever frame happened to be decoded first — which is exactly how it did
    // render until this was fixed.
    const type = TYPES[path.extname(target)] ?? "application/octet-stream";
    const size = statSync(target).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
      const end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-type": type,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      });
      createReadStream(target, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "content-type": type,
      "content-length": String(size),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    });
    createReadStream(target).pipe(res);
  });
  return new Promise((done) => {
    server.listen(PORT, "127.0.0.1", () =>
      done(() => new Promise<void>((closed) => server.close(() => closed()))),
    );
  });
}

/**
 * xterm.js ships as an npm package for bundlers; the page loads it as a plain module. Copy the two
 * files it needs into `record/vendor/` so the page has no build step of its own.
 */
async function stageVendor(): Promise<void> {
  const vendor = path.join(ROOT, "record/vendor");
  await mkdir(vendor, { recursive: true });
  const pkg = path.join(ROOT, "node_modules/@xterm/xterm");
  await writeFile(path.join(vendor, "xterm.mjs"), await readFile(path.join(pkg, "lib/xterm.mjs")));
  await writeFile(path.join(vendor, "xterm.css"), await readFile(path.join(pkg, "css/xterm.css")));
}

/**
 * Playwright records VP8/webm with no seek index and sparse keyframes, and Chromium answers every
 * `currentTime =` on such a file with the same decoded frame — the dashboard section rendered as
 * twenty seconds of one still. So the clip is transcoded to an all-intra H.264 intermediate first
 * (`-g 1`: every frame is a keyframe), which is seekable to the exact frame.
 *
 * The intermediate lives in `record/out/` and is not committed: it is derived from
 * `record/assets/dashboard.webm`, which is, and it is regenerated whenever that file is newer.
 */
async function prepareClip(): Promise<void> {
  const source = path.join(ROOT, "record/assets/dashboard.webm");
  const target = path.join(OUT_DIR, "dashboard.mp4");
  if (!existsSync(source)) throw new Error(`no dashboard clip at ${source} — npm run record:dashboard`);
  await mkdir(OUT_DIR, { recursive: true });
  const { stat } = await import("node:fs/promises");
  if (existsSync(target) && (await stat(target)).mtimeMs > (await stat(source)).mtimeMs) return;

  process.stdout.write("transcoding the dashboard clip to an all-intra intermediate… ");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      FFMPEG,
      ["-y", "-i", source, "-an", "-c:v", "libx264", "-crf", "16", "-g", "1", "-pix_fmt", "yuv420p", target],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    child.stderr.on("data", (c) => (err += String(c)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${err.slice(-2000)}`))));
  });
  console.log("done");
}

type Outline = { kind: string; id: string; start: number; dur: number };

async function openPlayer(browser: Browser): Promise<{ page: Page; duration: number; outline: Outline[] }> {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });

  // The page is the video; a console error in it is a rendering error, so surface it rather than
  // discovering a black segment after a twenty-minute render.
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") problems.push(msg.text());
  });
  page.on("pageerror", (err) => problems.push(err.message));

  await page.goto(`http://127.0.0.1:${PORT}/?cut=${CUT}`, { waitUntil: "load" });
  await page.waitForFunction("document.body.dataset.ready === '1'", null, { timeout: 60_000 }).catch(() => {
    throw new Error(`the player never became ready:\n  ${problems.join("\n  ") || "(no error reported)"}`);
  });
  if (problems.length > 0) throw new Error(`player reported errors:\n  ${problems.join("\n  ")}`);

  const info = await page.evaluate("({ duration: SENTINEL.duration, outline: SENTINEL.outline, captions: SENTINEL.captions })") as {
    duration: number;
    outline: Outline[];
    captions: { t0: number; t1: number; kicker?: string; html: string; detail?: string }[];
  };

  // A placeholder that reached the render is a caption asserting something nobody filled in. All
  // three registers are checked, because v2's `detail` line is the one a judge reads for the
  // mechanism and an unfilled one there is the worst of the three.
  const todo = info.captions.filter((c) => /TODO/.test(`${c.kicker ?? ""} ${c.html} ${c.detail ?? ""}`));
  if (todo.length > 0) {
    throw new Error(`unfilled captions: ${todo.map((c) => c.html).join(" | ")}`);
  }

  // No em dash anywhere in the v2 cut's own voice. The rule is enforced here rather than trusted to
  // proofreading, because a caption is the one thing on screen this repo writes freely.
  if (CUT === "v2") {
    const dashed = info.captions.filter((c) => /—/.test(`${c.kicker ?? ""} ${c.html} ${c.detail ?? ""}`));
    if (dashed.length > 0) {
      throw new Error(`em dash in v2 captions: ${dashed.map((c) => c.html.slice(0, 60)).join(" | ")}`);
    }
  }

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    path.join(OUT_DIR, CUT === "v2" ? "timeline.v2.json" : "timeline.json"),
    JSON.stringify({ fps: FPS, duration: info.duration, outline: info.outline, captions: info.captions }, null, 2) + "\n",
  );
  return { page, duration: info.duration, outline: info.outline };
}

function startEncoder(): { stdin: NodeJS.WritableStream; done: Promise<void> } {
  const child = spawn(
    FFMPEG,
    [
      "-y",
      "-f", "image2pipe",
      "-framerate", String(FPS),
      "-i", "-",
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      // Judges scrub. A keyframe every second makes seeking land where it was dropped.
      "-g", String(FPS),
      "-movflags", "+faststart",
      OUT_FILE,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 40_000) stderr = stderr.slice(-20_000);
  });
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${stderr}`))));
  });
  // A broken pipe here means ffmpeg died; `done` already carries the reason.
  child.stdin.on("error", () => {});
  return { stdin: child.stdin, done };
}

const write = (stream: NodeJS.WritableStream, buf: Buffer): Promise<void> =>
  stream.write(buf) ? Promise.resolve() : new Promise((done) => stream.once("drain", () => done()));

async function main(): Promise<void> {
  if (!existsSync(FFMPEG)) throw new Error(`no ffmpeg at ${FFMPEG} — brew install ffmpeg`);
  await stageVendor();
  await prepareClip();
  const stop = await startServer();

  // `RENDER_SERVE=1` just hosts the player and waits, so the timeline can be opened in a real
  // browser and scrubbed by hand — the fastest way to find out why a segment looks wrong.
  if (process.env.RENDER_SERVE === "1") {
    console.log(`serving the timeline on http://127.0.0.1:${PORT}/ — SENTINEL.seek(t) in the console`);
    await new Promise(() => {});
  }
  const browser = await chromium.launch({
    args: ["--force-color-profile=srgb", "--disable-lcd-text", "--autoplay-policy=no-user-gesture-required"],
  });

  try {
    const { page, duration, outline } = await openPlayer(browser);
    const total = Math.round(duration * FPS);
    const mins = Math.floor(duration / 60);
    console.log(`timeline  ${mins}:${String(Math.round(duration % 60)).padStart(2, "0")} · ${total} frames @ ${FPS}fps`);
    for (const seg of outline) {
      console.log(`  ${String(seg.start).padStart(7)}s  ${seg.kind.padEnd(9)} ${seg.id}  (${seg.dur}s)`);
    }

    // `RENDER_STILLS=12.5,40,88` writes those seconds as PNGs and stops. Checking a layout should
    // not cost a full render, and the stills come from the same seek path as the frames do.
    const stills = (process.env.RENDER_STILLS ?? "").split(",").filter(Boolean).map(Number);
    if (stills.length > 0) {
      for (const at of stills) {
        await page.evaluate(`SENTINEL.seek(${at})`);
        const file = path.join(OUT_DIR, `still-${String(at).replace(".", "_")}s.png`);
        await writeFile(file, await page.screenshot({ type: "png" }));
        console.log(`  ${path.relative(ROOT, file)}`);
      }
      return;
    }

    // `RENDER_FROM`/`RENDER_TO` (seconds) render a slice, for reviewing one section at a time.
    const first = Math.max(0, Math.round(Number(process.env.RENDER_FROM ?? 0) * FPS));
    const last = process.env.RENDER_TO ? Math.min(total, Math.round(Number(process.env.RENDER_TO) * FPS)) : total;

    const { stdin, done } = startEncoder();
    const started = Date.now();
    for (let frame = first; frame < last; frame++) {
      await page.evaluate(`SENTINEL.seek(${frame / FPS})`);
      await write(stdin, await page.screenshot({ type: "png" }));
      const done = frame - first + 1;
      if (done % (FPS * 5) === 0 || frame === last - 1) {
        const elapsed = (Date.now() - started) / 1000;
        const rate = done / elapsed;
        process.stdout.write(
          `\r  frame ${String(done).padStart(5)}/${last - first}  ${((done / (last - first)) * 100).toFixed(1)}%  ` +
            `${rate.toFixed(1)} fps  eta ${Math.round((last - first - done) / rate)}s   `,
        );
      }
    }
    stdin.end();
    await done;
    process.stdout.write("\n");
    console.log(`wrote ${path.relative(ROOT, OUT_FILE)} in ${Math.round((Date.now() - started) / 1000)}s`);
  } finally {
    await browser.close();
    await stop();
  }
}

await main();
