/**
 * Formatting, in one place, because a number formatted two ways is two numbers.
 *
 * Every figure the interface shows comes from a recorded run — a signed report or a
 * simulation over a live snapshot — so the rule from `.claude/skills/sentinel/SKILL.md`
 * applies here too: display may round, but it must never *change* magnitude, and the
 * exact figure has to stay reachable. Anything abbreviated carries its full value in a
 * `title`, which is why these helpers come in pairs.
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Full precision to the dollar: `$5,720,859,090`. */
export function usdExact(n: number): string {
  return USD.format(Math.round(n));
}

/** Abbreviated for a chart axis or a stat tile: `$5.72B`. Always paired with `usdExact` in a tooltip. */
export function usdShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  // A liquidation of forty cents is not "$0": rounding a non-zero figure to zero is the one
  // rounding this file is not allowed to do, because zero is a claim the model is not making.
  if (abs > 0 && abs < 1) return `${sign}<$1`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** A fraction as a percentage: `0.6266` → `62.66%`. */
export function pct(fraction: number, digits = 2): string {
  return `${(100 * fraction).toFixed(digits)}%`;
}

/** Basis points as a percentage: `2201` → `22.01%`. The signal's own unit. */
export function bps(value: number, digits = 2): string {
  return `${(value / 100).toFixed(digits)}%`;
}

export function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** A block height, grouped: `25,964,481`. */
export function block(n: number | bigint): string {
  return Number(n).toLocaleString("en-US");
}

/**
 * How long ago, in words. Deliberately coarse: a snapshot's age matters at the scale of
 * minutes and hours, and a ticking seconds counter would imply the data is live.
 */
export function age(fromIso: string, now = Date.now()): string {
  const ms = now - new Date(fromIso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

/** `aave-v3-eth` → `Aave V3`. The deployment key stays available for provenance. */
export function protocolLabel(key: string): string {
  const base = key.replace(/-eth$/, "");
  return base
    .split("-")
    .map((part) => (/^v\d+$/i.test(part) ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(" ");
}
