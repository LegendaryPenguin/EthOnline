/**
 * The design system's single source of truth.
 *
 * `app/tokens.css` is generated from this file by `npm run tokens`, so a colour cannot
 * drift between the stylesheet, the styleguide and the contrast test —
 * `__tests__/contrast.test.ts` regenerates the CSS in memory and fails if the committed
 * file differs, then checks every documented pair against WCAG AA.
 *
 * Two decisions worth stating, because they constrain everything else:
 *
 *   - **The risk ramp is not a rainbow.** Four steps that read in order even in
 *     greyscale, matching the four stances the signal actually has (`docs/SIGNAL.md`).
 *     Colour is never the only carrier: every stance also has a label and a shape.
 *   - **Both themes are first-class.** Light is not dark with the values flipped; the
 *     accent darkens in light mode because a teal that is legible on near-black is not
 *     legible on near-white.
 */

export type ThemeName = "dark" | "light";

/** Semantic colour roles. Every colour in the interface comes from this list. */
export type ColorRole =
  | "bg"
  | "surface"
  | "surface-raised"
  | "border"
  | "border-strong"
  | "text"
  | "text-muted"
  | "text-faint"
  | "accent"
  | "accent-ink"
  | "focus"
  | "calm"
  | "watch"
  | "warn"
  | "alert"
  | "ink-on-scale";

export const COLORS: Record<ThemeName, Record<ColorRole, string>> = {
  dark: {
    bg: "#080B0F",
    surface: "#111820",
    "surface-raised": "#18212B",
    border: "#26333F",
    "border-strong": "#5A7185",
    text: "#E9EFF5",
    "text-muted": "#A7B7C6",
    "text-faint": "#8496A6",
    accent: "#3FD9C4",
    "accent-ink": "#04211D",
    focus: "#7FB3FF",
    calm: "#57B98A",
    watch: "#E9C05A",
    warn: "#F0904E",
    alert: "#F26D78",
    "ink-on-scale": "#080B0F",
  },
  light: {
    bg: "#F6F8FA",
    surface: "#FFFFFF",
    "surface-raised": "#EEF3F7",
    border: "#D2DCE5",
    "border-strong": "#79899A",
    text: "#0D161E",
    "text-muted": "#4B5C6B",
    "text-faint": "#5D6E7D",
    accent: "#0B6F60",
    "accent-ink": "#FFFFFF",
    focus: "#1D5FD0",
    calm: "#1F6B45",
    watch: "#7A5300",
    warn: "#9C4212",
    alert: "#A4262F",
    "ink-on-scale": "#FFFFFF",
  },
};

/**
 * The heatmap ramp: five steps, low to high, per theme.
 *
 * Sequential rather than diverging, because coupling has no meaningful midpoint — zero
 * overlap is not "neutral", it is the good end. Hue and lightness move together so the
 * order survives greyscale printing and the common colour-vision deficiencies.
 *
 * The steps are not free choices. `__tests__/contrast.test.ts` requires strictly monotone
 * luminance in the theme's direction, ≥1.35:1 between neighbours, and an ink at ≥4.5:1 on
 * every step — and the last constraint forbids a band of middle luminances outright, since
 * a swatch can be too light for the light ink and too dark for the dark one. Dark mode's
 * step 3 therefore jumps from teal straight to olive; that gap is the forbidden band.
 */
export const RAMP: Record<ThemeName, string[]> = {
  dark: ["#101C24", "#17434A", "#1F6559", "#7E9440", "#E9AE55"],
  light: ["#EAF1F4", "#B7D6D2", "#7FBBAE", "#A9873C", "#8A5A20"],
};

/**
 * Which ramp step a 0–1 quantity lands on.
 *
 * Binned rather than interpolated, and deliberately: a continuous gradient invites the
 * viewer to read a precision the coupling estimate does not have, and five discrete steps
 * can each be checked for contrast, which a gradient cannot. The value is always printed in
 * the cell as well — see rule 5 in `docs/DATAVIZ.md`.
 */
export function rampIndex(fraction: number): number {
  const steps = RAMP.dark.length;
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.min(steps - 1, Math.floor(fraction * steps));
}

/** Type scale in rem, named by use rather than by size. */
export const TYPE = {
  "display": "2.25rem",
  "title": "1.5rem",
  "heading": "1.125rem",
  "body": "0.9375rem",
  "label": "0.8125rem",
  "micro": "0.6875rem",
} as const;

/** Spacing scale in rem. Four-step, because a nine-step scale is nine chances to be inconsistent. */
export const SPACE = { xs: "0.25rem", sm: "0.5rem", md: "1rem", lg: "1.5rem", xl: "2.5rem" } as const;

export const RADIUS = { sm: "0.25rem", md: "0.5rem", lg: "0.875rem", pill: "999px" } as const;

