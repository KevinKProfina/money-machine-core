/**
 * Paper fills: market price worsened by fixed slippage plus constant-product price
 * impact from pool liquidity, minus a fee. Ported from solana-trading-agent's
 * PaperExecutor. Nothing is ever sent to a chain; every fill is simulated.
 *
 * Arena addition: many agents may hit the same pool in one cycle. `priorFlowUsd`
 * is the same-direction volume already filled against that pool this cycle, so
 * later orders pay the impact of the cumulative flow (a crowded trade gets worse).
 */
export type FillCosts = { feeBps: number; slippageBps: number };

/**
 * Approximate price impact of a trade of sizeUsd against a constant-product pool
 * with total liquidity liquidityUsd (half on each side): size / (reserve + size).
 * Unknown or zero liquidity is treated as very thin (25 % impact) rather than free.
 */
export function priceImpact(sizeUsd: number, liquidityUsd: number | undefined): number {
  if (!liquidityUsd || !Number.isFinite(liquidityUsd) || liquidityUsd <= 0) return 0.25;
  const reserve = liquidityUsd / 2;
  return Math.min(0.5, sizeUsd / (reserve + sizeUsd));
}

export type BuyFill = { quantity: number; feeUsd: number; fillPriceUsd: number; impact: number };
export type SellFill = { grossUsd: number; feeUsd: number; proceedsUsd: number; fillPriceUsd: number; impact: number };

export function paperBuy(priceUsd: number, liquidityUsd: number, sizeUsd: number, costs: FillCosts, priorFlowUsd = 0): BuyFill {
  const impact = priceImpact(priorFlowUsd + sizeUsd, liquidityUsd);
  const fillPriceUsd = priceUsd * (1 + costs.slippageBps / 10_000 + impact);
  const feeUsd = sizeUsd * (costs.feeBps / 10_000);
  const quantity = (sizeUsd - feeUsd) / fillPriceUsd;
  return { quantity, feeUsd, fillPriceUsd, impact };
}

export function paperSell(quantity: number, priceUsd: number, liquidityUsd: number, costs: FillCosts, priorFlowUsd = 0): SellFill {
  const impact = priceImpact(priorFlowUsd + quantity * priceUsd, liquidityUsd);
  const fillPriceUsd = priceUsd * Math.max(0, 1 - costs.slippageBps / 10_000 - impact);
  const grossUsd = quantity * fillPriceUsd;
  const feeUsd = grossUsd * (costs.feeBps / 10_000);
  return { grossUsd, feeUsd, proceedsUsd: grossUsd - feeUsd, fillPriceUsd, impact };
}

/** Per-cycle cumulative same-direction flow per pool. */
export class PoolFlow {
  private readonly buys = new Map<string, number>();
  private readonly sells = new Map<string, number>();
  buyFlow(mint: string): number {
    return this.buys.get(mint) ?? 0;
  }
  sellFlow(mint: string): number {
    return this.sells.get(mint) ?? 0;
  }
  addBuy(mint: string, usd: number): void {
    this.buys.set(mint, this.buyFlow(mint) + usd);
  }
  addSell(mint: string, usd: number): void {
    this.sells.set(mint, this.sellFlow(mint) + usd);
  }
}
