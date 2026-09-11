/**
 * Protocol-to-protocol coupling.
 *
 * Two lending protocols are coupled when trouble at one propagates to the other.
 * There are exactly two channels in this data and they are different in kind, so
 * they are measured separately rather than blended into one score:
 *
 *   shared borrowers  — the same address is levered on both. A liquidation on one
 *                       consumes collateral that was backing nothing on the other,
 *                       but it does force the borrower to defend two positions at
 *                       once with one balance sheet.
 *   shared collateral — both protocols hold the same asset as collateral, and both
 *                       will liquidate it into the same pools. This is the channel
 *                       that actually transmits, because it needs no shared
 *                       borrower at all: two protocols with no addresses in common
 *                       still crash each other if they are secured by the same
 *                       thing.
 *
 * The second one is the finding. It is invisible to every individual protocol and
 * it does not require the cross-protocol account overlap that Phase 2 measured —
 * that overlap is what makes borrowers fragile, while shared collateral is what
 * makes *protocols* fragile.
 */

import type { Position } from "../exposure/types";

export type CouplingMatrix = {
  protocols: string[];
  /**
   * Debt-weighted overlap of shared borrowers.
   *
   * Symmetric by construction: the numerator is the debt of addresses borrowing on
   * both, and the denominator is the debt of addresses borrowing on either, so
   * swapping the arguments cannot change it. That is the Jaccard form, chosen
   * precisely because asymmetry here would be an artefact of normalisation rather
   * than a fact about the protocols.
   */
  borrowerOverlap: Record<string, Record<string, number>>;
  /**
   * Share of A's collateral value held in assets B also lends against.
   *
   * Deliberately *asymmetric*, and this is not an oversight. A $10B protocol and a
   * $10M protocol can be fully exposed to the same asset; the small one is
   * existentially exposed to the large one's forced selling, and the large one
   * barely notices. Symmetrising would erase exactly that, which is the direction
   * contagion actually runs. Read `collateralExposure[A][B]` as "how much of A is
   * standing in front of B's liquidations".
   */
  collateralExposure: Record<string, Record<string, number>>;
  /** The assets doing the transmitting, largest shared value first. */
  sharedAssets: { assetId: string; symbol: string; protocols: string[]; totalUsd: number }[];
};

export function buildCouplingMatrix(positions: Position[]): CouplingMatrix {
  const protocols = [...new Set(positions.map((p) => p.protocol))].sort();

  const debtByAccountProtocol = new Map<string, Map<string, number>>();
  const collateralByProtocolAsset = new Map<string, Map<string, number>>();
  const collateralAssetsByProtocol = new Map<string, Set<string>>();
  const assetProtocols = new Map<string, { symbol: string; protocols: Set<string>; usd: number }>();

  for (const p of positions) {
    const assetId = p.assetId.toLowerCase();
    if (p.side === "BORROWER") {
      const byProtocol = debtByAccountProtocol.get(p.account) ?? new Map<string, number>();
      byProtocol.set(p.protocol, (byProtocol.get(p.protocol) ?? 0) + p.valueUsd);
      debtByAccountProtocol.set(p.account, byProtocol);
      continue;
    }
    const byAsset = collateralByProtocolAsset.get(p.protocol) ?? new Map<string, number>();
    byAsset.set(assetId, (byAsset.get(assetId) ?? 0) + p.valueUsd);
    collateralByProtocolAsset.set(p.protocol, byAsset);

    const assets = collateralAssetsByProtocol.get(p.protocol) ?? new Set<string>();
    assets.add(assetId);
    collateralAssetsByProtocol.set(p.protocol, assets);

    const entry = assetProtocols.get(assetId) ?? {
      symbol: p.assetSymbol,
      protocols: new Set<string>(),
      usd: 0,
    };
    entry.protocols.add(p.protocol);
    entry.usd += p.valueUsd;
    assetProtocols.set(assetId, entry);
  }

  const borrowerOverlap: Record<string, Record<string, number>> = {};
  const collateralExposure: Record<string, Record<string, number>> = {};

  for (const a of protocols) {
    borrowerOverlap[a] = {};
    collateralExposure[a] = {};
    const aCollateral = collateralByProtocolAsset.get(a) ?? new Map();
    const aTotal = [...aCollateral.values()].reduce((s, v) => s + v, 0);

    for (const b of protocols) {
      if (a === b) {
        borrowerOverlap[a][b] = 1;
        collateralExposure[a][b] = 1;
        continue;
      }

      let both = 0;
      let either = 0;
      for (const byProtocol of debtByAccountProtocol.values()) {
        const da = byProtocol.get(a) ?? 0;
        const db = byProtocol.get(b) ?? 0;
        if (da <= 0 && db <= 0) continue;
        either += da + db;
        if (da > 0 && db > 0) both += da + db;
      }
      borrowerOverlap[a][b] = either > 0 ? both / either : 0;

      const bAssets = collateralAssetsByProtocol.get(b) ?? new Set<string>();
      let shared = 0;
      for (const [assetId, usd] of aCollateral) if (bAssets.has(assetId)) shared += usd;
      collateralExposure[a][b] = aTotal > 0 ? shared / aTotal : 0;
    }
  }

  const sharedAssets = [...assetProtocols.entries()]
    .filter(([, e]) => e.protocols.size >= 2)
    .map(([assetId, e]) => ({
      assetId,
      symbol: e.symbol,
      protocols: [...e.protocols].sort(),
      totalUsd: e.usd,
    }))
    .sort((x, y) => y.totalUsd - x.totalUsd);

  return { protocols, borrowerOverlap, collateralExposure, sharedAssets };
}

/**
 * Check the borrower-overlap matrix really is symmetric.
 *
 * Cheap, and it catches the accumulator bug that a hand-read of the loop would
 * not: this is the kind of matrix where a transposed index produces plausible
 * numbers everywhere.
 */
export function assertSymmetric(
  matrix: Record<string, Record<string, number>>,
  tolerance = 1e-12,
): void {
  for (const a of Object.keys(matrix)) {
    for (const b of Object.keys(matrix[a])) {
      const d = Math.abs(matrix[a][b] - matrix[b][a]);
      if (d > tolerance) {
        throw new Error(`coupling matrix is not symmetric at ${a}/${b}: ${d}`);
      }
    }
  }
}
