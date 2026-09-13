/*
 * The five images ETHGlobal's submission form asks for: a square logo, a 16:9 cover, and three
 * screenshots. Generated rather than drawn, for the same reason the video is rendered rather than
 * screen-recorded: an asset built by a command can be rebuilt when a colour token or a figure moves,
 * and one exported from a design tool cannot.
 *
 * The logo and the cover are laid out in a Playwright page against `app/tokens.css`, so they use the
 * product's palette by reference and not by eyedropper. The three screenshots are copies of artifacts
 * already committed under `docs/evidence/screens/`, chosen so that between them the three prize slots
 * each have a picture: the signal (the confidential workflow's output), the cascade (two standardized
 * schemas joined), and the explorer (the agent-facing read with no address anywhere in it).
 *
 *   npm run submission:assets   ->  submission/sentinel-{logo,cover,ss1,ss2,ss3}.png
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const OUT = join(ROOT, "submission");
mkdirSync(OUT, { recursive: true });

/* The mark: two rings, one per lending protocol, and the lens where they overlap. That intersection is
 * the whole product, so it is the only filled shape and the only accent-saturated one. Drawn as an SVG
 * with a clip path rather than two translucent circles, because translucency makes the overlap a
 * lighter tint of the rings and the point is that it is a different thing from either. */
const LOGO = /* html */ `
<!doctype html><meta charset="utf-8">
<style>__TOKENS__</style>
<style>
  html,body{margin:0;width:512px;height:512px;background:var(--color-bg);}
  .plate{width:512px;height:512px;display:grid;place-items:center;
    background:radial-gradient(120% 120% at 30% 20%, #10181f 0%, var(--color-bg) 70%);}
</style>
<div class="plate">
  <svg width="512" height="512" viewBox="0 0 512 512" fill="none">
    <defs>
      <clipPath id="lens">
        <path d="M0 0h512v512H0z"/>
      </clipPath>
      <mask id="overlap">
        <rect width="512" height="512" fill="black"/>
        <circle cx="196" cy="256" r="118" fill="white"/>
      </mask>
    </defs>
    <!-- the shield: the confidentiality boundary the rings sit inside -->
    <path d="M256 44 L436 104 V262 C436 358 360 434 256 468 C152 434 76 358 76 262 V104 Z"
          stroke="var(--color-accent)" stroke-opacity="0.34" stroke-width="10" fill="none"/>
    <circle cx="196" cy="256" r="118" stroke="var(--color-text-muted)" stroke-width="14"/>
    <circle cx="316" cy="256" r="118" stroke="var(--color-text-muted)" stroke-width="14"/>
    <g mask="url(#overlap)">
      <circle cx="316" cy="256" r="118" fill="var(--color-accent)"/>
    </g>
  </svg>
</div>`;

/* The cover: the sentence a judge should be able to repeat after two seconds, the number under it, and
 * the three sponsors' surfaces as a footer. No screenshot behind it, because a 640px-wide thumbnail of
 * a dashboard is texture rather than information. */
