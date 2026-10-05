import type { CostParams, Economics, LendingPosition } from './types.js';

// Pure liquidation economics. All fractions are 0..1, all values USD.

/** Health factor = collateral * liquidationThreshold / debt. < 1 means liquidatable. */
export function healthFactor(collateralUsd: number, debtUsd: number, liquidationThreshold: number): number {
  if (debtUsd <= 0) return Number.POSITIVE_INFINITY;
  return (collateralUsd * liquidationThreshold) / debtUsd;
}

/** Loan-to-value = debt / collateral (fraction). Infinity if collateral is 0 and debt > 0. */
export function loanToValue(collateralUsd: number, debtUsd: number): number {
  if (debtUsd <= 0) return 0;
  if (collateralUsd <= 0) return Number.POSITIVE_INFINITY;
  return debtUsd / collateralUsd;
}

export function isLiquidatable(hf: number): boolean {
  return Number.isFinite(hf) && hf < 1;
}

/**
 * Max debt repayable in one call: limited by the close factor, by the collateral
 * available to seize (repay * (1 + bonus) <= collateral) and by the caller's cap.
 */
export function maxRepayableDebt(
  debtUsd: number,
  collateralUsd: number,
  closeFactor: number,
  liquidationBonus: number,
  capUsd: number = Number.POSITIVE_INFINITY,
): number {
  const byCloseFactor = Math.max(0, debtUsd) * clamp(closeFactor, 0, 1);
  const byCollateral = Math.max(0, collateralUsd) / (1 + Math.max(0, liquidationBonus));
  return Math.max(0, Math.min(byCloseFactor, byCollateral, Math.max(0, capUsd)));
}

/** Collateral seized for a given repay amount. */
export function collateralSeized(repayUsd: number, liquidationBonus: number): number {
  return repayUsd * (1 + liquidationBonus);
}

export type RiskInputs = {
  healthFactor: number;
  repayUsd: number;
  gasShare: number;
  collateralVolatility: number;
};

/** Size at which the size component of risk saturates. */
export const RISK_SIZE_REFERENCE_USD = 50_000;

/**
 * Heuristic risk score 0..100 (higher = riskier). Components:
 * - margin: HF just below 1 can flip back above 1 (oracle update) before the tx lands,
 *   and is the most contested by other liquidators (saturates at 5 % below threshold);
 * - size: bigger repays mean more price impact and capital at risk;
 * - gas share: gas eating the gross profit makes the trade fragile to gas spikes;
 * - volatility: collateral can move between detection and sale.
 */
export function riskScore(input: RiskInputs): number {
  const margin = Number.isFinite(input.healthFactor) ? 1 - input.healthFactor : 0;
  const marginRisk = margin <= 0 ? 1 : clamp(1 - margin / 0.05, 0, 1);
  const sizeRisk = clamp(input.repayUsd / RISK_SIZE_REFERENCE_USD, 0, 1);
  const gasRisk = Number.isFinite(input.gasShare) ? clamp(input.gasShare / 0.3, 0, 1) : 1;
  const volRisk = clamp(input.collateralVolatility / 1.5, 0, 1);
  const score = 100 * (0.35 * marginRisk + 0.2 * sizeRisk + 0.2 * gasRisk + 0.25 * volRisk);
  return round2(score);
}

/** Full expected economics for liquidating `position` under `costs`. */
export function computeEconomics(position: LendingPosition, costs: CostParams): Economics {
  const hf = healthFactor(position.collateralUsd, position.debtUsd, position.liquidationThreshold);
  const ltv = loanToValue(position.collateralUsd, position.debtUsd);
  const liquidatable = isLiquidatable(hf);
  const repayUsd = liquidatable
    ? maxRepayableDebt(
        position.debtUsd,
        position.collateralUsd,
        position.closeFactor,
        position.liquidationBonus,
        costs.maxRepayUsd,
      )
    : 0;
  const seized = collateralSeized(repayUsd, position.liquidationBonus);
  const grossProfitUsd = seized - repayUsd;
  const gasUsd = Math.max(0, position.gasCostUsd);
  const slippageUsd = (seized * Math.max(0, costs.collateralSlippageBps)) / 10_000;
  const flashLoanFeeUsd = costs.useFlashLoan ? (repayUsd * Math.max(0, costs.flashLoanFeeBps)) / 10_000 : 0;
  const netProfitUsd = grossProfitUsd - gasUsd - slippageUsd - flashLoanFeeUsd;
  const netReturn = repayUsd > 0 ? netProfitUsd / repayUsd : 0;
  const gasShare = grossProfitUsd > 0 ? gasUsd / grossProfitUsd : Number.POSITIVE_INFINITY;
  return {
    healthFactor: hf,
    ltv,
    liquidatable,
    repayUsd,
    collateralSeizedUsd: seized,
    grossProfitUsd,
    gasUsd,
    slippageUsd,
    flashLoanFeeUsd,
    netProfitUsd,
    netReturn,
    gasShare,
    riskScore: riskScore({
      healthFactor: hf,
      repayUsd,
      gasShare,
      collateralVolatility: position.collateralVolatility,
    }),
  };
}

// ---------- portfolio statistics ----------

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1). 0 for fewer than 2 values. */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** mean / stdev of per-trade returns; 0 if < 2 trades or zero dispersion. */
export function sharpeRatio(returns: number[]): number {
  const sd = stdev(returns);
  return returns.length < 2 || sd === 0 ? 0 : mean(returns) / sd;
}

/** Max peak-to-trough drawdown of an equity curve, as a fraction 0..1. */
export function maxDrawdown(equity: number[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    if (peak > 0) worst = Math.max(worst, (peak - e) / peak);
  }
  return clamp(worst, 0, 1);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
