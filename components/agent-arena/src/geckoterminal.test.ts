import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeckoTerminalClient, mergeCandles, parseOhlcv, parsePools, Throttle } from './geckoterminal.js';
import type { FetchLike } from './http.js';
import { fastClient, generatePools, geckoFetch, GEN_END, loadGeckoFixture, STEP } from './testing/gecko.js';

test('parsePools: attributes, base token from relationships, dedupe-able fields, bad rows dropped', () => {
  const pools = parsePools(loadGeckoFixture('trending_pools.json'));
  assert.equal(pools.length, 3);
  const a = pools[0]!;
  assert.equal(a.address, 'PoolAAA111111111111111111111111111111111');
  assert.equal(a.baseTokenAddress, 'MintAAA11111111111111111111111111111pump');
  assert.equal(a.symbol, 'AAA');
  assert.equal(a.dexId, 'raydium');
  assert.equal(a.baseTokenPriceUsd, 0.00125);
  assert.equal(a.reserveUsd, 210000.75);
  assert.equal(a.fdvUsd, 1_250_000);
  assert.equal(a.volume24hUsd, 830000.5);
  assert.equal(a.createdAtMs, Date.parse('2026-09-20T12:00:00Z'));
  assert.deepEqual(a.priceChange, { m5: 1.2, h1: -3.5, h6: 10, h24: 45.1 });
  assert.equal(a.buys24h, 5400);
  assert.equal(a.sells24h, 4100);
  const b = pools[1]!;
  assert.ok(Number.isNaN(b.createdAtMs));
  assert.equal(b.fdvUsd, 9_000_000, 'falls back to market_cap_usd');
  assert.deepEqual(b.priceChange, { h24: -12 });
  assert.deepEqual(parsePools({}), []);
  assert.deepEqual(parsePools(null), []);
});

test('parseOhlcv: newest-first list → ascending, deduplicated, invalid rows dropped', () => {
  const c = parseOhlcv(loadGeckoFixture('ohlcv.json'));
  assert.deepEqual(
    c.map((x) => x.t),
    [1790000000, 1790000300, 1790000600],
  );
  assert.equal(c[0]!.v, 500.25);
  assert.equal(c[2]!.c, 1.15);
  assert.deepEqual(parseOhlcv({ data: {} }), []);
  const merged = mergeCandles(c, [{ t: 1790000600, o: 1, h: 1, l: 1, c: 9, v: 1 }]);
  assert.equal(merged.length, 3);
  assert.equal(merged.at(-1)!.c, 9, 'later list wins');
});

test('fetchOhlcv pages backwards with before_timestamp until the range start', async () => {
  const pools = generatePools(10); // 2880 steps → 3 pages of ≤1000
  const fetch = geckoFetch(pools);
  const client = fastClient(fetch);
  const g = pools[0]!;
  const fromTs = GEN_END - 10 * 86_400;
  const candles = await client.fetchOhlcv({ pool: g.pool.address, timeframe: 'minute', aggregate: 5, fromTs, toTs: GEN_END });
  assert.deepEqual(candles, g.candles.filter((c) => c.t >= fromTs && c.t < GEN_END));
  const befores = fetch.calls.map((u) => Number(new URL(u).searchParams.get('before_timestamp')));
  assert.equal(befores[0], GEN_END);
  assert.ok(fetch.calls.length >= 3);
  for (let i = 1; i < befores.length; i++) assert.ok(befores[i]! < befores[i - 1]!, 'strictly older pages');
  assert.ok(fetch.calls.every((u) => u.includes('aggregate=5') && u.includes('limit=1000') && u.includes('currency=usd') && u.includes('/ohlcv/minute')));

  // a narrow range stops after one page
  fetch.calls.length = 0;
  const few = await client.fetchOhlcv({ pool: g.pool.address, timeframe: 'minute', aggregate: 5, fromTs: GEN_END - 10 * STEP, toTs: GEN_END });
  assert.equal(fetch.calls.length, 1);
  assert.ok(few.length <= 10 && few.every((c) => c.t >= GEN_END - 10 * STEP));
});

test('throttle spaces requests ≥ minInterval apart (virtual clock)', async () => {
  let now = 1_000;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    now += ms;
  };
  const t = new Throttle(2_100, () => now, sleep);
  const stamps: number[] = [];
  for (let i = 0; i < 4; i++) {
    await t.wait();
    stamps.push(now);
  }
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i]! - stamps[i - 1]! >= 2_100);
  assert.equal(sleeps.length, 3);
  // concurrent callers are serialised too
  const both = [t.wait().then(() => now), t.wait().then(() => now)];
  const [a, b] = await Promise.all(both);
  assert.ok(b! - a! >= 2_100);
});

test('client: 429 is retried after Retry-After / backoff, 404 is not retried', async () => {
  const sleeps: number[] = [];
  let n = 0;
  const flaky: FetchLike = async () => {
    n++;
    if (n === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '7' } });
    if (n === 2) return new Response('oops', { status: 502 });
    return Response.json({ data: [] });
  };
  const client = new GeckoTerminalClient({ fetchImpl: flaky, minIntervalMs: 0, retries: 3, backoffMs: 100, sleep: async (ms) => void sleeps.push(ms), log: () => undefined });
  assert.deepEqual(await client.get('/x'), { data: [] });
  assert.equal(client.requests, 3);
  assert.deepEqual(sleeps.filter((s) => s > 0), [7_000, 200]);

  let m = 0;
  const missing = new GeckoTerminalClient({ fetchImpl: async () => (m++, new Response('no', { status: 404 })), minIntervalMs: 0, retries: 3, sleep: async () => undefined, log: () => undefined });
  await assert.rejects(missing.get('/y'), /HTTP 404/);
  assert.equal(m, 1);
});

test('discoverPools: trending first, then top pools; one pool per base token; total failure throws', async () => {
  const pools = generatePools(1);
  const client = fastClient(geckoFetch(pools));
  const found = await client.discoverPools(3);
  assert.deepEqual(found.map((p) => p.symbol), ['UPP', 'CHP', 'RUG']);
  const all = await client.discoverPools(10);
  assert.equal(all.length, 4);
  const fromFixture = parsePools(loadGeckoFixture('trending_pools.json'));
  const fixtureClient = fastClient(async (url: string) => (url.includes('trending_pools') && url.endsWith('page=1') ? Response.json(loadGeckoFixture('trending_pools.json')) : Response.json({ data: [] })));
  const dedup = await fixtureClient.discoverPools(10);
  assert.equal(dedup.length, 2, 'AAA appears twice (two pools) → kept once');
  assert.equal(dedup.find((p) => p.symbol === 'AAA')!.reserveUsd, fromFixture[0]!.reserveUsd, 'deepest pool wins');
  await assert.rejects(fastClient(geckoFetch(pools, { failAll: true })).discoverPools(5), /discovery requests failed/);
});
