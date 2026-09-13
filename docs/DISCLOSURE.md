# Prior-work disclosure

Written for the ETHGlobal team and for judges, unprompted, because the AI track is judged in two
pools and the difference between them is exactly this question.

## The pool we are in

**Start Fresh (net-new).** Sentinel was begun and built during ETHOnline 2026. Every file in this
repository was written during the event. The first commit is an empty README; the history is
granular from there, one commit per phase, and the reasoning is in the commit messages rather
than in a squashed summary.

## Prior work that exists, and how it relates

The author has two earlier repositories. Neither contributes code to this one, and both are
named here so the statement can be checked rather than taken on trust.

| Repository | Relationship to Sentinel |
|---|---|
| `LegendaryPenguin/Parley` | **Frontend design principles only.** No files, components, tokens, or configuration were copied. The design system in `lib/ui/tokens.ts`, `app/tokens.css` and `docs/DATAVIZ.md` was built fresh for this project — which is verifiable from the fact that its constraints are specific to this project's data (see the forbidden-luminance-band derivation in `docs/evidence/phase9-ui.md`). |
| `LegendaryPenguin/EthGlobal26` (Veritas) | **Reference only, and a prior winning project.** Consulted for what a strong submission looks like. No code, schema, contract, or document was reused. |

## What "no copied code" means here concretely

- No file in this repository originates in another project of the author's.
- The Next.js scaffold came from `create-next-app`, which the track rules permit explicitly
  ("Open-source starter kits are fine; project-specific prior code is not").
- Dependencies are ordinary npm packages plus the Chainlink CRE SDK and Foundry.
- The dev signing keys in `lib/signal/dev-sign.ts` are generated for this repository, are
  committed on purpose so the verification path runs offline, and must never be reused for
  anything real. That is stated in the file itself.

## Built with an AI agent

This project was built solo, with Claude Code doing the implementation and testing under the
author's direction. Stating it because it is true, it is visible in the commit history, and it
is not against any rule — the AI track is about using The Graph from AI environments, and this
repository ships an MCP server and a SKILL for exactly that.

The work is not unreviewed. The honesty machinery in this repo exists because the review found
real errors and they are recorded rather than quietly fixed: a headline number that overstated
the project's own finding by 18×, a coverage figure conflated with a different quantity, a
frame-rate meter that measured the wrong window, and a sub-dollar liquidation displayed as `$0`.
All four are written up in `docs/evidence/phase9-ui.md`.

## Contact

Happy to answer any question about provenance in writing or on a call.
