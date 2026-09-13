"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ShockLadder } from "@/lib/ui/ladder";
import type { ContagionGraph as Graph } from "@/lib/ui/view-model";
import { bps, count, usdExact, usdShort } from "@/lib/ui/format";
import { ContagionGraph } from "./ContagionGraph";
import { CascadeTimeline } from "./CascadeTimeline";
import { Badge, Stat, StatGrid } from "./primitives";

/** Per-round dwell in ms. Mirrors `MOTION.cascade`; read from the token at runtime. */
const CASCADE_MS = 420;

/**
 * The centrepiece: drag the shock, watch the cascade unfold round by round.
 *
 * Nothing here simulates anything. Every rung was precomputed by `npm run shock:ladder`
 * from the same model the evidence documents were written from (`lib/ui/ladder.ts` explains
 * why the browser is the wrong place to run it), so dragging the slider is an array index
 * and a dropped frame would be a rendering bug rather than a modelling one — which is what
 * makes the frame meter below a meaningful measurement instead of a benchmark of the model.
 */
export function ShockExplorer({
  ladder,
  graph,
  /** Where the slider opens: the shock the signed report quotes, so the page and the report agree. */
  initialShockBps,
}: {
  ladder: ShockLadder;
  graph: Graph;
  initialShockBps: number;
}) {
  const [index, setIndex] = useState(() => {
    const at = ladder.steps.findIndex((s) => s.shockBps === initialShockBps);
    return at >= 0 ? at : ladder.steps.length - 1;
  });
  const rung = ladder.steps[index];
  const lastRound = rung.rounds.length;

  const [round, setRound] = useState(lastRound);
  const [playing, setPlaying] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [fps, setFps] = useState<{ frames: number; ms: number; worstFrameMs: number } | null>(null);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Changing the shock lands on the converged result. Replaying the rounds is a deliberate
  // act, because a cascade that restarts on every pixel of a drag is unreadable.
  useEffect(() => {
    setPlaying(false);
    setRound(ladder.steps[index].rounds.length);
  }, [index, ladder.steps]);

  useEffect(() => {
    if (!playing) return;
    if (round >= lastRound) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setRound((r) => r + 1), CASCADE_MS);
    return () => clearTimeout(timer);
  }, [playing, round, lastRound]);

  /**
   * Counts real frames while the slider is being used, and reports the worst single frame.
   *
   * An average alone would hide exactly the failure the acceptance criterion cares about —
   * one 40 ms frame inside an otherwise smooth drag is the stutter a viewer notices.
   */
  const measuring = useRef<number | null>(null);
  const startMeasuring = useCallback(() => {
    if (measuring.current !== null) return;
    let frames = 0;
    let worst = 0;
    const started = performance.now();
    let previous = started;
    const tick = (now: number) => {
      frames++;
      worst = Math.max(worst, now - previous);
      previous = now;
      setFps({ frames, ms: now - started, worstFrameMs: worst });
      measuring.current = requestAnimationFrame(tick);
    };
    measuring.current = requestAnimationFrame(tick);
  }, []);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopMeasuring = useCallback(() => {
    // Stops when the interaction stops, not when a key comes up. Arrowing across the range is
    // one interaction of forty presses; ending the measurement on each keyup would report the
    // last two frames and call it a frame rate.
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => {
      if (measuring.current !== null) cancelAnimationFrame(measuring.current);
      measuring.current = null;
    }, 600);
  }, []);
  useEffect(() => () => {
    if (measuring.current !== null) cancelAnimationFrame(measuring.current);
  }, []);

  const cumulative: Record<string, number> = {};
  for (const r of rung.rounds.slice(0, round)) {
    for (const [protocol, value] of Object.entries(r.byProtocol)) {
      cumulative[protocol] = (cumulative[protocol] ?? 0) + value;
    }
  }
  const current = round >= 1 && round <= lastRound ? rung.rounds[round - 1] : null;
  const shownLiquidated = rung.rounds
    .slice(0, round)
    .reduce((total, r) => total + r.liquidatedDebtUsd, 0);

  const reversal = ladder.distressReversals.find((r) => r.shockBps === rung.shockBps);
  const observedFps = fps && fps.ms > 0 ? (1000 * fps.frames) / fps.ms : null;

  return (
    <div className="flex flex-col gap-[var(--space-lg)]">
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-[var(--space-lg)]">
        <div className="flex flex-wrap items-end justify-between gap-[var(--space-md)]">
          <div>
            <label
              htmlFor="shock"
              className="block text-[length:var(--text-micro)] uppercase tracking-wide text-[var(--color-text-faint)]"
            >
              Price shock to ETH and BTC
            </label>
            <output
              htmlFor="shock"
              className="font-mono text-[length:var(--text-display)] leading-none"
            >
              −{bps(rung.shockBps, 0)}
            </output>
          </div>
          <div className="flex items-center gap-[var(--space-sm)]">
            <button
              type="button"
              onClick={() => {
                setRound(0);
                setPlaying(!reduced);
                if (reduced) setRound(1);
              }}
              disabled={lastRound === 0}
              className="rounded-[var(--radius-md)] border border-[var(--color-accent)] px-3 py-1.5 text-[length:var(--text-label)] text-[var(--color-accent)] disabled:opacity-50"
            >
              {reduced ? "Step from round 1" : "Replay cascade"}
            </button>
            <button
              type="button"
              onClick={() => setRound((r) => Math.max(0, r - 1))}
              disabled={round === 0}
              aria-label="Previous round"
              className="rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-2.5 py-1.5 text-[length:var(--text-label)] disabled:opacity-50"
            >
              ‹
            </button>
            <span className="min-w-24 text-center text-[length:var(--text-label)] text-[var(--color-text-muted)]">
              {round === 0 ? "before shock" : `round ${round} of ${lastRound}`}
            </span>
            <button
              type="button"
              onClick={() => setRound((r) => Math.min(lastRound, r + 1))}
              disabled={round >= lastRound}
              aria-label="Next round"
              className="rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-2.5 py-1.5 text-[length:var(--text-label)] disabled:opacity-50"
            >
              ›
            </button>
          </div>
        </div>

        <input
          id="shock"
          type="range"
          min={0}
          max={ladder.steps.length - 1}
          step={1}
          value={index}
          onChange={(event) => setIndex(Number(event.target.value))}
          onPointerDown={startMeasuring}
          onPointerUp={stopMeasuring}
          onKeyDown={startMeasuring}
          onKeyUp={stopMeasuring}
          aria-valuetext={`${bps(rung.shockBps, 0)} decline, ${usdShort(rung.distressedDebtUsd)} of debt distressed`}
          className="mt-[var(--space-md)] w-full accent-[var(--color-accent)]"
        />
        <div className="flex justify-between text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
          <span>0%</span>
          <span>10%</span>
          <span>20%</span>
          <span>30%</span>
          <span>40%</span>
        </div>

        <p className="mt-[var(--space-sm)] text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
          {observedFps === null ? (
            <>Drag or arrow-key the slider — the frame rate of your own interaction is measured here.</>
          ) : (
            <>
              Last interaction: {observedFps.toFixed(0)} fps over {fps!.frames} frames, worst single
              frame {fps!.worstFrameMs.toFixed(1)} ms. Measured with{" "}
              <code className="font-mono">requestAnimationFrame</code> in this tab, not eyeballed.
            </>
          )}
        </p>
      </div>

      <StatGrid>
        <Stat
          label="Debt distressed"
          value={usdShort(rung.distressedDebtUsd)}
          exact={usdExact(rung.distressedDebtUsd)}
          of={`upper bound ${usdShort(rung.upperBound.distressedDebtUsd)} if every ambiguous E-Mode book sits at its boundary`}
          tone={rung.distressedDebtUsd > 1e9 ? "alert" : "watch"}
        />
        <Stat
          label={round === lastRound ? "Liquidated, all rounds" : `Liquidated by round ${round}`}
          value={usdShort(shownLiquidated)}
          exact={usdExact(shownLiquidated)}
          of={`of ${usdShort(ladder.totalDebtUsd)} borrowed in the sample`}
        />
        <Stat
          label="Amplification"
          value={`${rung.amplification.toFixed(3)}×`}
          of="rounds 2+ ÷ round 1: liquidations caused by liquidations"
        />
        <Stat
          label="Bad debt"
          value={usdShort(rung.badDebtUsd)}
          exact={usdExact(rung.badDebtUsd)}
          of={`${usdShort(rung.unliquidatableDebtUsd)} unliquidatable at DEX depth`}
          tone={rung.badDebtUsd > 0 ? "warn" : undefined}
        />
      </StatGrid>

      <div className="grid gap-[var(--space-lg)] lg:grid-cols-[1.15fr_1fr]">
        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-[var(--space-lg)]">
          <h2 className="text-[length:var(--text-heading)] font-semibold tracking-tight">
            Where it travels
          </h2>
          <p className="mb-[var(--space-md)] mt-1 text-[length:var(--text-label)] text-[var(--color-text-muted)]">
            Protocols and the collateral they share. No address appears here, or anywhere else on
            this page — that is the product.
          </p>
          <ContagionGraph
            graph={graph}
            liquidatedByProtocol={current?.byProtocol ?? {}}
            cumulativeByProtocol={cumulative}
            round={round}
          />
        </div>

        <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-[var(--space-lg)]">
          <h2 className="text-[length:var(--text-heading)] font-semibold tracking-tight">
            Round by round
          </h2>
          <p className="mb-[var(--space-md)] mt-1 text-[length:var(--text-label)] text-[var(--color-text-muted)]">
            Select a round to freeze the graph on it.
          </p>
          <CascadeTimeline rung={rung} activeRound={round} onSelectRound={setRound} />

          {rung.excludedContradictedBooks > 0 ? (
            <p className="mt-[var(--space-md)] text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
              {count(rung.excludedContradictedBooks)} books carrying{" "}
              {usdShort(rung.excludedContradictedDebtUsd)} are excluded: they compute as already
              insolvent at the snapshot, so the model declines to simulate them rather than
              inventing a liquidation.
            </p>
          ) : null}

          {reversal ? (
            <p className="mt-[var(--space-md)] flex items-start gap-2 text-[length:var(--text-micro)] text-[var(--color-text-muted)]">
              <Badge tone="watch">reversal</Badge>
              <span>
                Distress is {usdShort(reversal.fellByUsd)} <em>lower</em> here than at{" "}
                {bps(reversal.previousShockBps, 0)}. 72% of the sample&apos;s debt is
                WETH-denominated, so a book collateralized in something less ETH-correlated gets
                safer as ETH falls. Recorded, not smoothed.
              </span>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
