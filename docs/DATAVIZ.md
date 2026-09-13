# Sentinel's dataviz rules

These are the rules every chart in this repository follows. They exist because Sentinel's
whole claim is that a number can be published honestly without publishing the people it
came from — and a chart is where that claim is easiest to break, either by leaking an
identity or by drawing a certainty the model does not have.

They are enforced where enforcement is possible: `lib/ui/__tests__/contrast.test.ts` checks
rules 6 and 7 by measurement, `lib/ui/__tests__/view-model.test.ts` checks rules 1 and 3 by
searching the serialised payload, and `lib/ui/ladder.ts` checks rule 2 by refusing to build
a ladder that violates it.

## 1. No chart may plot an entity that can be identified

Nodes are protocols and collateral assets. There is no per-address mark anywhere, not even
anonymised, not even in a tooltip: a scatter of 5,600 borrower points with debt on one axis
and health factor on the other *is* the hunting map, whether or not the labels are hidden,
because the position of the mark is the join key. The graph is drawn from aggregates that
the enclave would also be willing to publish.

Test: `view-model.test.ts` serialises the entire dashboard payload and fails if it contains
any account address from the sample, then fails again if it contains any 40-hex string other
than the workflow owner and the accepted signers.

## 2. A single number is a claim; draw the bracket

Every cascade figure comes with an upper bound, because Aave E-Mode categories are not
observable from the subgraph and the difference between "inferred" and "every ambiguous book
at its boundary" is three orders of magnitude at some shock levels
(`docs/evidence/phase4-cascade.md`). So:

- the point estimate is drawn solid, the bound as a lighter band or a hollow cap;
- the band is never omitted when it exists, and never drawn when it does not;
- axis labels say which is which, in words, not in a legend swatch alone.

A chart that shows only the point estimate is a chart that has to be re-drawn the first time
someone asks how much is inferred.

## 3. Show provenance next to the number, not in a footer

Anything derived from a snapshot renders with the block it was read at and how old it is.
Freshness has three named states — `fresh` (<1 h), `aging` (<24 h), `stale` — and the stale
state changes the wording on the page rather than adding a small grey caption to it. A
dashboard that looks live when it is a day old is lying with layout.

## 4. Motion carries meaning or does not happen

There is exactly one animation with semantics: the cascade advancing round by round, one
`MOTION.cascade` dwell per round, because rounds are the model's unit of causality
(round 1 is the shock, rounds 2+ are liquidations caused by liquidations). Everything else
is a state change at `MOTION.quick` or less.

No force-directed layout. The graph's positions are computed server-side on a fixed ring
(`view-model.ts:layout`) so that two loads are pixel-identical, a screenshot in a document
can be compared to what a reader sees, and the only thing moving is the thing that means
something. `prefers-reduced-motion` replaces the round-by-round animation with a control
that steps rounds discretely — the information stays, the motion goes.

## 5. Colour is never the only channel

Every risk stance carries a label and a shape as well as a hue. Every heatmap cell carries
its value as text. Every graph edge encodes weight as stroke width in addition to opacity.
This is what makes the interface survive greyscale, projector gamma, and the ~8% of men
with a red-green deficiency — and it is also what makes it survive video compression, which
is the actual delivery medium for the demo.

## 6. The ramp is sequential and ordered by luminance

Coupling is a quantity with a good end (zero) and no meaningful midpoint, so the ramp is
sequential, not diverging, and not categorical. Five steps, strictly monotone in relative
luminance, ≥1.35:1 between neighbours, and every step admits a text ink at ≥4.5:1.

That last constraint is why the ramp has a visible hue jump in dark mode: a swatch in the
middle luminance band is simultaneously too light for the light ink and too dark for the
dark one, so the ramp steps over that band rather than through it. The alternative — a
smooth ramp with one unreadable cell — is a chart with a hole in it.

No default library palette. `viridis` is ordered but unreadable at both ends against our
surfaces; d3's `schemeCategory10` is categorical, which would imply the buckets are
unordered kinds rather than degrees of the same thing.

## 7. Both themes are checked, not one theme inverted

Light mode is not dark mode with the values flipped: the accent darkens from `#3FD9C4` to
`#0B6F60` because a teal legible on near-black is not legible on near-white, and the ramp
runs the other direction in luminance. All 18 documented foreground/background pairs are
measured in both themes on every test run, at 4.5:1 for body text and 3.0:1 for large text
and non-text boundaries.

## 8. Round in display, never in the underlying figure

`lib/ui/format.ts` is the only place numbers become strings. Abbreviated values (`$5.72B`)
always carry the exact figure in a `title`, so the number a viewer reads off a tile and the
number in `data/*.json` can always be reconciled. Percentages state their unit; basis points
are converted once, in `bps()`, and never inline.

## 9. State the denominator

`22.01% multi-protocol` is meaningless without *of what*: the sample covers 62.66% of
protocol-reported debt, and the share is of evaluable debt, not of total debt. Every ratio
on screen names its denominator in the label or in an adjacent line — not in a tooltip that
a video viewer will never open.

## 10. An empty chart says what to run

No spinner that outlives its data. Missing inputs render the empty state with the exact
commands that produce them (`view-model.ts:COMMANDS`); a signal that fails signature
verification renders an error naming the reason, never a chart. Rendering an unverified
signal would defeat the reason for signing it.
