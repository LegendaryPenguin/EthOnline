import {
  COLORS,
  CONTRAST_PAIRS,
  MOTION,
  RADIUS,
  RAMP,
  SPACE,
  TYPE,
  contrastRatio,
  rampIndex,
} from "@/lib/ui/tokens";
import { Badge, Card, Stat, StatGrid } from "@/components/primitives";
import { CouplingHeatmap } from "@/components/CouplingHeatmap";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { ProvenanceBar } from "@/components/Provenance";
import { age, bps, block, count, pct, protocolLabel, usdExact, usdShort } from "@/lib/ui/format";

/**
 * Every token and every component, on one page, with the measured contrast next to each pair.
 *
 * It is generated from `lib/ui/tokens.ts` rather than written by hand, so it cannot describe
 * a colour the interface no longer uses — the same reason `app/tokens.css` is generated. The
 * ratios below are computed at render time by the same function the test asserts with.
 */
export const metadata = { title: "Sentinel — styleguide" };

const NOW = Date.parse("2026-09-12T12:00:00.000Z");

const DEMO_PROVENANCE = {
  blocks: { "aave-v3-eth": 25_964_481, "compound-v3-eth": 25_964_402 },
  asOfBlock: 25_964_402,
  capturedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
  ageHours: 3,
  freshness: "aging" as const,
  sampleCoverage: 0.1397,
  assetCoverage: 0.9412,
};

const DEMO_MATRIX = {
  "aave-v3-eth": { "compound-v3-eth": 0.184, "spark-eth": 0.061 },
  "compound-v3-eth": { "aave-v3-eth": 0.184, "spark-eth": 0.012 },
  "spark-eth": { "aave-v3-eth": 0.061, "compound-v3-eth": 0.012 },
};

