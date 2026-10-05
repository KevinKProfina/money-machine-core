import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GumroadSource, mapGumroadSales, type GumroadSale } from './sources/gumroad.js';
import { fixture, fixtureFetch } from './test-utils.js';
import { type Logger, silentLogger } from './types.js';

const page1 = fixture('gumroad-page1.json') as { sales: GumroadSale[] };
const page2 = fixture('gumroad-page2.json') as { sales: GumroadSale[] };

test('mapping: sale, fee, refund, non-USD skipped, test sale simulated', () => {
  const warnings: string[] = [];
  const log: Logger = { ...silentLogger, warn: (m) => warnings.push(m) };
  const events = mapGumroadSales([...page1.sales, ...page2.sales], { stream: 'gumroad', log });
  assert.deepEqual(
    Object.fromEntries(events.map((e) => [e.id, e.amountUsd])),
    { 'gumroad:sale_a': 15, 'gumroad:sale_a:fee': -1.65, 'gumroad:sale_b': 9, 'gumroad:sale_b:refund': -9, 'gumroad:sale_d': 5 },
  );
  assert.ok(events.every((e) => e.kind === 'digital-products'));
  assert.equal(events.find((e) => e.id === 'gumroad:sale_d')?.simulated, true);
  assert.equal(events.find((e) => e.id === 'gumroad:sale_a')?.simulated, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /sale_c.*GBP/);
});

test('GumroadSource uses after=YYYY-MM-DD and paginates via page_key', async () => {
  const { fetchImpl, calls } = fixtureFetch([
    { match: (u) => u.includes('page_key=page-2'), body: page2 },
    { match: (u) => u.startsWith('https://api.gumroad.com/v2/sales?'), body: page1 },
  ]);
  const src = new GumroadSource({ accessToken: 'tok', fetchImpl, log: silentLogger });
  const events = await src.collect(new Date('2026-09-20T05:00:00Z'));
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('after=2026-09-19'));
  assert.ok(calls[0].includes('access_token=tok'));
  assert.equal(events.length, 5);
});

test('GumroadSource throws on success:false so the engine can degrade', async () => {
  const { fetchImpl } = fixtureFetch([{ match: () => true, body: { success: false, message: 'invalid token' } }]);
  await assert.rejects(new GumroadSource({ accessToken: 'x', fetchImpl, log: silentLogger }).collect(new Date()), /invalid token/);
  assert.equal(GumroadSource.fromEnv({}), undefined);
});
