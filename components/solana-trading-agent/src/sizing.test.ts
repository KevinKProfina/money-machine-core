import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeTradeSize } from './sizing.js';
import type { SizingRules } from './config.js';

const rules: SizingRules = { startingCapitalUsd: 1000, maxUsdPerTrade: 50, maxPositionPct: 0.1, maxConcurrentPositions: 3, minTradeUsd: 5 };

test('capped by MAX_USD_PER_TRADE', () => {
  assert.equal(computeTradeSize({ budgetUsd: 10_000, deployedUsd: 0, openPositions: 0 }, rules).sizeUsd, 50);
});

test('capped by budget * MAX_POSITION_PCT', () => {
  assert.equal(computeTradeSize({ budgetUsd: 200, deployedUsd: 0, openPositions: 0 }, rules).sizeUsd, 20);
});

test('total deployed never exceeds budget', () => {
  assert.equal(computeTradeSize({ budgetUsd: 200, deployedUsd: 190, openPositions: 1 }, rules).sizeUsd, 10);
  const none = computeTradeSize({ budgetUsd: 200, deployedUsd: 198, openPositions: 1 }, rules);
  assert.equal(none.sizeUsd, 0);
  assert.match(none.reason, /below minimum/);
  assert.equal(computeTradeSize({ budgetUsd: 200, deployedUsd: 250, openPositions: 1 }, rules).sizeUsd, 0);
});

test('max concurrent positions', () => {
  const r = computeTradeSize({ budgetUsd: 10_000, deployedUsd: 0, openPositions: 3 }, rules);
  assert.equal(r.sizeUsd, 0);
  assert.match(r.reason, /max concurrent/);
});

test('zero budget → no trade', () => {
  assert.equal(computeTradeSize({ budgetUsd: 0, deployedUsd: 0, openPositions: 0 }, rules).sizeUsd, 0);
});