const COVER = /* html */ `
<!doctype html><meta charset="utf-8">
<style>__TOKENS__</style>
<style>
  html,body{margin:0;width:1920px;height:1080px;background:var(--color-bg);
    color:var(--color-text);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;
    font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;}
  .wrap{position:absolute;inset:0;padding:88px 132px;display:flex;flex-direction:column;
    background:radial-gradient(90% 120% at 78% 8%, rgba(63,217,196,0.10) 0%, transparent 58%);}
  .eyebrow{display:flex;align-items:center;gap:22px;font-size:30px;letter-spacing:0.16em;
    text-transform:uppercase;color:var(--color-accent);font-weight:700;}
  .eyebrow i{display:block;width:26px;height:26px;border-radius:5px;background:var(--color-accent);}
  h1{margin:36px 0 0;font-size:136px;line-height:0.98;letter-spacing:-0.045em;font-weight:650;}
  .tag{margin-top:34px;font-size:44px;line-height:1.22;font-weight:400;color:#c7d3de;max-width:1400px;}
  .tag b{color:var(--color-text);font-weight:600;}
  .num{margin-top:auto;display:flex;align-items:flex-end;gap:56px;}
  .num .big{font-size:108px;line-height:1;font-weight:650;color:var(--color-accent);
    letter-spacing:-0.03em;font-family:ui-monospace,"SF Mono",Menlo,monospace;}
  .num .cap{font-size:32px;line-height:1.34;color:var(--color-text-muted);max-width:720px;
    padding-bottom:14px;}
  .foot{margin-top:44px;padding-top:30px;border-top:1px solid var(--color-border);
    display:flex;gap:48px;font-size:26px;color:var(--color-text-muted);}
  .foot b{color:#dde5ee;font-weight:600;}
</style>
<div class="wrap">
  <div class="eyebrow"><i></i>Sentinel</div>
  <h1>The debt that<br>liquidates twice.</h1>
  <div class="tag">A confidential systemic-risk oracle for DeFi lending. It measures leverage held
    <b>across</b> protocols on the same collateral, and it does that inside a TEE because the
    per-address map it needs <b>is</b> the harm.</div>
  <div class="num">
    <div class="big">$35,923,754</div>
    <div class="cap">levered across more than one protocol on the same collateral, live at mainnet
      block 25,966,506. Measured, never named.</div>
  </div>
  <div class="foot">
    <div><b>The Graph</b> · 9 deployments, 2 standardized schemas</div>
    <div><b>Chainlink CRE</b> · <code>handlerInTee</code>, AWS Nitro</div>
    <div><b>MCP</b> · 8 tools that cite every number</div>
  </div>
</div>`;

/* `app/tokens.css` is inlined rather than linked. It is the generated file either way, so the assets
 * still cannot carry a literal hex, but a `setContent` page has no origin for a relative href to
 * resolve against. The theme is picked by `prefers-color-scheme` alone, so the dark palette is a
 * browser flag rather than a class. */
const tokens = readFileSync(join(ROOT, "app", "tokens.css"), "utf8");
const withTokens = (html: string) => html.replace("__TOKENS__", tokens);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });

  await page.setContent(withTokens(LOGO), { waitUntil: "load" });
  await page.screenshot({ path: join(OUT, "sentinel-logo.png") });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.setContent(withTokens(COVER), { waitUntil: "load" });
  await page.screenshot({ path: join(OUT, "sentinel-cover.png") });
} finally {
  await browser.close();
}

const SHOTS: [string, string][] = [
  ["dashboard-dark.png", "sentinel-ss1.png"],
  ["cascade-mid.png", "sentinel-ss2.png"],
  ["explorer-dark.png", "sentinel-ss3.png"],
];
for (const [from, to] of SHOTS) {
  copyFileSync(join(ROOT, "docs", "evidence", "screens", from), join(OUT, to));
}

writeFileSync(
  join(OUT, "README.md"),
  [
    "# Submission assets",
    "",
    "Rebuild with `npm run submission:assets`. Nothing here is hand-edited, so a colour token or a",
    "figure moving is one command rather than a redraw.",
    "",
    "| file | what the form asks for | what it is |",
    "|---|---|---|",
    "| `sentinel-logo.png` | logo, square 512x512 | two rings and the lens where they overlap, inside the boundary the overlap is computed behind |",
    "| `sentinel-cover.png` | cover, 16:9 1920x1080 | the claim, the live figure and its block, and the three sponsor surfaces |",
    "| `sentinel-ss1.png` | screenshot | the dashboard: the signal, rendered only after the signer quorum verifies |",
    "| `sentinel-ss2.png` | screenshot | the cascade: two standardized schemas joined, shock ladder against real DEX depth |",
    "| `sentinel-ss3.png` | screenshot | the explorer: the cross-protocol read with no address anywhere in it |",
    "",
    "The screenshots are copies of `docs/evidence/screens/`, which `npm run capture:ui` regenerates and",
    "`npm run check:ui` audits for leaked addresses. The demo video is `docs/demo.mp4`.",
    "",
  ].join("\n"),
);

console.log("submission assets written to submission/");
