import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGates, type GateLimits } from './gates.js';
import type { Economics } from './types.js';

const econ = (over: Partial<Economics> = {}): Economics => ({
  healthFactor: 0.97,
  ltv: 0.85,
  liquidatable: true,
  repayUsd: 2_000,
  collateralSeizedUsd: 2_100,
  grossProfitUsd: 100,
  gasUsd: 10,
  slippageUsd: 6,
  flashLoanFeeUsd: 0,
  netProfitUsd: 84,
  netReturn: 0.042,
  gasShare: 0.1,
  riskScore: 40,
  ...over,
});

const limits: GateLimits = { minNetProfitUsd: 10, sizeCapUsd: 5_000, maxGasShare: 0.3, maxRiskScore: 60 };

const failedGates = (e: Economics, l = limits) =>
  evaluateGates(e, l)
    .checks.filter((c) => !c.passed)
    .map((c) => c.gate);

test('passes a good opportunity', () => {
  const r = evaluateGates(econ(), limits);
  assert.equal(r.passed, true);
  assert.equal(r.reason, 'all gates passed');
});

test('each gate rejects independently', () => {
  assert.deepEqual(failedGates(econ({ liquidatable: false, healthFactor: 1.1 })), ['liquidatable']);
  assert.deepEqual(failedGates(econ({ netProfitUsd: 9.99 })), ['min-net-profit']);
  assert.deepEqual(failedGates(econ({ gasShare: 0.31 })), ['gas-share']);
  assert.deepEqual(failedGates(econ({ gasShare: Number.POSITIVE_INFINITY })), ['gas-share']);
  assert.deepEqual(failedGates(econ({ riskScore: 60.5 })), ['risk-score']);
  assert.deepEqual(failedGates(econ({ repayUsd: 5_001 })), ['size']);
  assert.deepEqual(failedGates(econ(), { ...limits, sizeCapUsd: 0 }), ['size']);
});

test('boundaries are inclusive', () => {
  assert.equal(evaluateGates(econ({ netProfitUsd: 10, gasShare: 0.3, riskScore: 60, repayUsd: 5_000 }), limits).passed, true);
});

test('reason lists every failure', () => {
  const r = evaluateGates(econ({ netProfitUsd: 1, riskScore: 99 }), limits);
  assert.equal(r.passed, false);
  assert.match(r.reason, /min-net-profit/);
  assert.match(r.reason, /risk-score/);
});
