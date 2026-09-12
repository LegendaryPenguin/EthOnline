/**
 * The thin consumer SDK: pin a policy once, consume reports.
 *
 * `consume.ts` is the primitive and takes its policy on every call, which is right for a
 * verifier and wrong for an integration — a policy passed per call is a policy that can
 * be passed differently per call, and the one that matters is the one somebody loosens
 * at 3am to make an alert go away. Here the policy is captured at construction and the
 * consume path takes only the report.
 *
 * Everything else in this file is the same code the reference consumers run. There is no
 * second implementation of any check.
 */

import type { Address } from "viem";
import {
  describeSignal,
  verifySignalReport,
  type ConsumerPolicy,
  type SignedReport,
  type VerifiedSignal,
} from "./consume";

/** Operating points from `docs/SIGNAL.md`, in bps of score, with their measured false-alarm rates. */
export const OPERATING_POINTS = [
  { stance: "alert", riseBps: 239, falseAlarmRate: 0.1 },
  { stance: "warn", riseBps: 87, falseAlarmRate: 0.2 },
  { stance: "watch", riseBps: 61, falseAlarmRate: 0.3 },
] as const;

export type Stance = (typeof OPERATING_POINTS)[number]["stance"] | "normal";

export type SentinelClientConfig = ConsumerPolicy & {
  /**
   * How far back the baseline reading must be before a comparison is meaningful, in
   * blocks. Defaults to 168 hours at ~298.4 blocks/hour — the same pairing lag Sentinel's
   * calibration uses, so hour-of-day and day-of-week cancel.
   */
  baselineLagBlocks?: bigint;
};

export const WEEK_BLOCKS = 50_131n;

export type Reading = { asOfBlock: bigint; scoreBps: number };

export type Assessment = {
  verified: VerifiedSignal;
  /** Human-readable, and safe to log: it accepts only a verified signal. */
  summary: string;
  stance: Stance;
  /** Change against the baseline, in bps of score. Negative when risk is falling. */
  riseBps: number | null;
  falseAlarmRate: number | null;
  baseline: Reading | null;
};

/**
 * A consumer that holds its own baseline.
 *
 * Stateful on purpose. `docs/SIGNAL.md` explains why the level is not a threshold — an
 * absolute cut detected none of the replayed cascade episodes — so a client that judged
 * each report in isolation would be judging the wrong quantity, however carefully it
 * verified the bytes.
 */
export class SentinelClient {
  private readonly policy: ConsumerPolicy;
  private readonly baselineLagBlocks: bigint;
  private baseline: Reading | null = null;
  private latestSeen: Reading | null = null;

  constructor(config: SentinelClientConfig) {
    const { baselineLagBlocks, ...policy } = config;
    this.policy = policy;
    this.baselineLagBlocks = baselineLagBlocks ?? WEEK_BLOCKS;
  }

  get latest(): Reading | null {
    return this.latestSeen;
  }

  get baselineReading(): Reading | null {
    return this.baseline;
  }

  /**
   * Verify a report, then place it against the baseline.
   *
   * Throws `ReportRejected` on anything that fails verification — including a report
   * older than one already accepted, which is refused because rolling the comparison
   * backwards could clear a stance that current data does not clear.
   */
  async consume(report: SignedReport, currentBlock: bigint): Promise<Assessment> {
    const verified = await verifySignalReport(report, this.policy, currentBlock);
    const reading: Reading = {
      asOfBlock: verified.signal.asOfBlock,
      scoreBps: verified.signal.systemicRiskScoreBps,
    };

    if (this.latestSeen && reading.asOfBlock <= this.latestSeen.asOfBlock) {
      const { ReportRejected } = await import("./consume");
      throw new ReportRejected(
        `signal is from block ${reading.asOfBlock}, not newer than the accepted ${this.latestSeen.asOfBlock}`,
      );
    }

    const baseline = this.baseline ?? reading;
    // The first reading is its own baseline, so it can only be `normal`: there is
    // nothing yet to compare it against, whatever its level.
    const riseBps = this.baseline === null ? null : reading.scoreBps - baseline.scoreBps;
    const point =
      riseBps === null ? null : OPERATING_POINTS.find((p) => riseBps >= p.riseBps) ?? null;

    this.latestSeen = reading;
    if (this.baseline === null || reading.asOfBlock >= this.baseline.asOfBlock + this.baselineLagBlocks) {
      // Rolled after the comparison, so this reading is the baseline for the week that
      // follows rather than for itself.
      this.baseline = reading;
    }

    return {
      verified,
      summary: describeSignal(verified),
      stance: point?.stance ?? "normal",
      riseBps,
      falseAlarmRate: point?.falseAlarmRate ?? null,
      baseline: this.baseline === reading ? baseline : this.baseline,
    };
  }
}

/** Convenience for a caller that has the pieces loose. */
export function sentinelClient(options: {
  signers: Address[];
  f: number;
  workflowOwner: Address;
  workflowName: string;
  maxBlockAge: bigint;
  baselineLagBlocks?: bigint;
}): SentinelClient {
  return new SentinelClient(options);
}

export { ReportRejected, type SignedReport, type VerifiedSignal } from "./consume";
export { decodeSignal, SIGNAL_ABI_PARAMS, type DecodedSignal } from "./report";
