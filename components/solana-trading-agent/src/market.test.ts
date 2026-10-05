import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DexScreenerSource, normalizePair } from './market.js';
import { fetchJson } from './http.js';
import { FIXTURE_NOW, MINTS, fixtureFetch } from './testing/fixtures.js';

const now = () => FIXTURE_NOW.getTime();

test('discover: keeps only solana profiles, dedupes, normalizes best pair', async () => {
  const fetchImpl = fixtureFetch();
  const source = new DexScreenerSource({ fetchImpl, now, retries: 0 });
  const tokens = await source.discover(30);
  assert.deepEqual(tokens.map((t) => t.mint), [MINTS.GOOD1, MINTS.GOOD2, MINTS.NEWB, MINTS.THIN, MINTS.DUMP]);
  const good1 = tokens[0]!;
  assert.equal(good1.pairAddress, 'GOOD1Pair', 'deepest-liquidity pair wins');
  assert.equal(good1.priceUsd, 0.0125);
  assert.equal(good1.liquidityUsd, 400_000);
  assert.equal(good1.volume24hUsd, 1_500_000);
  assert.equal(good1.marketCapUsd, 5_000_000);
  assert.equal(good1.buys24h, 3000);
  assert.equal(good1.sells24h, 2400);
  assert.ok(Math.abs(good1.ageHours - 200) < 1e-9);
  assert.ok(!fetchImpl.calls.some((u) => u.includes('0xabc')), 'non-solana token never requested');
});

test('discover respects limit', async () => {
  const source = new DexScreenerSource({ fetchImpl: fixtureFetch(), now, retries: 0 });
  assert.equal((await source.discover(2)).length, 2);
});

test('API failure degrades to empty results', async () => {
  const source = new DexScreenerSource({ fetchImpl: fixtureFetch({ fail: true }), now, retries: 1, backoffMs: 1 });
  assert.deepEqual(await source.discover(10), []);
  assert.equal((await source.getTokens([MINTS.GOOD1])).size, 0);
});

test('normalizePair: marketCap falls back to fdv; rejects non-solana / no price', () => {
  const base = { chainId: 'solana', pairAddress: 'P', baseToken: { address: 'M', symbol: 'S' }, priceUsd: '2', fdv: 123 };
  assert.equal(normalizePair(base)!.marketCapUsd, 123);
  assert.ok(Number.isNaN(normalizePair(base)!.ageHours));
  assert.equal(normalizePair({ ...base, chainId: 'bsc' }), undefined);
  assert.equal(normalizePair({ ...base, priceUsd: '0' }), undefined);
});

test('fetchJson retries 5xx then succeeds, does not retry 404', async () => {
  let n = 0;
  const flaky = async () => (++n < 3 ? new Response('x', { status: 502 }) : Response.json({ ok: true }));
  assert.deepEqual(await fetchJson('http://x', { fetchImpl: flaky, retries: 2, backoffMs: 1 }), { ok: true });
  assert.equal(n, 3);
  let m = 0;
  const missing = async () => {
    m++;
    return new Response('x', { status: 404 });
  };
  await assert.rejects(fetchJson('http://x', { fetchImpl: missing, retries: 3, backoffMs: 1 }));
  assert.equal(m, 1);
});