/**
 * Motion durations in ms.
 *
 * `cascade` is the per-round dwell in the contagion animation: slow enough to read a
 * round, fast enough that a ten-round cascade does not outlast the viewer's patience.
 * Every one of these collapses to 0 under `prefers-reduced-motion`.
 */
export const MOTION = { instant: 90, quick: 160, cascade: 420 } as const;

/**
 * Foreground/background pairs the interface actually renders, with the ratio each must
 * clear. 4.5 for body text, 3.0 for large text and for non-text UI boundaries — the two
 * thresholds WCAG 2.2 AA sets.
 *
 * Listed explicitly rather than derived: a generated cross-product would either pass
 * trivially or fail on pairs that never appear on screen, and neither tells us anything.
 */
export const CONTRAST_PAIRS: { fg: ColorRole; bg: ColorRole; min: number; where: string }[] = [
  { fg: "text", bg: "bg", min: 4.5, where: "body copy on the page" },
  { fg: "text", bg: "surface", min: 4.5, where: "body copy in a card" },
  { fg: "text", bg: "surface-raised", min: 4.5, where: "body copy in a raised panel" },
  { fg: "text-muted", bg: "bg", min: 4.5, where: "secondary copy on the page" },
  { fg: "text-muted", bg: "surface", min: 4.5, where: "secondary copy in a card" },
  { fg: "text-faint", bg: "surface", min: 4.5, where: "axis labels and units" },
  { fg: "text-faint", bg: "surface-raised", min: 4.5, where: "table captions" },
  { fg: "accent", bg: "bg", min: 4.5, where: "links and the verified badge" },
  { fg: "accent", bg: "surface", min: 4.5, where: "links inside a card" },
  { fg: "accent-ink", bg: "accent", min: 4.5, where: "text on a filled button" },
  { fg: "focus", bg: "bg", min: 3.0, where: "focus ring against the page" },
  { fg: "focus", bg: "surface", min: 3.0, where: "focus ring against a card" },
  { fg: "calm", bg: "surface", min: 4.5, where: "the normal stance label" },
  { fg: "watch", bg: "surface", min: 4.5, where: "the watch stance label" },
  { fg: "warn", bg: "surface", min: 4.5, where: "the warn stance label" },
  { fg: "alert", bg: "surface", min: 4.5, where: "the alert stance label" },
  { fg: "border-strong", bg: "surface", min: 3.0, where: "chart axes and node outlines" },
];

/** sRGB relative luminance, per WCAG 2.x. */
export function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Which of the theme's two ink colours to draw on an arbitrary swatch.
 *
 * Needed for heatmap cell labels, where the background is a ramp step rather than a
 * token, so the pairing cannot be enumerated ahead of time.
 */
export function readableInk(swatch: string, theme: ThemeName): string {
  const light = COLORS[theme].text;
  const dark = COLORS[theme]["ink-on-scale"];
  return contrastRatio(light, swatch) >= contrastRatio(dark, swatch) ? light : dark;
}

/** The generated stylesheet, so the test and the build agree by construction. */
export function tokensCss(): string {
  // Each ramp step ships the ink that is legible on it, resolved here rather than in the
  // component: a heatmap cell's label has to flip with the theme, and a component cannot
  // know which theme is active without reading the DOM.
  const block = (theme: ThemeName) =>
    [
      ...Object.entries(COLORS[theme]).map(([role, value]) => `  --color-${role}: ${value};`),
      ...RAMP[theme].flatMap((value, i) => [
        `  --color-ramp-${i}: ${value};`,
        `  --color-ramp-${i}-ink: ${readableInk(value, theme)};`,
      ]),
    ].join("\n");

  const scale = [
    ...Object.entries(TYPE).map(([k, v]) => `  --text-${k}: ${v};`),
    ...Object.entries(SPACE).map(([k, v]) => `  --space-${k}: ${v};`),
    ...Object.entries(RADIUS).map(([k, v]) => `  --radius-${k}: ${v};`),
    ...Object.entries(MOTION).map(([k, v]) => `  --duration-${k}: ${v}ms;`),
  ].join("\n");

  const themeMap = [
    ...Object.keys(COLORS.dark).map((role) => `  --color-${role}: var(--color-${role});`),
    ...RAMP.dark.flatMap((_, i) => [
      `  --color-ramp-${i}: var(--color-ramp-${i});`,
      `  --color-ramp-${i}-ink: var(--color-ramp-${i}-ink);`,
    ]),
  ].join("\n");

  return `/* Generated by \`npm run tokens\` from lib/ui/tokens.ts. Do not edit by hand. */

:root {
${block("light")}
${scale}
}

.theme-dark {
${block("dark")}
}

@media (prefers-color-scheme: dark) {
  :root:not(.theme-light) {
${block("dark")
  .split("\n")
  .map((line) => `  ${line}`)
  .join("\n")}
  }
}

/* Expose the semantic roles to Tailwind's utility generation. */
@theme inline {
${themeMap}
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}
`;
}
