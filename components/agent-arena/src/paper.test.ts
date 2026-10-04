import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoolFlow, paperBuy, paperSell, priceImpact } from './paper.js';

const costs = { feeBps: 30, slippageBps: 100 };

test('price impact follows the constant-product approximation and is capped', () => {
  assert.equal(priceImpact(1000, 1_000_000), 1000 / (500_000 + 1000));
  assert.equal(priceImpact(10, 0), 0.25);
  assert.equal(priceImpact(10, Number.NaN), 0.25);
  assert.equal(priceImpact(1e12, 1000), 0.5);
});

test('paper buy: fee + slippage + impact', () => {
  const f = paperBuy(2, 1_000_000, 100, costs);
  const impact = 100 / 500_100;
  assert.ok(Math.abs(f.fillPriceUsd - 2 * (1 + 0.01 + impact)) < 1e-12);
  assert.ok(Math.abs(f.feeUsd - 0.3) < 1e-12);
  assert.ok(Math.abs(f.quantity - 99.7 / f.fillPriceUsd) < 1e-12);
});

test('paper sell: proceeds after slippage, impact and fee', () => {
  const f = paperSell(50, 2, 1_000_000, costs);
  const impact = 100 / 500_100;
  const gross = 50 * 2 * (1 - 0.01 - impact);
  assert.ok(Math.abs(f.grossUsd - gross) < 1e-9);
  assert.ok(Math.abs(f.feeUsd - gross * 0.003) < 1e-12);
  assert.ok(Math.abs(f.proceedsUsd - gross * 0.997) < 1e-9);
});

test('round trip at an unchanged price loses roughly 2x(fee + slippage)', () => {
  const buy = paperBuy(1, 10_000_000, 10, costs);
  const sell = paperSell(buy.quantity, 1, 10_000_000, costs);
  const loss = 1 - sell.proceedsUsd / 10;
  assert.ok(loss > 0.025 && loss < 0.027, String(loss));
});

test('crowded pool: later orders in the same cycle pay more impact', () => {
  const flow = new PoolFlow();
  const first = paperBuy(1, 10_000, 100, costs, flow.buyFlow('m'));
  flow.addBuy('m', 100);
  const second = paperBuy(1, 10_000, 100, costs, flow.buyFlow('m'));
  assert.ok(second.fillPriceUsd > first.fillPriceUsd);
  assert.ok(second.quantity < first.quantity);
});
