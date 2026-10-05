import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { historyPath, loadDataset, loadPoolHistory, poolIndexPath, readCachedHistory } from './history.js';
import { fastClient, generatePools, geckoFetch, GEN_END, STEP } from './testing/gecko.js';
import { tempStateDir } from './testing/helpers.js';

beforeEach(() => {
  tempStateDir();
});

test('candle cache: path layout, second load makes no request, only missing edges are fetched', async () => {
  const pools = generatePools(4);
  const fetch = geckoFetch(pools);
  const client = fastClient(fetch);
  const g = pools[0]!;
  const p = historyPath(g.pool.address, 'minute', 5);
  assert.ok(p.endsWith(path.join('arena', 'history', `${g.pool.address}-minute5.json`)));

  const req = { timeframe: 'minute' as const, aggregate: 5, fromTs: GEN_END - 2 * 86_400, toTs: GEN_END - 86_400, nowSec: GEN_END + 10 };
  const h1 = await loadPoolHistory(client, g.pool, req);
  assert.ok(h1 && h1.candles.length > 200);
  assert.ok(fs.existsSync(p));
  const first = fetch.calls.length;
  assert.ok(first >= 1);

  const h2 = await loadPoolHistory(client, g.pool, req);
  assert.equal(fetch.calls.length, first, 'served from cache');
  assert.deepEqual(h2!.candles, h1!.candles);

  // extend both edges → exactly the two missing ranges are requested
  const h3 = await loadPoolHistory(client, g.pool, { ...req, fromTs: GEN_END - 3 * 86_400, toTs: GEN_END });
  const newCalls = fetch.calls.slice(first).map((u) => Number(new URL(u).searchParams.get('before_timestamp')));
  assert.deepEqual(newCalls, [req.fromTs, GEN_END]);
  assert.equal(h3!.coveredFromTs, GEN_END - 3 * 86_400);
  assert.equal(h3!.coveredToTs, GEN_END);
  assert.deepEqual(h3!.candles, g.candles.filter((c) => c.t >= GEN_END - 3 * 86_400 && c.t + STEP <= GEN_END));
  const cached = await readCachedHistory(g.pool.address, 'minute', 5);
  assert.equal(cached!.candles.length, h3!.candles.length);
});

test('candle cache: the still-open candle is never cached; offline uses cache only', async () => {
  const pools = generatePools(1);
  const g = pools[0]!;
  const client = fastClient(geckoFetch(pools));
  // wall clock in the middle of the last bucket → that bucket is excluded
  const h = await loadPoolHistory(client, g.pool, { timeframe: 'minute', aggregate: 5, fromTs: GEN_END - 86_400, toTs: GEN_END + STEP, nowSec: GEN_END + 100 });
  assert.ok(h!.candles.every((c) => c.t + STEP <= GEN_END + 100));
  assert.equal(h!.coveredToTs, GEN_END);

  const offlineMiss = await loadPoolHistory(undefined, pools[1]!.pool, { timeframe: 'minute', aggregate: 5, fromTs: 0, toTs: GEN_END, offline: true, nowSec: GEN_END });
  assert.equal(offlineMiss, undefined);
  const offlineHit = await loadPoolHistory(undefined, g.pool, { timeframe: 'minute', aggregate: 5, fromTs: 0, toTs: GEN_END, offline: true, nowSec: GEN_END });
  assert.deepEqual(offlineHit!.candles, h!.candles);
});

test('loadDataset: discovery + pool index; offline rerun uses the cached index and ends where the cache ends', async () => {
  const pools = generatePools(3);
  const fetch = geckoFetch(pools);
  const ds = await loadDataset(fastClient(fetch), { pools: 4, days: 2, timeframe: 'minute', aggregate: 5, nowSec: GEN_END });
  assert.equal(ds.histories.length, 4);
  assert.equal(ds.stepSec, 300);
  assert.equal(ds.toTs - ds.fromTs, 2 * 86_400);
  assert.ok(fs.existsSync(poolIndexPath()));

  const later = await loadDataset(undefined, { pools: 4, days: 2, timeframe: 'minute', aggregate: 5, offline: true, nowSec: GEN_END + 7 * 86_400 });
  assert.equal(later.histories.length, 4);
  assert.equal(later.toTs, ds.toTs, 'offline window ends at the cached data');

  // discovery down → cached index; histories from cache, no candle requests
  const down = geckoFetch(pools, { failAll: true });
  const fallback = await loadDataset(fastClient(down), { pools: 4, days: 2, timeframe: 'minute', aggregate: 5, nowSec: GEN_END });
  assert.equal(fallback.histories.length, 4);
  assert.ok(down.calls.every((u) => !u.includes('/ohlcv/')));
});
