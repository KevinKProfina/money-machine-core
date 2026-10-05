import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StripeSource, mapStripeTransactions, type StripeBalanceTransaction } from './sources/stripe.js';
import { fixture, fixtureFetch } from './test-utils.js';
import { type Logger, silentLogger } from './types.js';

const page1 = fixture('stripe-page1.json') as { data: StripeBalanceTransaction[] };
const page2 = fixture('stripe-page2.json') as { data: StripeBalanceTransaction[] };

test('mapping: charge + fee, refund, stripe_fee, payment; payout skipped; non-USD skipped with warning', () => {
  const warnings: string[] = [];
  const log: Logger = { ...silentLogger, warn: (m) => warnings.push(m) };
  const events = mapStripeTransactions([...page1.data, ...page2.data], { stream: 'stripe', kind: 'saas', testMode: false, log });
  const byId = Object.fromEntries(events.map((e) => [e.id, e.amountUsd]));
  assert.deepEqual(byId, {
    'stripe:txn_1': 49,
    'stripe:txn_1:fee': -1.72,
    'stripe:txn_2': -49,
    'stripe:txn_4': -1.5,
    'stripe:txn_6': 10,
    'stripe:txn_6:fee': -0.59,
  });
  assert.ok(events.every((e) => e.kind === 'saas' && e.source === 'stripe' && !e.simulated));
  assert.equal(events[0].timestamp, new Date(1790000000 * 1000).toISOString());
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /txn_3.*EUR/);
});

test('StripeSource paginates with created[gte] + starting_after, bearer auth, test keys = simulated', async () => {
  const { fetchImpl, calls } = fixtureFetch([
    { match: (u) => u.includes('starting_after=txn_3'), body: page2 },
    { match: (u) => u.startsWith('https://api.stripe.com/v1/balance_transactions?'), body: page1 },
  ]);
  const headersSeen: string[] = [];
  const src = new StripeSource({
    apiKey: 'sk_test_123',
    kind: 'ai-services',
    fetchImpl: async (url, init) => {
      headersSeen.push(init?.headers?.Authorization ?? '');
      return fetchImpl(url, init);
    },
    log: silentLogger,
  });
  const since = new Date('2026-09-01T00:00:00Z');
  const events = await src.collect(since);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes(`created%5Bgte%5D=${Math.floor(since.getTime() / 1000)}`));
  assert.ok(calls[1].includes('starting_after=txn_3'));
  assert.deepEqual(headersSeen, ['Bearer sk_test_123', 'Bearer sk_test_123']);
  assert.equal(events.length, 6);
  assert.ok(events.every((e) => e.simulated && e.kind === 'ai-services'));
});

test('StripeSource retries 5xx then succeeds; 401 throws without retry', async () => {
  let n = 0;
  const flaky = new StripeSource({
    apiKey: 'sk_live_x',
    retry: { backoffMs: 1 },
    log: silentLogger,
    fetchImpl: async () => {
      n++;
      const body = n < 3 ? { error: 'boom' } : { data: [page1.data[0]], has_more: false };
      const status = n < 3 ? 503 : 200;
      return { ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) };
    },
  });
  const events = await flaky.collect(new Date());
  assert.equal(n, 3);
  assert.equal(events.length, 2);
  assert.equal(events[0].simulated, false);

  const { fetchImpl, calls } = fixtureFetch([{ match: () => true, status: 401, body: { error: 'bad key' } }]);
  const unauthorized = new StripeSource({ apiKey: 'sk_live_bad', fetchImpl, retry: { backoffMs: 1 }, log: silentLogger });
  await assert.rejects(unauthorized.collect(new Date()), /HTTP 401/);
  assert.equal(calls.length, 1);
});

test('fromEnv: disabled without key, invalid kind falls back to saas', () => {
  assert.equal(StripeSource.fromEnv({}, silentLogger), undefined);
  assert.equal(StripeSource.fromEnv({ STRIPE_API_KEY: 'sk', STRIPE_STREAM_KIND: 'nope' }, silentLogger)?.kind, 'saas');
  assert.equal(StripeSource.fromEnv({ STRIPE_API_KEY: 'sk', STRIPE_STREAM_KIND: 'affiliate' }, silentLogger)?.kind, 'affiliate');
});
