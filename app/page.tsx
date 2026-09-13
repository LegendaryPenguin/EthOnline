import { loadDashboard } from "@/lib/ui/view-model";
import { ProvenanceBar } from "@/components/Provenance";
import { SignalCard } from "@/components/SignalCard";
import { ShockExplorer } from "@/components/ShockExplorer";
import { CouplingHeatmap } from "@/components/CouplingHeatmap";
import { Card } from "@/components/primitives";
import { EmptyState, ErrorState } from "@/components/states";
import { bps, count, pct, protocolLabel, usdExact, usdShort } from "@/lib/ui/format";

/**
 * Rendered per request, deliberately.
 *
 * The page states how old its data is, and a prerendered "read 4 minutes ago" would be a
 * false claim within the hour. Reading the snapshot costs milliseconds because it is already
 * on disk.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const now = Date.now();
  const state = await loadDashboard(now);

  if (state.status === "empty") return <EmptyState missing={state.missing} commands={state.commands} />;
  if (state.status === "error") return <ErrorState message={state.message} />;

  const { data } = state;
  const figures = data.report.figures;

  return (
    <main
      id="main"
      className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-[var(--space-lg)] px-[var(--space-lg)] py-[var(--space-xl)]"
    >
      <section>
        <h1 className="max-w-4xl text-[length:var(--text-display)] font-semibold leading-tight tracking-tight">
          <span className="font-mono text-[var(--color-alert)]" title={usdExact(figures.multiProtocolDebtUsd)}>
            {usdShort(figures.multiProtocolDebtUsd)}
          </span>{" "}
          of borrowed value is levered across more than one lending protocol on the same collateral
        </h1>
        <p className="mt-[var(--space-md)] max-w-3xl text-[var(--color-text-muted)]">
          {bps(figures.multiProtocolShareBps)} of the{" "}
          <span className="font-mono text-[var(--color-text)]" title={usdExact(figures.evaluableDebtUsd)}>
            {usdShort(figures.evaluableDebtUsd)}
          </span>{" "}
          of debt this reading could evaluate, across {count(figures.borrowersObserved)} borrowers —
          and {bps(figures.leveredShareBps)} of it sits on books past the policy&apos;s leverage watch
          level, a threshold that stays confidential because publishing it would tell a borrower
          exactly how far to hide. These liquidations are not independent events. Naming the addresses
          would publish a hunting map for liquidation bots and a deanonymization aid for everyone
          else, so the counting happens inside a TEE and only the aggregate leaves it — signed, and
          verified again before anything on this page was drawn.
        </p>
      </section>

      <ProvenanceBar provenance={data.provenance} now={now} />

      <SignalCard report={data.report} />

      <section className="flex flex-col gap-[var(--space-md)]">
        <div>
          <h2 className="text-[length:var(--text-title)] font-semibold tracking-tight">
            What a shock does to it
          </h2>
          <p className="mt-1 max-w-3xl text-[var(--color-text-muted)]">
            A simultaneous decline in ETH and BTC, propagated through every position in the snapshot:
            liquidate what is underwater, sell the seized collateral into the depth the DEXs actually
            have, re-price, repeat. The rounds after the first are the part that only exists because
            the borrowers overlap.
          </p>
          <p className="mt-[var(--space-sm)] max-w-3xl text-[length:var(--text-label)] text-[var(--color-text-faint)]">
            A different sample from the signed report above, and worth being clear about: this runs
            over the completed cross-protocol snapshot —{" "}
            <span className="font-mono" title={usdExact(data.ladder.totalDebtUsd)}>
              {usdShort(data.ladder.totalDebtUsd)}
            </span>{" "}
            of borrowed value, {pct(data.provenance.sampleCoverage)} of protocol-reported debt, with{" "}
            {pct(data.provenance.assetCoverage)} of its cross-protocol collateral value modelled. The
            report is the enclave&apos;s own reading; this is the model the report&apos;s shock figure
            comes from.
          </p>
        </div>
        <ShockExplorer ladder={data.ladder} graph={data.graph} initialShockBps={figures.worstShockBps} />
      </section>

      <section className="grid gap-[var(--space-lg)] lg:grid-cols-2">
        <Card title="Borrower overlap">
          <CouplingHeatmap
            protocols={data.coupling.protocols}
            matrix={data.coupling.borrowerOverlap}
            caption="Debt-weighted overlap of borrower sets between each pair of protocols."
            rowMeaning=""
            symmetric
          />
        </Card>
        <Card title="Collateral exposure">
          <CouplingHeatmap
            protocols={data.coupling.protocols}
            matrix={data.coupling.collateralExposure}
            caption="Share of the row protocol's collateral value that the column protocol also lends against."
            rowMeaning="Asymmetric: a small protocol can be wholly exposed to a large one without the reverse."
            symmetric={false}
          />
        </Card>
      </section>

      <section className="grid gap-[var(--space-lg)] lg:grid-cols-2">
        <Card
          title="The collateral they share"
          note="An asset posted at more than one protocol is how a liquidation at one becomes a price move at the other."
        >
          <table className="w-full border-collapse text-[length:var(--text-label)]">
            <thead>
              <tr className="text-[var(--color-text-faint)]">
                <th scope="col" className="py-1 text-left font-normal">
                  asset
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  collateral value
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  protocols
                </th>
              </tr>
            </thead>
            <tbody>
              {data.coupling.sharedAssets
                .filter((asset) => asset.protocols.length > 1)
                .slice(0, 10)
                .map((asset) => (
                  <tr key={asset.symbol} className="border-t border-[var(--color-border)]">
                    <th scope="row" className="py-1 text-left font-normal">
                      {asset.symbol}
                    </th>
                    <td className="py-1 text-right font-mono" title={usdExact(asset.assetUsd)}>
                      {usdShort(asset.assetUsd)}
                    </td>
                    <td className="py-1 text-right text-[var(--color-text-muted)]">
                      {asset.protocols.map(protocolLabel).join(", ")}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </Card>

        <Card
          title="Shared borrowers, by pair"
          note={`Counts from the completed sample, which covers ${pct(data.provenance.sampleCoverage)} of protocol-reported debt.`}
        >
          <table className="w-full border-collapse text-[length:var(--text-label)]">
            <thead>
              <tr className="text-[var(--color-text-faint)]">
                <th scope="col" className="py-1 text-left font-normal">
                  pair
                </th>
                <th scope="col" className="py-1 text-right font-normal">
                  borrowers in both
                </th>
              </tr>
            </thead>
            <tbody>
              {data.coupling.pairBorrowers.slice(0, 10).map(({ pair, borrowers }) => (
                <tr key={pair.join("|")} className="border-t border-[var(--color-border)]">
                  <th scope="row" className="py-1 text-left font-normal">
                    {protocolLabel(pair[0])} + {protocolLabel(pair[1])}
                  </th>
                  <td className="py-1 text-right font-mono">{count(borrowers)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-[var(--space-md)] text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
            A count is publishable; the membership is not. The enclave suppresses any bucket thin
            enough to identify a borrower — {count(figures.suppressedBuckets)} of them in this
            report.
          </p>
        </Card>
      </section>

      <footer className="border-t border-[var(--color-border)] pt-[var(--space-md)] text-[length:var(--text-label)] text-[var(--color-text-muted)]">
        <p>
          Wire format and integration:{" "}
          <code className="font-mono">docs/SIGNAL.md</code>. What the enclave does and does not see:{" "}
          <code className="font-mono">docs/ENCLAVE.md</code>. How the thresholds were calibrated:{" "}
          <code className="font-mono">docs/BACKTEST.md</code>. Chart rules:{" "}
          <code className="font-mono">docs/DATAVIZ.md</code>. Tokens and components:{" "}
          <a href="/styleguide" className="text-[var(--color-accent)]">
            /styleguide
          </a>
          .
        </p>
      </footer>
    </main>
  );
}
