/**
 * What one frame of the shock slider actually costs.
 *
 *   npx tsx scripts/measure-frame-cost.tsx
 *
 * The acceptance criterion is "≥55 fps on live data, measured, not eyeballed", and there are
 * two honest halves to that. The browser half is in the app: `components/ShockExplorer.tsx`
 * counts real `requestAnimationFrame` callbacks during your own drag and prints the observed
 * rate and the worst single frame. This script is the other half, and it is the half that can
 * run in CI: it renders the exact component tree a slider step re-renders, once per rung, and
 * reports the per-render cost against the 16.67 ms budget of a 60 fps frame.
 *
 * What this measures: the React work a shock change causes — building the cumulative
 * per-protocol map, slicing the rounds, and producing the SVG and the timeline. What it does
 * not measure: rasterisation and compositing, which no headless measurement can honestly
 * claim. Both numbers are reported so the claim in `docs/evidence/phase9-ui.md` can be
 * specific about which is which.
 */

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ContagionGraph } from "../components/ContagionGraph";
import { CascadeTimeline } from "../components/CascadeTimeline";
import type { ShockLadder } from "../lib/ui/ladder";
import { loadDashboard } from "../lib/ui/view-model";

const FRAME_BUDGET_MS = 1000 / 60;
const REPEATS = 7;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** One slider step: everything `ShockExplorer` recomputes and re-renders for a new rung. */
function renderRung(ladder: ShockLadder, index: number, graph: Parameters<typeof ContagionGraph>[0]["graph"]) {
  const rung = ladder.steps[index];
  const round = rung.rounds.length;
  const cumulative: Record<string, number> = {};
  for (const r of rung.rounds.slice(0, round)) {
    for (const [protocol, value] of Object.entries(r.byProtocol)) {
      cumulative[protocol] = (cumulative[protocol] ?? 0) + value;
    }
  }
  const current = round >= 1 ? rung.rounds[round - 1] : null;
  return (
    renderToStaticMarkup(
      <ContagionGraph
        graph={graph}
        liquidatedByProtocol={current?.byProtocol ?? {}}
        cumulativeByProtocol={cumulative}
        round={round}
      />,
    ).length +
    renderToStaticMarkup(
      <CascadeTimeline rung={rung} activeRound={round} onSelectRound={() => {}} />,
    ).length
  );
}

async function main() {
  const state = await loadDashboard();
  if (state.status !== "ready") {
    console.error(`dashboard is ${state.status}; run the snapshot pipeline first`);
    process.exit(1);
  }
  const { ladder, graph } = state.data;

  // One warm pass so the numbers are steady-state rather than a measurement of JIT warm-up.
  for (let i = 0; i < ladder.steps.length; i++) renderRung(ladder, i, graph);

  const perRung: { shockBps: number; ms: number; rounds: number }[] = [];
  for (let i = 0; i < ladder.steps.length; i++) {
    const samples: number[] = [];
    for (let r = 0; r < REPEATS; r++) {
      const started = performance.now();
      renderRung(ladder, i, graph);
      samples.push(performance.now() - started);
    }
    perRung.push({
      shockBps: ladder.steps[i].shockBps,
      ms: median(samples),
      rounds: ladder.steps[i].rounds.length,
    });
  }

  const worst = perRung.reduce((a, b) => (b.ms > a.ms ? b : a));
  const all = perRung.map((r) => r.ms);
  const payloadBytes = readFileSync("data/shock-ladder.json").length;

  console.log(`rungs measured: ${perRung.length}, ${REPEATS} renders each, median per rung`);
  console.log(`  fastest rung: ${Math.min(...all).toFixed(2)} ms`);
  console.log(`  median rung:  ${median(all).toFixed(2)} ms`);
  console.log(
    `  worst rung:   ${worst.ms.toFixed(2)} ms at ${worst.shockBps} bps (${worst.rounds} rounds drawn)`,
  );
  console.log(`  frame budget at 60 fps: ${FRAME_BUDGET_MS.toFixed(2)} ms`);
  console.log(
    `  headroom on the worst rung: ${(FRAME_BUDGET_MS / worst.ms).toFixed(1)}× ` +
      `(${(1000 / worst.ms).toFixed(0)} fps if render were the only cost)`,
  );
  console.log(`  precomputed ladder shipped to the client: ${(payloadBytes / 1024).toFixed(0)} KB`);
  console.log(
    "  not measured here: rasterisation and compositing. The in-app meter in " +
      "components/ShockExplorer.tsx counts real animation frames during a drag.",
  );

  if (worst.ms > FRAME_BUDGET_MS) {
    console.error(`FAIL worst rung ${worst.ms.toFixed(2)} ms exceeds the 60 fps frame budget`);
    process.exitCode = 1;
  }
}

// Not top-level `await`: this file is JSX, which tsx transforms as CommonJS, where a
// top-level await is a syntax error.
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
