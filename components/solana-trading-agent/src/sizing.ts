import type { SizingRules } from './config.js';

export type SizingInput = {
  budgetUsd: number;
  deployedUsd: number;
  openPositions: number;
};

export type SizingResult = { sizeUsd: number; reason: string };

/**
 * Per-trade size = min(MAX_USD_PER_TRADE, budget * MAX_POSITION_PCT, budget - deployed).
 * Returns 0 when the concurrency cap is hit or the resulting size is below MIN_TRADE_USD.
 */
export function computeTradeSize(input: SizingInput, rules: SizingRules): SizingResult {
  if (input.openPositions >= rules.maxConcurrentPositions) {
    return { sizeUsd: 0, reason: `max concurrent positions (${rules.maxConcurrentPositions}) reached` };
  }
  const headroom = Math.max(0, input.budgetUsd - input.deployedUsd);
  const size = Math.min(rules.maxUsdPerTrade, input.budgetUsd * rules.maxPositionPct, headroom);
  if (!(size >= rules.minTradeUsd)) {
    return { sizeUsd: 0, reason: `size $${size.toFixed(2)} below minimum $${rules.minTradeUsd} (budget $${input.budgetUsd.toFixed(2)}, deployed $${input.deployedUsd.toFixed(2)})` };
  }
  return { sizeUsd: Math.floor(size * 100) / 100, reason: 'ok' };
}
