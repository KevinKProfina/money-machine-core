import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperExecutor, priceImpact } from './executor.js';
import type { Token } from './market.js';

test('price impact grows with trade size relative to liquidity', () => {
  assert.ok(priceImpact(100, 1_000_000) < 0.001);
  assert.ok(Math.abs(priceImpact(10_000, 100_000) - 10_000 / 60_000) < 1e-12);
  assert.equal(priceImpact(100, 0), 0.25);
  assert.equal(priceImpact(1e9, 1), 0.5);
});

test('paper fills in thin pools are worse than in deep pools', async () => {
  const ex = new PaperExecutor(50, 25);
  const base = { mint: 'm', symbol: 'T', priceUsd: 1 } as Token;
  const deep = await ex.buy({ ...base, liquidityUsd: 5_000_000 }, 500);
  const thin = await ex.buy({ ...base, liquidityUsd: 20_000 }, 500);
  assert.ok(thin.quantity < deep.quantity * 0.97);
});
