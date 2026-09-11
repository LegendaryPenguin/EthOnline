/**
 * On-chain reconciliation oracle.
 *
 * This is deliberately *not* a data source. Sentinel's whole claim is that the
 * standardized subgraph schema is enough to measure cross-protocol risk, and
 * quietly patching gaps with direct contract calls would hollow that out. The
 * contract is used only to check the subgraph-derived numbers and to quantify
 * where the schema falls short — which is a finding, not a workaround.
 *
 * Aave V3 is the target because it carries ~94% of the debt across the four
 * reconciling deployments, and because `getUserAccountData` returns the
 * protocol's own authoritative health factor including E-Mode.
 */

export const AAVE_V3_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";

/** getUserAccountData(address) */
const SELECTOR = "0xbf92857c";

/** Aave reports USD figures in "base" units with 8 decimals. */
const BASE_DECIMALS = 10n ** 8n;

export type UserAccountData = {
  totalCollateralUsd: number;
  totalDebtUsd: number;
  availableBorrowsUsd: number;
  /** Fraction. Reflects E-Mode when the account has it enabled. */
  currentLiquidationThreshold: number;
  ltv: number;
  /** Aave's own health factor. Infinity when the account has no debt. */
  healthFactor: number;
};

export function rpcUrl(): string {
  return process.env.RPC_URL ?? "https://ethereum-rpc.publicnode.com";
}

export async function getUserAccountData(
  account: string,
  { url = rpcUrl(), blockTag = "latest" }: { url?: string; blockTag?: string } = {},
): Promise<UserAccountData> {
  const data = SELECTOR + account.replace(/^0x/, "").toLowerCase().padStart(64, "0");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: AAVE_V3_POOL, data }, blockTag],
    }),
  });

  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(`eth_call failed: ${body.error.message}`);
  if (!body.result || body.result === "0x") throw new Error("eth_call returned no data");

  const hex = body.result.slice(2);
  const word = (i: number) => BigInt("0x" + hex.slice(i * 64, (i + 1) * 64));

  const hf = word(5);
  return {
    totalCollateralUsd: Number(word(0)) / Number(BASE_DECIMALS),
    totalDebtUsd: Number(word(1)) / Number(BASE_DECIMALS),
    availableBorrowsUsd: Number(word(2)) / Number(BASE_DECIMALS),
    // Thresholds and LTV are basis points.
    currentLiquidationThreshold: Number(word(3)) / 10_000,
    ltv: Number(word(4)) / 10_000,
    // Aave returns uint256 max for an account with no debt.
    healthFactor: hf > 10n ** 30n ? Infinity : Number(hf) / 1e18,
  };
}

/** Relative error, treating two zeros as agreement rather than 0/0. */
export function relativeError(ours: number, theirs: number): number {
  if (theirs === 0) return ours === 0 ? 0 : Infinity;
  return Math.abs(ours - theirs) / Math.abs(theirs);
}
