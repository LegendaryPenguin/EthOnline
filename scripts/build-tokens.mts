/**
 * Generate `app/tokens.css` from `lib/ui/tokens.ts`.
 *
 *   npm run tokens
 *
 * The generated file is committed so `next dev` needs no build step, and
 * `lib/ui/__tests__/contrast.test.ts` fails if it is stale — which is the only reason
 * generating rather than hand-writing it is worth the extra script.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { contrastRatio, COLORS, CONTRAST_PAIRS, tokensCss } from "../lib/ui/tokens";

const css = tokensCss();
const path = "app/tokens.css";
const previous = (() => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
})();

writeFileSync(path, css);
console.log(`${previous === css ? "unchanged" : "wrote"} ${path} (${css.length} bytes)`);

let worst = { ratio: Infinity, label: "" };
for (const theme of ["dark", "light"] as const) {
  for (const pair of CONTRAST_PAIRS) {
    const ratio = contrastRatio(COLORS[theme][pair.fg], COLORS[theme][pair.bg]);
    if (ratio < worst.ratio) worst = { ratio, label: `${theme} ${pair.fg} on ${pair.bg}` };
    if (ratio < pair.min) {
      console.error(
        `FAIL ${theme}: ${pair.fg} on ${pair.bg} is ${ratio.toFixed(2)}:1, ` +
          `needs ${pair.min}:1 (${pair.where})`,
      );
      process.exitCode = 1;
    }
  }
}
console.log(
  `${CONTRAST_PAIRS.length * 2} pairs checked; tightest is ${worst.label} at ${worst.ratio.toFixed(2)}:1`,
);
