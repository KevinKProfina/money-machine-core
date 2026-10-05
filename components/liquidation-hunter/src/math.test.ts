import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collateralSeized,
  computeEconomics,
  healthFactor,
  isLiquidatable,
  loanToValue,
  maxDrawdown,
  maxRepayableDebt,
  riskScore,
  sharpeRatio,
  stdev,
} from './math.js';
import type { CostParams, LendingPosition } from './types.js';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const position = (over: Partial<LendingPosition> = {}): LendingPosition => ({
  id: 'p1',
  protocol: 'aave-v3',
  chain: 'ethereum',
  borrower: '0xabc',
  collateralSymbol: 'WETH',
  debtSymbol: 'USDC',
  collateralUsd: 10_000,
  debtUsd: 8_500,
  liquidationThreshold: 0.825,
  liquidationBonus: 0.05,
  closeFactor: 0.5,
  gasCostUsd: 20,
  collateralVolatility: 0.7,
  observedAt: '2026-01-01T00:00:00.000Z',
  simulated: true,
  ...over,
});

const costs = (over: Partial<CostParams> = {}): CostParams => ({
  collateralSlippageBps: 30,
  useFlashLoan: false,
  flashLoanFeeBps: 5,
  maxRepayUsd: Number.POSITIVE_INFINITY,
  ...over,
});

test('healthFactor and LTV', () => {
  near(healthFactor(10_000, 8_500, 0.825), 8250 / 8500);
  assert.equal(healthFactor(10_000, 0, 0.8), Number.POSITIVE_INFINITY);
  near(loanToValue(10_000, 8_500), 0.85);
  assert.equal(loanToValue(10_000, 0), 0);
  assert.equal(loanToValue(0, 10), Number.POSITIVE_INFINITY);
  assert.equal(isLiquidatable(0.99), true);
  assert.equal(isLiquidatable(1), false);
  assert.equal(isLiquidatable(Number.POSITIVE_INFINITY), false);
});

test('maxRepayableDebt respects close factor, collateral and cap', () => {
  near(maxRepayableDebt(8_500, 10_000, 0.5, 0.05), 4_250);
  near(maxRepayableDebt(8_500, 10_000, 0.5, 0.05, 1_000), 1_000);
  // collateral-limited: 1050 collateral, bonus 5% -> at most 1000 repay
  near(maxRepayableDebt(10_000, 1_050, 1, 0.05), 1_000);
  assert.equal(maxRepayableDebt(8_500, 10_000, 0.5, 0.05, -5), 0);
  near(collateralSeized(1_000, 0.05), 1_050);
});

test('computeEconomics: gross, gas, slippage, net', () => {
  const e = computeEconomics(position(), costs({ maxRepayUsd: 2_000 }));
  assert.equal(e.liquidatable, true);
  near(e.repayUsd, 2_000);
  near(e.collateralSeizedUsd, 2_100);
  near(e.grossProfitUsd, 100);
  near(e.slippageUsd, 2_100 * 0.003);
  assert.equal(e.flashLoanFeeUsd, 0);
  near(e.netProfitUsd, 100 - 20 - 6.3);
  near(e.netReturn, 73.7 / 2_000);
  near(e.gasShare, 0.2);
  assert.ok(e.riskScore >= 0 && e.riskScore <= 100);
});

test('computeEconomics: flash loan fee', () => {
  const e = computeEconomics(position(), costs({ maxRepayUsd: 2_000, useFlashLoan: true, flashLoanFeeBps: 9 }));
  near(e.flashLoanFeeUsd, 1.8);
  near(e.netProfitUsd, 100 - 20 - 6.3 - 1.8);
});

test('computeEconomics: healthy position yields no repay and negative net', () => {
  const e = computeEconomics(position({ debtUsd: 5_000 }), costs());
  assert.equal(e.liquidatable, false);
  assert.equal(e.repayUsd, 0);
  assert.equal(e.grossProfitUsd, 0);
  assert.ok(e.netProfitUsd < 0);
  assert.equal(e.gasShare, Number.POSITIVE_INFINITY);
});

test('riskScore: monotone in its inputs and bounded', () => {
  const base = { healthFactor: 0.97, repayUsd: 5_000, gasShare: 0.1, collateralVolatility: 0.6 };
  const r = riskScore(base);
  assert.ok(riskScore({ ...base, healthFactor: 0.999 }) > r, 'closer to threshold = riskier');
  assert.ok(riskScore({ ...base, repayUsd: 40_000 }) > r, 'bigger = riskier');
  assert.ok(riskScore({ ...base, gasShare: 0.29 }) > r, 'gas share = riskier');
  assert.ok(riskScore({ ...base, collateralVolatility: 1.4 }) > r, 'vol = riskier');
  assert.equal(riskScore({ healthFactor: 1.2, repayUsd: 1e9, gasShare: Infinity, collateralVolatility: 9 }), 100);
  assert.equal(riskScore({ healthFactor: 0.5, repayUsd: 0, gasShare: 0, collateralVolatility: 0 }), 0);
});

test('stats: stdev, sharpe, drawdown', () => {
  assert.equal(stdev([1]), 0);
  near(stdev([1, 3]), Math.SQRT2);
  assert.equal(sharpeRatio([0.1]), 0);
  assert.equal(sharpeRatio([0.1, 0.1]), 0);
  near(sharpeRatio([1, 3]), 2 / Math.SQRT2);
  near(maxDrawdown([100, 110, 99, 120, 108]), 0.1);
  assert.equal(maxDrawdown([100, 101, 102]), 0);
  assert.equal(maxDrawdown([]), 0);
});
