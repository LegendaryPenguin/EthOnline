/**
 * Price impact from real reserves.
 *
 * The constant-product invariant, applied to the reserve of the asset being sold
 * summed across every usable pool. Two prices come out of one trade and the
 * cascade needs both, for different reasons:
 *
 *   execution price  what the liquidator actually receives, which decides
 *                    whether the debt gets repaid.
 *   post-trade spot  what the *remaining* collateral is now marked at, which
 *                    decides who becomes liquidatable next. This is the channel
 *                    the cascade travels down.
 *
 * Conflating them is the usual modelling error, and it biases in the dangerous
 * direction: execution price is always the gentler of the two, so using it to
 * re-mark collateral understates the next round.
 */

/**
 * Why summing reserves across pools is the right aggregate.
 *
 * For constant-product pools, a trade split across pools in proportion to their
 * reserves produces exactly the impact of one pool holding the summed reserves,
 * and that split is the optimal one — any other allocation is strictly worse for
 * the seller. Liquidators route optimally, so the summed reserve is the correct
 * and also the most generous assumption.
 */
export function totalReserve(reserves: number[]): number {
  return reserves.reduce((s, r) => s + r, 0);
}

/**
 * Average price realised when selling `sell` tokens into `reserve` tokens of
 * depth, as a fraction of the pre-trade price.
 *
 * Constant product: out = R_quote * sell / (R_asset + sell), so the average
 * price is R_quote/(R_asset + sell) against a pre-trade R_quote/R_asset.
 */
export function executionPriceRatio(sell: number, reserve: number): number {
  if (sell <= 0) return 1;
  if (reserve <= 0) return 0; // No depth: nothing is realised at any price.
  return reserve / (reserve + sell);
}

/**
 * Spot price *after* the trade, as a fraction of the price before it.
 *
 * The square of the execution ratio, because both sides of the invariant move:
 * the asset reserve grows and the quote reserve shrinks. This is the number that
 * re-marks every unsold unit of the same collateral, everywhere.
 */
export function spotPriceRatio(sell: number, reserve: number): number {
  const r = executionPriceRatio(sell, reserve);
  return r * r;
}

/**
 * Proceeds in USD from dumping `sell` tokens priced at `price`.
 *
 * Slippage is a real loss to the seller, so proceeds are strictly below
 * `sell * price` whenever the trade is large relative to depth.
 */
export function saleProceedsUsd(sell: number, price: number, reserve: number): number {
  return sell * price * executionPriceRatio(sell, reserve);
}

/**
 * Known biases of this model, kept next to the model rather than in a README.
 *
 * Uniswap V3 and SushiSwap V3 concentrate liquidity in a tick range, so treating
 * total pool balances as a constant-product curve is wrong in both directions at
 * once: it *overstates* slippage for trades small enough to stay inside the
 * active range, and *understates* it for trades that exhaust the range, because a
 * real V3 pool runs out of quote token entirely while this curve never does.
 * Curve's amplified invariant is far flatter than constant product near the peg,
 * so depth there is understated.
 *
 * The volumes this model is used on — hundreds of millions against tens of
 * millions of depth — are firmly in the range-exhausting regime, so the dominant
 * error understates impact. That is why every cascade figure Sentinel publishes
 * is a floor, and why `depthMultiplier` exists: the sensitivity table re-runs the
 * whole simulation at 0.5x, 1x and 2x depth so the reader can see exactly how
 * much of the conclusion rests on this approximation instead of taking it on
 * trust.
 */
export const IMPACT_MODEL = "constant-product on summed pool reserves" as const;
