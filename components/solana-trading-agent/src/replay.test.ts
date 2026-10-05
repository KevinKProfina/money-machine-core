import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay, type ReplayFile } from './replay.js';
import { loadFixture, testConfig } from './testing/fixtures.js';

test('replay fixture exercises every exit path', async () => {
  const cfg = testConfig();
  const data = loadFixture<ReplayFile>('replay-series.json');
  const result = await replay(data.series, { exits: cfg.exits, sizeUsd: 50, startingCapitalUsd: 1000, slippageBps: 0, feeBps: 0 });
  assert.deepEqual(
    result.positions.map((p) => p.exitReason),
    ['take-profit', 'stop-loss', 'trailing-stop', 'max-hold', 'end-of-data'],
  );
  // with zero fees/slippage, PUMPY exits at 1.3 → +30 % minus a tiny price impact ($50 into a $250k pool)
  const ret = result.positions[0]!.returnPct!;
  assert.ok(ret < 0.3 && ret > 0.295, `return ${ret}`);
  assert.equal(result.metrics.totalTrades, 5);
  assert.equal(result.equityCurve.length, 5);
});
