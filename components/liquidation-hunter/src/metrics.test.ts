import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from './metrics.js';
import { createTelegramNotifier } from './telegram.js';
import type { ExecutionRecord } from './types.js';

const ex = (i: number, status: 'success' | 'failed', pnl: number, repay = 1000): ExecutionRecord => ({
  id: `e${i}`,
  ts: `2026-01-01T00:00:0${i}.000Z`,
  cycle: 1,
  mode: 'paper',
  executor: 'paper',
  simulated: true,
  opportunityId: `o${i}`,
  protocol: 'kamino',
  status,
  repayUsd: repay,
  expectedNetProfitUsd: 40,
  realizedPnlUsd: pnl,
  gasPaidUsd: 1,
  adverseSlippageBps: 0,
});

test('empty ledger -> zeroed report, no division by zero', () => {
  const r = buildReport({ executions: [], mode: 'paper', status: 'active', capitalUsd: 1000, startingCapitalUsd: 1000, notes: [] });
  assert.equal(r.schema, 'mm.strategy-report/v1');
  assert.equal(r.kind, 'liquidation');
  assert.equal(r.winRate, 0);
  assert.equal(r.avgProfit, 0);
  assert.equal(r.sharpeRatio, 0);
  assert.equal(r.maxDrawdown, 0);
  assert.equal(r.totalReturn, 0);
  assert.equal(r.totalTrades, 0);
  for (const v of Object.values(r)) if (typeof v === 'number') assert.ok(Number.isFinite(v));
});

test('metrics over attempted executions only', () => {
  const executions = [ex(1, 'success', 40), ex(2, 'failed', -2), ex(3, 'success', -5), ex(4, 'success', 20, 500)];
  const r = buildReport({ executions, mode: 'paper', status: 'active', capitalUsd: 2000, startingCapitalUsd: 1000, notes: ['n'] });
  assert.equal(r.totalTrades, 4);
  assert.equal(r.winRate, 2 / 4);
  assert.equal(r.realizedPnlUsd, 53);
  assert.equal(r.totalReturn, 53 / 1000);
  const returns = [0.04, -0.002, -0.005, 0.04];
  assert.ok(Math.abs(r.avgProfit - returns.reduce((a, b) => a + b) / 4) < 1e-12);
  // equity: 1000, 1040, 1038, 1033, 1053 -> dd = 7/1040
  assert.ok(Math.abs(r.maxDrawdown - 7 / 1040) < 1e-12);
  assert.ok(r.sharpeRatio > 0);
  assert.equal(r.deployedUsd, 0);
  assert.equal(r.openPositions, 0);
  assert.equal(r.capitalUsd, 2000);
  assert.equal(r.notes?.[0], 'n');
});

test('telegram notifier: no-op without token, never throws on failure', async () => {
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error('offline');
  };
  await createTelegramNotifier(undefined, '1', failing).send('x');
  assert.equal(calls, 0);
  await createTelegramNotifier('t', '1', failing).send('x');
  assert.ok(calls >= 1);
  let body: any;
  await createTelegramNotifier('t', '42', async (_u, init) => {
    body = JSON.parse(String(init?.body));
    return new Response('{}', { status: 200 });
  }).send('hello');
  assert.deepEqual([body.chat_id, body.text], ['42', 'hello']);
});
