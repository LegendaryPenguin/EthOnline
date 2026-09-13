/**
 * The three ways this page can fail to be a dashboard, each designed rather than defaulted.
 *
 * Rule 10 of `docs/DATAVIZ.md`: no spinner outlives its data. A fresh clone has no `data/`
 * directory and nothing is loading, so the empty state prints the commands that produce the
 * files. A report that fails signature verification renders the reason and no chart at all,
 * because showing an unverified signal would defeat the reason for signing it.
 */

import type { ReactNode } from "react";
import { Badge } from "./primitives";

/**
 * These pages are also rendered inside `/styleguide`, where a second `<main id="main">`
 * would be invalid and would break the skip link. `embedded` swaps the landmark for a plain
 * section and drops the id; nothing else about the page changes.
 */
function Shell({ embedded, children, busy }: { embedded?: boolean; children: ReactNode; busy?: boolean }) {
  const className =
    "mx-auto flex w-full max-w-3xl flex-1 flex-col gap-[var(--space-md)] px-[var(--space-lg)] py-[var(--space-xl)]";
  if (embedded) return <section className={className}>{children}</section>;
  return (
    <main id="main" className={className} aria-busy={busy ? "true" : undefined}>
      {children}
    </main>
  );
}

export function EmptyState({
  missing,
  commands,
  embedded,
}: {
  missing: string[];
  commands: string[];
  embedded?: boolean;
}) {
  return (
    <Shell embedded={embedded}>
      <Badge tone="watch">no snapshot yet</Badge>
      <h1 className="text-[length:var(--text-display)] font-semibold tracking-tight">
        Nothing is loading, and nothing will
      </h1>
      <p className="text-[var(--color-text-muted)]">
        Sentinel renders from a snapshot of live subgraph data, and this checkout does not have one
        yet. That is the expected state right after a clone — the files are gitignored because they
        are 29 MB of someone else&apos;s reading of the chain, and yours should be your own.
      </p>
      <div>
        <h2 className="text-[length:var(--text-heading)] font-semibold">Missing</h2>
        <ul className="mt-[var(--space-sm)] list-none p-0 font-mono text-[length:var(--text-label)] text-[var(--color-text-muted)]">
          {missing.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      </div>
      <div>
        <h2 className="text-[length:var(--text-heading)] font-semibold">Run, in order</h2>
        <ol className="mt-[var(--space-sm)] list-none p-0">
          {commands.map((command) => (
            <li
              key={command}
              className="mb-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-[var(--space-md)] py-[var(--space-sm)] font-mono text-[length:var(--text-label)]"
            >
              {command}
            </li>
          ))}
        </ol>
        <p className="mt-[var(--space-sm)] text-[length:var(--text-label)] text-[var(--color-text-faint)]">
          The first needs <code className="font-mono">GRAPH_API_KEY</code> in{" "}
          <code className="font-mono">.env.local</code>; see{" "}
          <code className="font-mono">.env.example</code>. The rest run entirely off disk.
        </p>
      </div>
    </Shell>
  );
}

export function ErrorState({ message, embedded }: { message: string; embedded?: boolean }) {
  return (
    <Shell embedded={embedded}>
      <Badge tone="alert">not shown</Badge>
      <h1 className="text-[length:var(--text-display)] font-semibold tracking-tight">
        This signal was not verified, so it is not displayed
      </h1>
      <p className="text-[var(--color-text-muted)]">
        Every figure on the dashboard is checked against the report&apos;s signatures before it is
        rendered, with the same rules the on-chain consumer applies. The check did not pass:
      </p>
      <pre className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-alert)] bg-[var(--color-surface)] p-[var(--space-md)] font-mono text-[length:var(--text-label)]">
        {message}
      </pre>
      <p className="text-[length:var(--text-label)] text-[var(--color-text-faint)]">
        Regenerate the recorded report with <code className="font-mono">npm run fixture:report</code>,
        or read <code className="font-mono">docs/SIGNAL.md</code> for the wire format and the
        rejection reasons.
      </p>
    </Shell>
  );
}

/**
 * Shown only while the server component streams: the data is on disk, so this is a
 * milliseconds-long state, and it says what is happening rather than spinning.
 */
export function LoadingState({ embedded }: { embedded?: boolean } = {}) {
  return (
    <Shell embedded={embedded} busy>
      <Badge tone="text-muted">verifying</Badge>
      <h1 className="text-[length:var(--text-display)] font-semibold tracking-tight">
        Checking the report&apos;s signatures
      </h1>
      <p className="text-[var(--color-text-muted)]">
        Recovering signers from the recorded report and assembling the cascade ladder. Nothing is
        drawn until the signatures check out.
      </p>
      <div className="flex flex-col gap-[var(--space-sm)]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-16 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]"
          />
        ))}
      </div>
    </Shell>
  );
}
