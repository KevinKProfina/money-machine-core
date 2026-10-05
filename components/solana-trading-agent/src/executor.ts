import type { Token } from './market.js';
import type { Position } from './positions.js';

export type BuyFill = {
  /** Effective price per token including fees and slippage (costUsd / quantity). */
  priceUsd: number;
  quantity: number;
  quantityRaw?: string;
  /** Total USD spent including fees. */
  costUsd: number;
  feeUsd: number;
  tx?: string;
  simulated: boolean;
};

export type SellFill = {
  /** Effective price per token after fees and slippage (proceedsUsd / quantity). */
  priceUsd: number;
  proceedsUsd: number;
  feeUsd: number;
  tx?: string;
  simulated: boolean;
};

export interface Executor {
  readonly kind: 'paper' | 'live';
  buy(token: Token, sizeUsd: number): Promise<BuyFill>;
  /** liquidityUsd: current pool liquidity, when known (paper fills use it for price impact). */
  sell(position: Position, currentPriceUsd: number, liquidityUsd?: number): Promise<SellFill>;
}

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

/**
 * Simulated fills at the current market price, worsened by fixed slippage plus
 * liquidity-dependent price impact, minus a fee.
 * No transaction is sent; every fill is labeled simulated.
 */
export class PaperExecutor implements Executor {
  readonly kind = 'paper' as const;

  constructor(
    private readonly slippageBps: number,
    private readonly feeBps: number,
  ) {}

  async buy(token: Token, sizeUsd: number): Promise<BuyFill> {
    const fillPrice = token.priceUsd * (1 + this.slippageBps / 10_000 + priceImpact(sizeUsd, token.liquidityUsd));
    const feeUsd = sizeUsd * (this.feeBps / 10_000);
    const quantity = (sizeUsd - feeUsd) / fillPrice;
    return { priceUsd: sizeUsd / quantity, quantity, costUsd: sizeUsd, feeUsd, simulated: true };
  }

  async sell(position: Position, currentPriceUsd: number, liquidityUsd?: number): Promise<SellFill> {
    const impact = priceImpact(position.quantity * currentPriceUsd, liquidityUsd);
    const fillPrice = currentPriceUsd * Math.max(0, 1 - this.slippageBps / 10_000 - impact);
    const gross = position.quantity * fillPrice;
    const feeUsd = gross * (this.feeBps / 10_000);
    const proceedsUsd = gross - feeUsd;
    return { priceUsd: position.quantity > 0 ? proceedsUsd / position.quantity : 0, proceedsUsd, feeUsd, simulated: true };
  }
}
