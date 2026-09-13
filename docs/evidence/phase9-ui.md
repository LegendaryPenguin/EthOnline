# Phase 9 — the interface, and what was actually measured

Every number below was produced by a command in this repo, on the live snapshot in `data/`,
against the signed report in `data/report.json`. Nothing here is an estimate. Where a claim
cannot be measured honestly, this document says so instead of rounding it up.

Reproduce all of it:

```sh
npm run tokens        # regenerate app/tokens.css from lib/ui/tokens.ts
npx vitest run        # 333 tests, incl. contrast + no-leak
npm run build
npm run check:ui      # what crosses the wire
npm run frames        # render cost of a slider step
npm run capture:ui    # real browser: fps, keyboard, reduced motion, screenshots
```

---

## 1. "≥55 fps on live data, measured, not eyeballed"

This claim has two halves, because no single measurement covers it honestly.

**Half one — the React work, headless and in CI.** `npm run frames`
(`scripts/measure-frame-cost.tsx`) renders the exact tree a slider step re-renders —
`ContagionGraph` plus `CascadeTimeline`, including rebuilding the cumulative per-protocol map
— once per rung, 7 repeats, median per rung:

| | |
|---|---|
| rungs measured | 41 |
| fastest rung | 0.19 ms |
| median rung | 0.23 ms |
| worst rung | 0.68 ms (400 bps) |
| 60 fps frame budget | 16.67 ms |
| headroom on the worst rung | **24.3×** |
| ladder shipped to the client | 113 KB |

The script **fails the run** if the worst rung exceeds the budget, so this is a regression gate
and not a one-off reading. What it does *not* measure: rasterisation and compositing. A headless
render cannot claim those, and the script prints that caveat itself.

**Half two — real animation frames in a real browser.** `npm run capture:ui` installs a
`requestAnimationFrame` counter in the page, then drives the slider **with the keyboard only** —
40 `ArrowRight` presses, 25 ms apart — and reads the counter back:

```
keyboard drive: 30 → 40 over 40 presses, 68 frames in 1126 ms = 60.4 fps, worst frame 16.8 ms
in-app meter:   61 fps over 71 frames, worst single frame 16.8 ms
```

60.4 fps against a 55 fps criterion, and the worst *single* frame is 16.8 ms — one frame at the
budget, not a smooth average hiding a 40 ms stall. The run fails below 55 fps.

The two independent counters agreeing (60.4 vs 61 fps, identical worst frame) is the point: the
in-app meter in `components/ShockExplorer.tsx` is the same measurement a judge can run
themselves by dragging the slider, and it is not a decorative number.

> The in-app meter had a real bug worth recording: it ended its measurement window on every
> `keyup`, so arrowing across the range reported "118 fps over 2 frames" — the last two frames
> of the last press. It now ends on 600 ms of *inactivity* (`ShockExplorer.tsx:92`), which is
> why it agrees with Playwright's counter. The fix is the reason the two numbers can be
> compared at all.

## 2. Rendered from a live snapshot, not fixtures

`lib/ui/view-model.ts:loadDashboard` reads `data/report.json`, `data/completed.json` and
`data/shock-ladder.json`, verifies the report's signatures through
`lib/signal/consume.ts:verifySignalReport`, and returns `empty` / `error` rather than inventing
values. `npm run check:ui` asserts the dashboard actually rendered the live markers
(`signature verified`, `Price shock to ETH and BTC`, `Borrower overlap`) so an error page cannot
pass the leak check by being blank.

The interface therefore reports: 90 borrowers observed, $2.867B of evaluable debt,
**$35,923,754 (125 bps)** levered across more than one protocol on the same collateral, and a
composite score of 2201 bps.

**The page states, in prose, that its cascade sample is not the report's own reading**
(`app/page.tsx`): the shock explorer runs on the completed cross-protocol snapshot — $1.46B of
borrowed value, **13.97%** of protocol-reported debt, 99.73% of cross-protocol collateral value
modelled. Conflating those two coverage figures is the easiest way to accidentally overstate
this project, so the difference is on screen rather than in a footnote.

## 3. The interface cannot be the leak — proven twice, two different ways

| check | what it searches | result |
|---|---|---|
| `lib/ui/__tests__/view-model.test.ts` | the serialised view-model payload | no address |
| `npm run check:ui` (`scripts/check-ui.mts`) | the actual HTTP response body of `/` and `/styleguide` | **zero** 40-hex strings on either route |

The second is not redundant. A component could interpolate an account into a `title`, a `data-`
attribute or an SVG `aria-label` without it ever appearing in the view model; the HTML is the
only place that shows up. Checked against a **359-account** sample, of which 139 are
multi-protocol borrowers — precisely the addresses a liquidation bot would want.

```
/ → 200, 241 KB          40-hex strings in the response: none    accounts from the sample: 0
/styleguide → 200, 118 KB 40-hex strings in the response: none   accounts from the sample: 0
```

## 4. Accessibility as a test, not an intention

