import type { VerifiedReportView } from "@/lib/ui/view-model";
import { bps, block, count, usdExact, usdShort } from "@/lib/ui/format";
import { Badge, Card, Stat, StatGrid } from "./primitives";

/**
 * The published signal — and the fact that it was verified here before being shown.
 *
 * The page runs the same check `contracts/src/SentinelConsumer.sol` runs on chain
 * (`lib/signal/consume.ts`), so the badge is a result rather than a claim: if verification
 * failed, `loadDashboard` returns an error state and this card never renders. The figures
 * below are the *whole* published surface — thirteen aggregates and not one address.
 */
export function SignalCard({ report }: { report: VerifiedReportView }) {
  const figures = report.figures;
  return (
    <Card
      title="The signal, as published"
      note={
        <>
          {report.reportBytes} bytes, signed inside the enclave and verified in this process with the
          identity and quorum rules the on-chain consumer uses.
        </>
      }
    >
      <div className="mb-[var(--space-md)] flex flex-wrap items-center gap-[var(--space-sm)]">
        <Badge tone="calm">signature verified</Badge>
        <span className="text-[length:var(--text-label)] text-[var(--color-text-muted)]">
          {report.acceptedSigners.length} of {report.signerSetSize} signers accepted, quorum is{" "}
          {report.requiredSigners} (f+1). Workflow{" "}
          <span className="font-mono text-[var(--color-text)]">{report.workflowName}</span>, as of
          block <span className="font-mono text-[var(--color-text)]">{block(report.asOfBlock)}</span>.
        </span>
      </div>

      <StatGrid>
        <Stat
          label="Systemic risk score"
          value={bps(figures.systemicRiskScoreBps)}
          of="composite, bps of 100 — its change is comparable across readings, its level is not"
          tone="accent"
        />
        <Stat
          label="Multi-protocol debt"
          value={usdShort(figures.multiProtocolDebtUsd)}
          exact={usdExact(figures.multiProtocolDebtUsd)}
          of={`${bps(figures.multiProtocolShareBps)} of evaluable debt (${usdShort(figures.evaluableDebtUsd)})`}
        />
        <Stat
          label="Levered share"
          value={bps(figures.leveredShareBps)}
          of="of evaluable debt on books past the policy's leverage watch level (the level itself is confidential)"
        />
        <Stat
          label={`Distressed at ${bps(figures.worstShockBps, 0)}`}
          value={usdShort(figures.worstShockDistressedDebtUsd)}
          exact={usdExact(figures.worstShockDistressedDebtUsd)}
          of="worst modelled shock in this report"
          tone="warn"
        />
      </StatGrid>

      <dl className="mt-[var(--space-md)] grid grid-cols-1 gap-x-[var(--space-lg)] gap-y-1 text-[length:var(--text-label)] sm:grid-cols-2">
        <Row term="Borrowers observed" value={count(figures.borrowersObserved)} />
        <Row
          term="Debt in the sample"
          value={usdShort(figures.debtUsd)}
          title={usdExact(figures.debtUsd)}
        />
        <Row
          term="Coupling buckets published"
          value={`${count(figures.couplingBuckets)} of ${count(figures.couplingBuckets + figures.suppressedBuckets)}`}
        />
        <Row
          term="Buckets suppressed as too small"
          value={count(figures.suppressedBuckets)}
          note="k-anonymity: a bucket thin enough to identify a borrower is not published at all"
        />
        <Row
          term="E-Mode inferred books"
          value={count(figures.emodeInferredBorrowers)}
          note="category is not observable on chain, so these are bracketed rather than asserted"
        />
        <Row
          term="Debt on inferred books"
          value={usdShort(figures.emodeInferredDebtUsd)}
          title={usdExact(figures.emodeInferredDebtUsd)}
        />
      </dl>
    </Card>
  );
}

function Row({
  term,
  value,
  title,
  note,
}: {
  term: string;
  value: string;
  title?: string;
  note?: string;
}) {
  return (
    <div className="flex flex-col border-t border-[var(--color-border)] py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-[var(--space-md)]">
      <dt className="text-[var(--color-text-muted)]">
        {term}
        {note ? (
          <span className="block text-[length:var(--text-micro)] text-[var(--color-text-faint)]">
            {note}
          </span>
        ) : null}
      </dt>
      <dd className="font-mono whitespace-nowrap" title={title}>
        {value}
      </dd>
    </div>
  );
}
