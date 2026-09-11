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

/** Everything one account holds, across every protocol. */
export type AccountExposure = {
  account: string;
  protocols: string[];
  collateralUsd: number;
  debtUsd: number;
  /** Sum of collateral x liquidationThreshold — the liquidation boundary. */
  weightedCollateralUsd: number;
  /** weightedCollateralUsd / debtUsd. Infinity when debt is zero. */
  healthFactor: number;
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
