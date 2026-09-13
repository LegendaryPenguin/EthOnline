/**
 * The four layout primitives everything else is built from.
 *
 * Server components, no state, no `use client`: they exist so that a card in the dashboard
 * and a card in `/styleguide` cannot drift, and so that the token names appear in one file
 * instead of twenty.
 */

import type { ReactNode } from "react";

export function Card({
  title,
  note,
  children,
  as: Tag = "section",
}: {
  title?: string;
  /** One line under the title: what the panel is measuring, or its denominator. */
  note?: ReactNode;
  children: ReactNode;
  as?: "section" | "div" | "article";
}) {
  return (
    <Tag className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-[var(--space-lg)]">
      {title ? (
        <header className="mb-[var(--space-md)]">
          <h2 className="text-[length:var(--text-heading)] font-semibold tracking-tight">{title}</h2>
          {note ? (
            <p className="mt-1 text-[length:var(--text-label)] text-[var(--color-text-muted)]">{note}</p>
          ) : null}
        </header>
      ) : null}
      {children}
    </Tag>
  );
}

/**
 * A single figure with its denominator stated.
 *
 * `exact` is the unrounded value and lands in the `title` attribute — rule 8 of
 * `docs/DATAVIZ.md`: the abbreviated figure on screen must stay reconcilable with the JSON.
 * `of` is rule 9: a share with no denominator is not a number.
 */
export function Stat({
  label,
  value,
  exact,
  of,
  tone,
}: {
  label: string;
  value: string;
  exact?: string;
  of?: string;
  tone?: "calm" | "watch" | "warn" | "alert" | "accent";
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-[var(--space-md)] py-[var(--space-sm)]">
      <dt className="text-[length:var(--text-micro)] uppercase tracking-wide text-[var(--color-text-faint)]">
        {label}
      </dt>
      <dd
        className="mt-1 font-mono text-[length:var(--text-title)] leading-tight"
        style={tone ? { color: `var(--color-${tone})` } : undefined}
        title={exact}
      >
        {value}
      </dd>
      {of ? (
        <dd className="mt-1 text-[length:var(--text-micro)] text-[var(--color-text-muted)]">{of}</dd>
      ) : null}
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-2 gap-[var(--space-sm)] md:grid-cols-4">{children}</dl>
  );
}

/**
 * A small labelled marker. Carries a shape as well as a colour, because colour is never the
 * only channel (rule 5) — the ring makes the stance readable in greyscale and after video
 * compression.
 */
export function Badge({
  children,
  tone = "accent",
  title,
}: {
  children: ReactNode;
  tone?: "calm" | "watch" | "warn" | "alert" | "accent" | "text-muted";
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] border px-2 py-0.5 text-[length:var(--text-micro)] uppercase tracking-wide"
      style={{ color: `var(--color-${tone})`, borderColor: `var(--color-${tone})` }}
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: `var(--color-${tone})` }}
      />
      {children}
    </span>
  );
}
