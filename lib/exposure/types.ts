/**
 * Normalized types.
 *
 * Raw subgraph rows are shaped by whichever Messari schema version a deployment
 * happens to be on. Everything downstream of `normalize` works on these types
 * instead, so version skew is handled in exactly one place.
 */

/** Canonical position side. Schema 2.x says LENDER where 3.x says COLLATERAL. */
export type Side = "COLLATERAL" | "BORROWER";

export type RawPosition = {
  id: string;
  side: string;
  isCollateral: boolean | null;
  balance: string;
  account: { id: string };
  /** Absent on schema 2.x, where the asset is the market's input token. */
  asset?: { id: string; symbol: string; decimals: number };
  market: {
    id: string;
    liquidationThreshold: string;
    maximumLTV: string;
    inputTokenPriceUSD: string;
    inputToken: { id: string; symbol: string; decimals: number };
    /**
     * The market's receipt token — Aave's aToken, Compound's cToken. Needed
     * because Aave V3 reports supply positions in the aToken rather than the
     * underlying, and the aToken has no price anywhere in the schema.
     */
    outputToken?: { id: string; symbol: string; decimals: number } | null;
    /** Output token per input token, when the protocol reports one. */
    exchangeRate?: string | null;
  };
};

export type RawMarket = {
  id: string;
  name: string | null;
  isActive: boolean;
  canUseAsCollateral: boolean;
  canBorrowFrom: boolean;
  maximumLTV: string;
  liquidationThreshold: string;
  liquidationPenalty: string;
  inputTokenPriceUSD: string;
  totalValueLockedUSD: string;
  totalBorrowBalanceUSD: string;
  totalDepositBalanceUSD: string;
  inputToken: { id: string; symbol: string; decimals: number };
};

/** A position after normalization, valued in USD. */
export type Position = {
  id: string;
  /** Deployment key, e.g. "aave-v3-eth". */
  protocol: string;
  /** Lowercased address. The cross-protocol join key. */
  account: string;
  side: Side;
  assetId: string;
  assetSymbol: string;
  /** Token units, decimals applied. */
  amount: number;
  /** USD value at the snapshot block. */
  valueUsd: number;
  /** Fraction, e.g. 0.825. Zero when the market reports none. */
  liquidationThreshold: number;
  maximumLtv: number;
  marketId: string;
};

/**
 * How much to trust a computed health factor.
 *
 * `ok`            every collateral position had a usable threshold.
 * `incomplete`    some collateral reported no threshold, so it contributes
 *                 nothing to the liquidation boundary and the HF is pessimistic.
 * `contradicted`  HF < 1 on a live, un-liquidated position. Liquidating is
 *                 profitable and bots are fast, so the account being alive is
 *                 stronger evidence than our arithmetic: the parameters are
 *                 wrong, not the borrower. The dominant cause is Aave V3
 *                 E-Mode, which raises thresholds for correlated pairs such as
 *                 weETH against WETH and is not represented anywhere in the
 *                 standardized schema.
 */
export type HealthConfidence = "ok" | "incomplete" | "contradicted";

/** Position totals within one protocol. */
export type ProtocolExposure = {
  collateralUsd: number;
  debtUsd: number;
  /** Sum of collateral x liquidationThreshold — the liquidation boundary. */
  weightedCollateralUsd: number;
  /** Collateral whose threshold the subgraph did not report. */
  unknownThresholdUsd: number;
  /** weightedCollateralUsd / debtUsd. Infinity when debt is zero. */
  healthFactor: number;
  confidence: HealthConfidence;
  /**
   * The elevated threshold applied to resolve a contradiction, or null.
   *
   * Non-null means this protocol's numbers rest on an inference — Aave V3 E-Mode,
   * which the standardized schema does not express — rather than on published
   * parameters alone. Recorded rather than folded in silently, because a consumer
   * is entitled to know which figures are observed and which are reconstructed.
   */
  emodeThreshold: number | null;
};

/** Everything one account holds, across every protocol. */
export type AccountExposure = {
  account: string;
  protocols: string[];
  collateralUsd: number;
  debtUsd: number;
  weightedCollateralUsd: number;
  unknownThresholdUsd: number;
  /**
   * Aggregate weighted collateral over aggregate debt.
   *
   * This is a *leverage* measure, not a liquidation predictor. No protocol can
   * liquidate against another's collateral, so the number that decides an actual
   * liquidation is the per-protocol one in `byProtocol`. The aggregate is what
   * makes cross-protocol leverage visible, which is the point of the project —
   * but it must never be read as "this account is about to be liquidated".
   */
  aggregateLeverageRatio: number;
  /** Weakest per-protocol confidence. */
  confidence: HealthConfidence;
  /** Per-protocol breakdown. Liquidation happens here. */
  byProtocol: Record<string, ProtocolExposure>;
  positions: Position[];
  /** Collateral USD by asset, for shock targeting. */
  collateralByAsset: Record<string, number>;
};

export type Provenance = {
  /** Block per deployment key. */
  blocks: Record<string, number>;
  capturedAt: string;
  /** Deployments excluded, with the reason. */
  excluded: { deployment: string; reason: string }[];
  /** True when every included deployment served the same block. */
  blockAligned: boolean;
};

export type Snapshot = {
  provenance: Provenance;
  positions: Position[];
  markets: Record<string, RawMarket[]>;
  protocolTotals: Record<string, { borrowUsd: number; tvlUsd: number; name: string }>;
};
