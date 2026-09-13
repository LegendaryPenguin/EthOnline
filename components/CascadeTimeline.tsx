"use client";

import type { ShockRung } from "@/lib/ui/ladder";
import { count, protocolLabel, usdExact, usdShort } from "@/lib/ui/format";

/**
 * One row per cascade round: how much debt was liquidated, and at which protocol.
 *
 * Round 1 is the direct consequence of the shock; rounds 2+ are liquidations caused by
 * liquidations, which is the only thing in this project that deserves the word *systemic*.
 * The split is stated on the axis rather than left to a legend, and rounds past the
 * twentieth arrive pre-summarised from `lib/ui/ladder.ts` instead of as a hundred one-pixel
 * bars.
 */
export function CascadeTimeline({
  rung,
  activeRound,
  onSelectRound,
}: {
  rung: ShockRung;
  activeRound: number;
  onSelectRound: (round: number) => void;
}) {
  const max = Math.max(1, ...rung.rounds.map((r) => r.liquidatedDebtUsd));

  if (rung.rounds.length === 0) {
    return (
      <p className="text-[length:var(--text-label)] text-[var(--color-text-muted)]">
        No position in the sample is liquidatable at this shock, so there are no rounds to show.
        The cascade begins at the first level where a health factor crosses 1.
      </p>
    );
  }

  return (
    <div>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {rung.rounds.map((r) => {
          const active = r.round === activeRound;
          const worst = Object.entries(r.byProtocol).sort((a, b) => b[1] - a[1])[0];
          return (
            <li key={r.round}>
              <button
                type="button"
                onClick={() => onSelectRound(r.round)}
                aria-current={active ? "step" : undefined}
                className="flex w-full items-center gap-[var(--space-sm)] rounded-[var(--radius-sm)] px-1 py-0.5 text-left"
                style={{ background: active ? "var(--color-surface-raised)" : "transparent" }}
              >
                <span className="w-16 shrink-0 text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
                  {r.round === 1 ? "shock" : `round ${r.round}`}
                </span>
                <span className="relative h-3.5 flex-1 overflow-hidden rounded-[var(--radius-sm)] bg-[var(--color-surface-raised)]">
                  <span
                    className="absolute inset-y-0 left-0"
                    style={{
                      width: `${Math.max(1.5, (100 * r.liquidatedDebtUsd) / max)}%`,
                      background: r.round === 1 ? "var(--color-ramp-2)" : "var(--color-ramp-4)",
                      transition: "width var(--duration-quick) ease-out",
                    }}
                  />
                </span>
                <span
                  className="w-20 shrink-0 text-right font-mono text-[length:var(--text-micro)]"
                  title={usdExact(r.liquidatedDebtUsd)}
                >
                  {usdShort(r.liquidatedDebtUsd)}
                </span>
                <span className="w-40 shrink-0 text-[length:var(--text-micro)] text-[var(--color-text-muted)]">
                  {count(r.accountsLiquidated)} {r.accountsLiquidated === 1 ? "book" : "books"}
                  {worst ? ` · mostly ${protocolLabel(worst[0])}` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {rung.tail ? (
        <p className="mt-[var(--space-sm)] text-[length:var(--text-micro)] text-[var(--color-text-muted)]">
          {count(rung.tail.rounds)} further rounds cleared{" "}
          <span title={usdExact(rung.tail.liquidatedDebtUsd)}>{usdShort(rung.tail.liquidatedDebtUsd)}</span>{" "}
          between them — summarised rather than drawn, because each is a fraction of a pixel.
        </p>
      ) : null}

      <p className="mt-[var(--space-sm)] text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
        Round 1 is the shock itself ({usdShort(rung.idiosyncraticDebtUsd)}). Rounds 2 and after are
        liquidations caused by liquidations ({usdShort(rung.systemicDebtUsd)}), an amplification of{" "}
        {rung.amplification.toFixed(3)}×.{" "}
        {rung.converged
          ? `Converged after ${count(rung.roundsToConvergence)} rounds.`
          : "Did not converge inside the round limit."}
      </p>
    </div>
  );
}
