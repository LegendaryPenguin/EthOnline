import { rampIndex } from "@/lib/ui/tokens";
import { pct, protocolLabel } from "@/lib/ui/format";

/**
 * A protocol × protocol matrix, drawn as a table because it *is* a table — a canvas here
 * would cost keyboard access and screen-reader access to buy nothing.
 *
 * Every cell prints its value as well as its colour (rule 5 of `docs/DATAVIZ.md`), and the
 * ink for each ramp step is resolved in `lib/ui/tokens.ts` so a cell label is never a low
 * contrast accident in one theme.
 */
export function CouplingHeatmap({
  protocols,
  matrix,
  caption,
  /** Stated because the two matrices in this project mean different things in each direction. */
  rowMeaning,
  symmetric,
}: {
  protocols: string[];
  matrix: Record<string, Record<string, number>>;
  caption: string;
  rowMeaning: string;
  symmetric: boolean;
}) {
  const max = Math.max(
    0.0001,
    ...protocols.flatMap((a) => protocols.filter((b) => b !== a).map((b) => matrix[a]?.[b] ?? 0)),
  );

  return (
    <figure className="m-0 overflow-x-auto">
      <table className="w-full border-collapse text-[length:var(--text-micro)]">
        <caption className="mb-[var(--space-sm)] text-left text-[length:var(--text-label)] text-[var(--color-text-muted)]">
          {caption} {symmetric ? "Symmetric." : rowMeaning}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="p-1 text-left font-normal text-[var(--color-text-faint)]">
              {symmetric ? "pair" : "row → column"}
            </th>
            {protocols.map((p) => (
              <th
                key={p}
                scope="col"
                className="p-1 text-left font-normal text-[var(--color-text-muted)]"
              >
                {protocolLabel(p)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {protocols.map((row) => (
            <tr key={row}>
              <th
                scope="row"
                className="whitespace-nowrap p-1 text-left font-normal text-[var(--color-text-muted)]"
              >
                {protocolLabel(row)}
              </th>
              {protocols.map((column) => {
                if (row === column) {
                  return (
                    <td
                      key={column}
                      className="p-1 text-center text-[var(--color-text-faint)]"
                      aria-label="self"
                    >
                      —
                    </td>
                  );
                }
                const value = matrix[row]?.[column] ?? 0;
                const step = rampIndex(value / max);
                return (
                  <td key={column} className="p-0.5">
                    <span
                      className="block rounded-[var(--radius-sm)] px-1.5 py-1 text-right font-mono"
                      style={{
                        background: `var(--color-ramp-${step})`,
                        color: `var(--color-ramp-${step}-ink)`,
                      }}
                      title={`${protocolLabel(row)} → ${protocolLabel(column)}: ${pct(value, 4)}`}
                    >
                      {pct(value, 2)}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <figcaption className="mt-[var(--space-sm)] flex items-center gap-2 text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
        <span>low</span>
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            aria-hidden
            className="inline-block h-3 w-6 rounded-[var(--radius-sm)]"
            style={{ background: `var(--color-ramp-${i})` }}
          />
        ))}
        <span>high (relative to the largest off-diagonal cell, {pct(max, 2)})</span>
      </figcaption>
    </figure>
  );
}