export default function Styleguide() {
  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-[var(--space-xl)] px-[var(--space-lg)] py-[var(--space-xl)]"
    >
      <header>
        <h1 className="text-[length:var(--text-display)] font-semibold tracking-tight">Styleguide</h1>
        <p className="mt-[var(--space-sm)] max-w-3xl text-[var(--color-text-muted)]">
          Generated from <code className="font-mono">lib/ui/tokens.ts</code>. Switch the theme in the
          header and every ratio below is recomputed for that theme — the numbers are produced by{" "}
          <code className="font-mono">contrastRatio</code>, the same function{" "}
          <code className="font-mono">lib/ui/__tests__/contrast.test.ts</code> asserts with, so this
          page cannot claim a ratio the test does not enforce. The rules the charts follow are in{" "}
          <code className="font-mono">docs/DATAVIZ.md</code>.
        </p>
      </header>

      <Card title="Semantic colours" note="Every colour in the interface comes from this list.">
        <div className="grid grid-cols-2 gap-[var(--space-sm)] sm:grid-cols-4">
          {(Object.keys(COLORS.dark) as (keyof typeof COLORS.dark)[]).map((role) => (
            <div key={role} className="rounded-[var(--radius-md)] border border-[var(--color-border)]">
              <div
                className="h-12 rounded-t-[var(--radius-md)]"
                style={{ background: `var(--color-${role})` }}
              />
              <div className="p-2">
                <code className="block font-mono text-[length:var(--text-micro)]">{role}</code>
                <span className="block text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
                  {COLORS.light[role]} / {COLORS.dark[role]}
                </span>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-[var(--space-sm)] text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
          Light value / dark value. The swatch shows whichever theme is active.
        </p>
      </Card>

      <Card
        title="Measured pairs"
        note="The 17 foreground/background combinations the interface renders, in both themes, on every test run."
      >
        <table className="w-full border-collapse text-[length:var(--text-label)]">
          <thead>
            <tr className="text-[var(--color-text-faint)]">
              <th scope="col" className="py-1 text-left font-normal">
                pair
              </th>
              <th scope="col" className="py-1 text-left font-normal">
                where
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                needs
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                light
              </th>
              <th scope="col" className="py-1 text-right font-normal">
                dark
              </th>
            </tr>
          </thead>
          <tbody>
            {CONTRAST_PAIRS.map((pair) => {
              const light = contrastRatio(COLORS.light[pair.fg], COLORS.light[pair.bg]);
              const dark = contrastRatio(COLORS.dark[pair.fg], COLORS.dark[pair.bg]);
              return (
                <tr key={`${pair.fg}-${pair.bg}`} className="border-t border-[var(--color-border)]">
                  <th scope="row" className="py-1 text-left font-normal">
                    <code className="font-mono text-[length:var(--text-micro)]">
                      {pair.fg} on {pair.bg}
                    </code>
                  </th>
                  <td className="py-1 text-[var(--color-text-muted)]">{pair.where}</td>
                  <td className="py-1 text-right font-mono">{pair.min.toFixed(1)}</td>
                  <td className="py-1 text-right font-mono">{light.toFixed(2)}</td>
                  <td className="py-1 text-right font-mono">{dark.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card
        title="The risk ramp"
        note="Five sequential steps, strictly ordered in luminance, ≥1.35:1 apart, each with an ink at ≥4.5:1."
      >
        <div className="grid grid-cols-5 gap-[var(--space-sm)]">
          {RAMP.dark.map((_, i) => (
            <div
              key={i}
              className="rounded-[var(--radius-md)] p-[var(--space-md)] text-center font-mono text-[length:var(--text-label)]"
              style={{ background: `var(--color-ramp-${i})`, color: `var(--color-ramp-${i}-ink)` }}
            >
              step {i}
            </div>
          ))}
        </div>
        <p className="mt-[var(--space-sm)] text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
          A 0–1 quantity is binned by <code className="font-mono">rampIndex</code>: 0.05 →{" "}
          {rampIndex(0.05)}, 0.4 → {rampIndex(0.4)}, 0.99 → {rampIndex(0.99)}. Binned rather than
          interpolated so every cell&apos;s contrast is a value that can be checked.
        </p>
      </Card>

      <Card title="Type, space, radius, motion">
        <div className="flex flex-col gap-[var(--space-sm)]">
          {(Object.entries(TYPE) as [keyof typeof TYPE, string][]).map(([name, size]) => (
            <div key={name} className="flex items-baseline gap-[var(--space-md)]">
              <code className="w-20 shrink-0 font-mono text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
                {name}
              </code>
              <span style={{ fontSize: `var(--text-${name})` }}>
                Systemic risk is a shared position, not a shared opinion
              </span>
              <span className="ml-auto font-mono text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
                {size}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-[var(--space-lg)] grid gap-[var(--space-lg)] sm:grid-cols-3">
          <div>
            <h3 className="text-[length:var(--text-label)] font-semibold">Space</h3>
            {Object.entries(SPACE).map(([name, value]) => (
              <div key={name} className="mt-1 flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-3 bg-[var(--color-accent)]"
                  style={{ width: `var(--space-${name})` }}
                />
                <code className="font-mono text-[length:var(--text-micro)]">
                  {name} {value}
                </code>
              </div>
            ))}
          </div>
          <div>
            <h3 className="text-[length:var(--text-label)] font-semibold">Radius</h3>
            {Object.entries(RADIUS).map(([name, value]) => (
              <div key={name} className="mt-1 flex items-center gap-2">
                <span
                  aria-hidden
                  className="inline-block h-6 w-10 border border-[var(--color-border-strong)]"
                  style={{ borderRadius: `var(--radius-${name})` }}
                />
                <code className="font-mono text-[length:var(--text-micro)]">
                  {name} {value}
                </code>
              </div>
            ))}
          </div>
          <div>
            <h3 className="text-[length:var(--text-label)] font-semibold">Motion</h3>
            {Object.entries(MOTION).map(([name, value]) => (
              <p key={name} className="mt-1 font-mono text-[length:var(--text-micro)]">
                {name} {value}ms
              </p>
            ))}
            <p className="mt-[var(--space-sm)] text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
              All three collapse under <code className="font-mono">prefers-reduced-motion</code>, and
              the cascade animation becomes a round stepper.
            </p>
          </div>
        </div>
      </Card>

      <Card title="Stances and badges" note="Colour is never the only channel: each has a label and a ring.">
        <div className="flex flex-wrap gap-[var(--space-sm)]">
          <Badge tone="calm">normal</Badge>
          <Badge tone="watch">watch</Badge>
          <Badge tone="warn">warn</Badge>
          <Badge tone="alert">alert</Badge>
          <Badge tone="accent">signature verified</Badge>
          <Badge tone="text-muted">verifying</Badge>
        </div>
      </Card>

      <Card title="Stat tiles" note="Rule 8 and rule 9: the exact figure is in the title attribute, and every share names its denominator.">
        <StatGrid>
          <Stat
            label="Multi-protocol debt"
            value={usdShort(35_923_754)}
            exact={usdExact(35_923_754)}
            of="1.25% of evaluable debt ($2.87B)"
          />
          <Stat label="Systemic risk score" value={bps(2201)} of="composite, bps of 100; only its change is comparable" tone="accent" />
          <Stat label="Amplification" value="1.106×" of="rounds 2+ ÷ round 1" tone="watch" />
          <Stat label="Bad debt" value={usdShort(0)} of="$0 unliquidatable at DEX depth" />
        </StatGrid>
      </Card>

      <Card title="Formatting" note="lib/ui/format.ts — the only place a number becomes a string.">
        <dl className="grid grid-cols-1 gap-x-[var(--space-lg)] text-[length:var(--text-label)] sm:grid-cols-2">
          {[
            ["usdExact(5720859090)", usdExact(5_720_859_090)],
            ["usdShort(5720859090)", usdShort(5_720_859_090)],
            ["pct(0.6266)", pct(0.6266)],
            ["bps(2201)", bps(2201)],
            ["count(5613)", count(5613)],
            ["block(25964481)", block(25_964_481)],
            ["age(3h ago)", age(DEMO_PROVENANCE.capturedAt, NOW)],
            ["protocolLabel('aave-v3-eth')", protocolLabel("aave-v3-eth")],
          ].map(([call, result]) => (
            <div key={call} className="flex justify-between gap-[var(--space-md)] border-t border-[var(--color-border)] py-1">
              <dt>
                <code className="font-mono text-[length:var(--text-micro)]">{call}</code>
              </dt>
              <dd className="font-mono">{result}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="Provenance bar" note="The aging state, at three hours old.">
        <ProvenanceBar provenance={DEMO_PROVENANCE} now={NOW} />
      </Card>

      <Card title="Coupling heatmap" note="Illustrative values, so the ramp can be seen at every step.">
        <CouplingHeatmap
          protocols={["aave-v3-eth", "compound-v3-eth", "spark-eth"]}
          matrix={DEMO_MATRIX}
          caption="Debt-weighted overlap of borrower sets."
          rowMeaning=""
          symmetric
        />
      </Card>

      <section>
        <h2 className="text-[length:var(--text-title)] font-semibold tracking-tight">
          The states that are not a dashboard
        </h2>
        <p className="mt-1 text-[var(--color-text-muted)]">
          Rendered here at reduced scale. Each is a designed page, not a fallback.
        </p>
        <div className="mt-[var(--space-md)] flex flex-col gap-[var(--space-lg)]">
          {[
            <EmptyState
              key="empty"
              missing={["data/completed.json", "data/cascade.json", "data/shock-ladder.json"]}
              commands={["npm run snapshot", "npm run cascade", "npm run shock:ladder", "npm run fixture:report"]}
              embedded
            />,
            <ErrorState
              key="error"
              message="the recorded signal did not verify — report rejected: recovered signer 0x1f2… is not in the accepted signer set"
              embedded
            />,
            <LoadingState key="loading" embedded />,
          ].map((state, i) => (
            <div
              key={i}
              className="overflow-hidden rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)]"
            >
              {state}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
