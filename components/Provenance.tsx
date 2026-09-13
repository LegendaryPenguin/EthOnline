import type { Provenance as ProvenanceData } from "@/lib/ui/view-model";
import { AGING_HOURS, FRESH_HOURS } from "@/lib/ui/view-model";
import { age, block, pct, protocolLabel } from "@/lib/ui/format";
import { Badge } from "./primitives";

const WORDING: Record<ProvenanceData["freshness"], { tone: "calm" | "watch" | "alert"; text: string }> = {
  fresh: { tone: "calm", text: `read less than ${FRESH_HOURS} h ago` },
  aging: { tone: "watch", text: `read within the last ${AGING_HOURS} h` },
  stale: { tone: "alert", text: "a recording, not a current reading" },
};

/**
 * How old the data is, in the same eyeline as the data.
 *
 * Rule 3 of `docs/DATAVIZ.md`. The stale state changes the sentence rather than adding a
 * grey footnote, because a dashboard that looks live when it is a day old is lying with
 * layout — and this one will be looked at long after the snapshot was taken.
 */
export function ProvenanceBar({ provenance, now }: { provenance: ProvenanceData; now: number }) {
  const wording = WORDING[provenance.freshness];
  return (
    <div className="flex flex-wrap items-center gap-x-[var(--space-md)] gap-y-[var(--space-sm)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-[var(--space-md)] py-[var(--space-sm)] text-[length:var(--text-label)]">
      <Badge tone={wording.tone} title={provenance.capturedAt}>
        {wording.text}
      </Badge>
      <span className="text-[var(--color-text-muted)]">
        Snapshot {age(provenance.capturedAt, now)}, at block{" "}
        <span className="font-mono text-[var(--color-text)]">{block(provenance.asOfBlock)}</span> or
        later on every deployment.
      </span>
      <span className="text-[var(--color-text-muted)]">
        Sample covers{" "}
        <span className="font-mono text-[var(--color-text)]">{pct(provenance.sampleCoverage)}</span>{" "}
        of protocol-reported debt;{" "}
        <span className="font-mono text-[var(--color-text)]">{pct(provenance.assetCoverage)}</span>{" "}
        of cross-protocol collateral value is modelled.
      </span>
      <details className="ml-auto text-[var(--color-text-muted)]">
        <summary className="cursor-pointer">per-deployment blocks</summary>
        <dl className="mt-[var(--space-sm)] grid grid-cols-[auto_auto] gap-x-[var(--space-md)] text-[length:var(--text-micro)]">
          {Object.entries(provenance.blocks)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => (
              <div key={key} className="contents">
                <dt>{protocolLabel(key)}</dt>
                <dd className="font-mono text-[var(--color-text)]">{block(value)}</dd>
              </div>
            ))}
        </dl>
      </details>
    </div>
  );
}
