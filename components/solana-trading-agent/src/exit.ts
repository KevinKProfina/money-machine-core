import type { ExitRules } from './config.js';

export type ExitReason = 'take-profit' | 'stop-loss' | 'trailing-stop' | 'max-hold' | 'kill-switch' | 'end-of-data';

export type ExitInput = {
  entryPriceUsd: number;
  /** Highest price observed since entry, including currentPriceUsd. */
  highestPriceUsd: number;
  currentPriceUsd: number;
  openedAt: string;
  now: Date;
};

export type ExitDecision = {
  shouldExit: boolean;
  reason?: ExitReason;
  pnlPct: number;
  detail: string;
};

/**
 * Exit precedence: stop-loss → take-profit → trailing stop → max holding time.
 * The trailing stop only arms after price rose trailingActivationPct above entry.
 */
export function decideExit(input: ExitInput, rules: ExitRules): ExitDecision {
  const { entryPriceUsd, currentPriceUsd } = input;
  const highest = Math.max(input.highestPriceUsd, currentPriceUsd);
  const pnlPct = ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100;
  const fromHighPct = ((highest - currentPriceUsd) / highest) * 100;
  const peakGainPct = ((highest - entryPriceUsd) / entryPriceUsd) * 100;
  const heldHours = (input.now.getTime() - new Date(input.openedAt).getTime()) / 3_600_000;
  const pnl = `${pnlPct.toFixed(2)}%`;
  // tolerance so that e.g. 0.9 vs 1.0 counts as exactly -10 % despite float rounding
  const EPS = 1e-9;

  if (pnlPct <= -rules.stopLossPct + EPS) return { shouldExit: true, reason: 'stop-loss', pnlPct, detail: `stop-loss at ${pnl}` };
  if (pnlPct >= rules.takeProfitPct - EPS) return { shouldExit: true, reason: 'take-profit', pnlPct, detail: `take-profit at ${pnl}` };
  if (rules.trailingStopPct > 0 && peakGainPct >= rules.trailingActivationPct - EPS && fromHighPct >= rules.trailingStopPct - EPS) {
    return { shouldExit: true, reason: 'trailing-stop', pnlPct, detail: `trailing stop: ${fromHighPct.toFixed(2)}% below high, pnl ${pnl}` };
  }
  if (rules.maxHoldHours > 0 && heldHours >= rules.maxHoldHours) {
    return { shouldExit: true, reason: 'max-hold', pnlPct, detail: `held ${heldHours.toFixed(1)}h ≥ ${rules.maxHoldHours}h, pnl ${pnl}` };
  }
  return { shouldExit: false, pnlPct, detail: `holding, pnl ${pnl}` };
}