- **Contrast.** `lib/ui/__tests__/contrast.test.ts` regenerates `app/tokens.css` in memory and
  fails on drift from `lib/ui/tokens.ts`, then checks all **18 documented foreground/background
  pairs** in both themes against WCAG 2.2 AA (4.5:1 body, 3.0:1 large text and non-text UI
  boundaries), and enforces three properties of the five-step ramp: monotonic luminance,
  ≥1.35:1 separation between neighbours, and a ≥4.5:1 readable ink on **every** step.
- **Ramp inks ship as CSS variables** (`--color-ramp-N-ink`), so a heatmap cell's label flips
  with the theme without any component reading the DOM. `CouplingHeatmap.tsx` is a real
  `<table>` with a `caption` and `scope` attributes, and prints the value in every cell — colour
  is never the only channel. Same rule in `Badge`: dot plus ring plus text.
- **Keyboard.** `capture:ui` tabs to the slider, asserts `document.activeElement` is `#shock`,
  asserts the focus outline computes to `solid`, and asserts the value moved. Screenshot:
  `screens/explorer-keyboard-focus.png`.
- **`prefers-reduced-motion`.** A separate Playwright context with `reducedMotion: "reduce"`
  asserts the "Replay cascade" button is *replaced* by "Step from round 1" and that clicking it
  lands on round 1 of 20. `app/globals.css` also kills transitions wholesale under the query.
  Screenshot: `screens/reduced-motion.png`.
- **Skip link** to `#main`, and a three-state theme control (system / light / dark) as a real
  radio `fieldset` rather than a toggle that cannot express "follow the OS".

A note on what the contrast test cost: three ramp steps failed it, and the fix was not cosmetic.
A swatch can be too light for the dark ink and too dark for the light ink at the same time — a
forbidden luminance band (dark theme: 0.146 < L < 0.20; light: 0.183 < L < 0.214). Both ramps
step *around* that band, which is why each has a deliberate hue jump at step 3. The reason is
commented at the ramp definition and is rule 6 of `docs/DATAVIZ.md`, so nobody "fixes" it later.

## 5. Both themes correct

`screens/dashboard-{dark,light}.png` (full page, 1920×3107), `screens/explorer-{dark,light}.png`,
`screens/styleguide-{dark,light}.png`. The theme is applied pre-paint by an inline script in
`app/layout.tsx`, so there is no flash of the wrong theme. `/styleguide` prints the **live**
computed ratio for all 18 pairs in both themes next to each swatch.

## 6. Every state designed, no spinner-forever path

`components/states.tsx`: `LoadingState` (also wired as `app/loading.tsx`), `EmptyState` — which
names the missing files and the exact commands to produce them — and `ErrorState`. Staleness is
a separate axis, handled in `components/Provenance.tsx`, whose wording changes with the age of
the reading and, once stale, says the thing that matters out loud: *a recording, not a current
reading*. All three states render inside `/styleguide` via `Shell({ embedded })`, so they are
reviewable without breaking the app to see them.

## 7. Dataviz rules, no default palettes

`docs/DATAVIZ.md` holds the ten rules; the components cite it by name in their doc comments.
The two that changed the design most:

- **Rule 1 — no address is ever a mark.** The contagion graph draws protocols and shared
  collateral assets. Publishing the per-address graph is the harm this project exists to avoid,
  so the picture cannot be the leak either.
- **Encode against what the viewer is comparing.** Node fill was initially scaled absolutely
  against total debt — at a 30% shock even the worst cascade clears well under 1% of it, so
  every node sat on ramp step 0 and the picture said nothing. Fill is now liquidation volume
  relative to the worst protocol so far (`ContagionGraph.tsx:37`), which is the comparison a
  viewer is actually making. The legend states which scale it is.

Layout is deterministic and computed server-side (`lib/ui/view-model.ts:layout`), so two loads
are pixel-identical and the only motion on the page is the cascade advancing — which is also
what makes the frame measurement meaningful rather than a benchmark of a physics simulation.

Screenshot: `screens/contagion-graph.png`.

## 8. Two honesty bugs found by reconciling the screen against the data

Recorded because "we checked the numbers" is worth nothing without saying what checking found.

1. **The headline was wrong.** It read 22.01% multi-protocol share. 2201 bps is the *composite
   score*; the multi-protocol share is 125 bps. An 18× overstatement of the project's own
   finding, in the largest type on the page. Rewritten, along with the levered-share and score
   captions — the score caption now also states that its level is not comparable across
   readings, only its change. The `/styleguide` demo carried the same error and was corrected.
2. **`$0` for a real liquidation.** `usdShort` rounded sub-dollar figures to `$0`, so Morpho's
   round-2 liquidation displayed as nothing at all. It now returns `<$1`
   (`lib/ui/format.ts`) — visible in `screens/contagion-graph.png`.

## Screenshot inventory

`docs/evidence/screens/` — `dashboard-dark`, `dashboard-light`, `explorer-dark`,
`explorer-light`, `explorer-keyboard-focus`, `cascade-mid`, `contagion-graph`,
`reduced-motion`, `styleguide-dark`, `styleguide-light`. All 1920×1080 or full-page at that
width, all regenerated by `npm run capture:ui`, all raw material for the demo video.
