/**
 * The accessibility check that runs on every commit rather than once at design time.
 *
 * Two things are asserted. That every foreground/background pair the interface renders
 * clears its WCAG 2.2 AA threshold, in *both* themes — a light mode that was never
 * contrast-checked is a light mode that is broken for somebody. And that `app/tokens.css`
 * is exactly what `tokens.ts` generates, because otherwise the stylesheet could drift and
 * the ratios below would be measuring colours nobody sees.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COLORS,
  CONTRAST_PAIRS,
  RAMP,
  contrastRatio,
  luminance,
  readableInk,
  tokensCss,
  type ThemeName,
} from "../tokens";

const THEMES: ThemeName[] = ["dark", "light"];

describe("WCAG AA contrast", () => {
  for (const theme of THEMES) {
    for (const pair of CONTRAST_PAIRS) {
      it(`${theme}: ${pair.fg} on ${pair.bg} — ${pair.where}`, () => {
        const ratio = contrastRatio(COLORS[theme][pair.fg], COLORS[theme][pair.bg]);
        expect(ratio, `${ratio.toFixed(2)}:1, needs ${pair.min}:1`).toBeGreaterThanOrEqual(pair.min);
      });
    }
  }

  it("keeps a readable ink available on every ramp step", () => {
    // Heatmap cells are ramp steps rather than tokens, so the label colour is chosen at
    // draw time. This asserts the choice always has something to choose.
    for (const theme of THEMES) {
      for (const swatch of RAMP[theme]) {
        const ratio = contrastRatio(readableInk(swatch, theme), swatch);
        expect(ratio, `${theme} ramp ${swatch}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("the ramp", () => {
  it("is ordered in luminance, so it survives greyscale and colour-vision deficiency", () => {
    // The reason not to use a library's default categorical palette: those are chosen to
    // be distinguishable, not ordered, and coupling is a quantity.
    for (const theme of THEMES) {
      const luminances = RAMP[theme].map(luminance);
      for (let i = 1; i < luminances.length; i++) {
        const rising = luminances[i] > luminances[i - 1];
        const falling = luminances[i] < luminances[i - 1];
        expect(theme === "dark" ? rising : falling, `${theme} step ${i}`).toBe(true);
      }
    }
  });

  it("separates adjacent steps enough to be told apart", () => {
    for (const theme of THEMES) {
      for (let i = 1; i < RAMP[theme].length; i++) {
        const ratio = contrastRatio(RAMP[theme][i], RAMP[theme][i - 1]);
        expect(ratio, `${theme} steps ${i - 1}→${i}`).toBeGreaterThanOrEqual(1.35);
      }
    }
  });
});

describe("the generated stylesheet", () => {
  it("matches lib/ui/tokens.ts", () => {
    // Fails after a hand-edit to app/tokens.css, or after changing a token without
    // running `npm run tokens`.
    expect(readFileSync("app/tokens.css", "utf8")).toBe(tokensCss());
  });

  it("defines every role in both themes", () => {
    const css = readFileSync("app/tokens.css", "utf8");
    for (const role of Object.keys(COLORS.dark)) {
      const occurrences = css.split(`--color-${role}:`).length - 1;
      // Light block, dark class, dark media query, and the @theme mapping.
      expect(occurrences, `--color-${role}`).toBeGreaterThanOrEqual(4);
    }
  });
});
