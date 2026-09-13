"use client";

import type { ContagionGraph as Graph } from "@/lib/ui/view-model";
import { protocolLabel, usdExact, usdShort } from "@/lib/ui/format";
import { rampIndex } from "@/lib/ui/tokens";

/**
 * The picture of the thesis: protocols, the collateral they share, and the borrower overlap
 * between them — and no addresses, because a per-address graph is the hunting map this
 * project exists to avoid publishing (rule 1 of `docs/DATAVIZ.md`).
 *
 * Positions come from the server (`lib/ui/view-model.ts:layout`), so two loads are
 * pixel-identical and the only motion is the cascade advancing. Protocols are circles,
 * assets are squares: shape carries the kind so hue does not have to.
 */
export function ContagionGraph({
  graph,
  /** USD liquidated at each protocol in the round being shown. Empty before the shock. */
  liquidatedByProtocol,
  /** Cumulative USD liquidated at each protocol up to and including this round. */
  cumulativeByProtocol,
  round,
}: {
  graph: Graph;
  liquidatedByProtocol: Record<string, number>;
  cumulativeByProtocol: Record<string, number>;
  round: number;
}) {
  const maxDebt = Math.max(1, ...graph.nodes.filter((n) => n.kind === "protocol").map((n) => n.valueUsd));
  const maxAsset = Math.max(1, ...graph.nodes.filter((n) => n.kind === "asset").map((n) => n.valueUsd));
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const hitThisRound = Math.max(0, ...Object.values(liquidatedByProtocol));
  // Fill is liquidation volume *relative to the worst protocol so far*, not relative to the
  // protocol's own book: at a 30% shock the largest cascade still clears well under 1% of
  // total debt, so an absolute scale would leave every node on step 0 and the picture would
  // say nothing. Relative severity is the comparison the viewer is actually making.
  const worstCumulative = Math.max(0, ...Object.values(cumulativeByProtocol));

  // A 0–100 canvas: node radii and stroke widths below are in the same units as the
  // layout's unit square scaled by 100, so nothing needs a pixel measurement.
  const S = 100;

  return (
    <figure className="m-0">
      <svg
        viewBox={`-8 -8 ${S + 16} ${S + 16}`}
        className="w-full"
        role="img"
        aria-label={
          round === 0
            ? "Contagion graph: protocols and the collateral assets they share, before any shock."
            : `Contagion graph at round ${round}. ` +
              Object.entries(liquidatedByProtocol)
                .filter(([, v]) => v > 0)
                .map(([p, v]) => `${protocolLabel(p)} liquidated ${usdShort(v)}`)
                .join("; ") || `Round ${round}: no liquidations.`
        }
      >
        <g>
          {graph.edges.map((edge, i) => {
            const a = byId.get(edge.source);
            const b = byId.get(edge.target);
            if (!a || !b) return null;
            const overlap = edge.kind === "overlap";
            return (
              <line
                key={`${edge.source}-${edge.target}-${i}`}
                x1={a.x * S}
                y1={a.y * S}
                x2={b.x * S}
                y2={b.y * S}
                stroke={overlap ? "var(--color-accent)" : "var(--color-border-strong)"}
                strokeWidth={0.25 + edge.weight * (overlap ? 1.6 : 1.0)}
                strokeDasharray={overlap ? undefined : "2 1.5"}
                strokeOpacity={overlap ? 0.75 : 0.55}
              />
            );
          })}
        </g>

        <g>
          {graph.nodes.map((node) => {
            if (node.kind === "asset") {
              const size = 2.2 + 2.6 * Math.sqrt(node.valueUsd / maxAsset);
              return (
                <g key={node.id}>
                  <rect
                    x={node.x * S - size / 2}
                    y={node.y * S - size / 2}
                    width={size}
                    height={size}
                    fill="var(--color-surface-raised)"
                    stroke="var(--color-border-strong)"
                    strokeWidth={0.4}
                  >
                    <title>{`${node.label}: ${usdExact(node.valueUsd)} posted as collateral across protocols`}</title>
                  </rect>
                  <text
                    x={node.x * S}
                    y={node.y * S - size / 2 - 1.4}
                    textAnchor="middle"
                    fontSize={2.7}
                    fill="var(--color-text-muted)"
                  >
                    {node.label}
                  </text>
                </g>
              );
            }

            const radius = 3 + 4.5 * Math.sqrt(node.valueUsd / maxDebt);
            const hit = liquidatedByProtocol[node.id] ?? 0;
            const cumulative = cumulativeByProtocol[node.id] ?? 0;
            // The halo is this round's liquidation volume relative to the worst protocol in
            // the same round, so a round where one protocol dominates reads as exactly that.
            const halo = hit > 0 && hitThisRound > 0 ? radius + 1.5 + 4 * (hit / hitThisRound) : 0;
            return (
              <g key={node.id}>
                {halo > 0 ? (
                  <circle
                    cx={node.x * S}
                    cy={node.y * S}
                    r={halo}
                    fill="var(--color-alert)"
                    fillOpacity={0.22}
                    stroke="var(--color-alert)"
                    strokeWidth={0.4}
                    style={{ transition: "r var(--duration-cascade) ease-out" }}
                  />
                ) : null}
                <circle
                  cx={node.x * S}
                  cy={node.y * S}
                  r={radius}
                  fill={
                    cumulative > 0 && worstCumulative > 0
                      ? `var(--color-ramp-${Math.max(1, rampIndex(cumulative / worstCumulative))})`
                      : "var(--color-surface-raised)"
                  }
                  stroke={hit > 0 ? "var(--color-alert)" : "var(--color-border-strong)"}
                  strokeWidth={hit > 0 ? 0.9 : 0.5}
                  style={{ transition: "fill var(--duration-quick) linear" }}
                >
                  <title>
                    {`${protocolLabel(node.id)}: ${usdExact(node.valueUsd)} borrowed in the sample` +
                      (cumulative > 0 ? `, ${usdExact(cumulative)} liquidated by round ${round}` : "")}
                  </title>
                </circle>
                <text
                  x={node.x * S}
                  y={node.y * S + Math.max(radius, halo) + 3.2}
                  textAnchor="middle"
                  fontSize={3}
                  fill="var(--color-text)"
                >
                  {protocolLabel(node.id)}
                </text>
                {hit > 0 ? (
                  <text
                    x={node.x * S}
                    y={node.y * S + Math.max(radius, halo) + 6.4}
                    textAnchor="middle"
                    fontSize={2.7}
                    fill="var(--color-alert)"
                  >
                    {usdShort(hit)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>

      <figcaption className="mt-[var(--space-sm)] flex flex-wrap gap-x-[var(--space-md)] gap-y-1 text-[length:var(--text-micro)] text-[var(--color-text-muted)]">
        <span>● protocol, area ∝ debt in the sample</span>
        <span>■ collateral asset posted at more than one protocol</span>
        <span style={{ color: "var(--color-accent)" }}>— shared borrowers</span>
        <span>-- asset is collateral here</span>
        <span style={{ color: "var(--color-alert)" }}>halo = liquidated this round</span>
        <span>fill = liquidated so far, relative to the worst protocol</span>
      </figcaption>
    </figure>
  );
}
