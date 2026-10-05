import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, maxDrawdown, sharpe } from './metrics.js';
import type { Position } from './positions.js';

function closed(sizeUsd: number, pnl: number): Position {
  return {
    id: String(Math.random()), mint: 'M', symbol: 'S', status: 'closed', mode: 'paper', simulated: true,
    openedAt: '2026-01-01T00:00:00Z', entryPriceUsd: 1, sizeUsd, quantity: sizeUsd, highestPriceUsd: 1,
    lastPriceUsd: 1, lastPriceAt: '2026-01-01T00:00:00Z', realizedPnlUsd: pnl, returnPct: pnl / sizeUsd, proceedsUsd: sizeUsd + pnl,
  };
}

test('maxDrawdown: peak-to-trough fraction', () => {
  assert.equal(maxDrawdown([100, 120, 90, 130, 117]), 0.25);
  assert.equal(maxDrawdown([100, 110, 120]), 0);
  assert.equal(maxDrawdown([]), 0);
});

test('sharpe: mean / sample stdev, 0 for < 2 trades or zero variance', () => {
  assert.equal(sharpe([0.1]), 0);
  assert.equal(sharpe([0.1, 0.1]), 0);
  // returns 0.1, -0.05: mean 0.025, sample sd = 0.10607
  assert.ok(Math.abs(sharpe([0.1, -0.05]) - 0.025 / Math.sqrt(0.01125)) < 1e-12);
});

test('computeMetrics: realized, unrealized, winRate, avgProfit, totalReturn', () => {
  const open: Position = { ...closed(100, 0), status: 'open', quantity: 50, lastPriceUsd: 2.4, realizedPnlUsd: undefined, returnPct: undefined };
  const positions = [closed(100, 20), closed(50, -5), closed(50, 0), open];
  const m = computeMetrics(positions, [{ ts: 'a', equityUsd: 1000 }, { ts: 'b', equityUsd: 900 }, { ts: 'c', equityUsd: 1035 }], 1000);
  assert.equal(m.realizedPnlUsd, 15);
  assert.equal(m.unrealizedPnlUsd, 20); // 50 * 2.4 - 100
  assert.equal(m.deployedUsd, 100);
  assert.equal(m.totalReturn, 0.035);
  assert.equal(m.winRate, 0.333333);
  assert.equal(m.avgProfit, 0.033333); // (0.2 - 0.1 + 0) / 3
  assert.equal(m.maxDrawdown, 0.1);
  assert.equal(m.totalTrades, 3);
  assert.equal(m.openPositions, 1);
});

test('computeMetrics with no trades is all zeros', () => {
  const m = computeMetrics([], [], 1000);
  assert.deepEqual([m.winRate, m.avgProfit, m.sharpeRatio, m.maxDrawdown, m.totalReturn], [0, 0, 0, 0, 0]);
});
