import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DexScreenerSource, normalizePair, type DexPair } from './dexscreener.js';
import type { FetchLike } from './http.js';

const NOW = Date.parse('2026-03-01T00:00:00Z');

function pair(mint: string, o: Partial<DexPair> = {}): DexPair {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress: `${mint}-pair`,
    baseToken: { address: mint, symbol: mint.toUpperCase(), name: mint },
    priceUsd: '1.5',
    liquidity: { usd: 100_000 },
    volume: { h24: 500_000 },
    priceChange: { m5: 0.5, h1: '3.2', h24: -10 },
    txns: { h24: { buys: 100, sells: 80 } },
    marketCap: 1_000_000,
    pairCreatedAt: NOW - 48 * 3_600_000,
    ...o,
  };
}

function fixtureFetch(opts: { discoveryFails?: boolean; tokensFail?: boolean; pairs?: DexPair[] } = {}) {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    urls.push(url);
    if (url.includes('/token-profiles/') || url.includes('/token-boosts/')) {
      if (opts.discoveryFails) return new Response('down', { status: 503 });
      return Response.json([{ chainId: 'solana', tokenAddress: 'aaa' }, { chainId: 'ethereum', tokenAddress: 'eth' }, { chainId: 'solana', tokenAddress: 'bbb' }]);
    }
    if (url.includes('/latest/dex/tokens/')) {
      if (opts.tokensFail) return new Response('down', { status: 500 });
      const mints = url.split('/').pop()!.split(',');
      const all = opts.pairs ?? [pair('aaa'), pair('aaa', { pairAddress: 'deeper', liquidity: { usd: 900_000 } }), pair('bbb'), pair('held')];
      return Response.json({ pairs: all.filter((p) => mints.includes(p.baseToken!.address!)) });
    }
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, urls };
}

test('normalizePair keeps price changes when present', () => {
  const t = normalizePair(pair('x'), NOW)!;
  assert.deepEqual(t.priceChange, { m5: 0.5, h1: 3.2, h24: -10 });
  assert.equal(t.ageHours, 48);
  const bare = normalizePair(pair('y', { priceChange: undefined, pairCreatedAt: undefined }), NOW)!;
  assert.deepEqual(bare.priceChange, {});
  assert.ok(Number.isNaN(bare.ageHours));
  assert.equal(normalizePair(pair('z', { chainId: 'base' }), NOW), undefined);
  assert.equal(normalizePair(pair('z', { priceUsd: '0' }), NOW), undefined);
});

test('snapshot: discovery + held mints looked up, deepest pair wins', async () => {
  const { fetchImpl, urls } = fixtureFetch();
  const src = new DexScreenerSource({ fetchImpl, retries: 0, now: () => NOW, log: () => {} });
  const snap = await src.snapshot(['held']);
  assert.equal(snap.ok, true);
  assert.deepEqual(snap.candidates.map((t) => t.mint), ['aaa', 'bbb']);
  assert.equal(snap.tokens.get('aaa')!.pairAddress, 'deeper');
  assert.ok(snap.tokens.has('held'), 'held mint priced even though not discovered');
  assert.ok(urls.some((u) => u.includes('held')));
});

test('snapshot: discovery failure → not ok (no entries) but held mints still priced', async () => {
  const { fetchImpl } = fixtureFetch({ discoveryFails: true });
  const snap = await new DexScreenerSource({ fetchImpl, retries: 0, now: () => NOW, log: () => {} }).snapshot(['held']);
  assert.equal(snap.ok, false);
  assert.equal(snap.candidates.length, 0);
  assert.ok(snap.tokens.has('held'));
});

test('snapshot: token lookups all failing → not ok; retries with backoff', async () => {
  const { fetchImpl, urls } = fixtureFetch({ tokensFail: true });
  const snap = await new DexScreenerSource({ fetchImpl, retries: 2, backoffMs: 1, now: () => NOW, log: () => {} }).snapshot([]);
  assert.equal(snap.ok, false);
  assert.equal(urls.filter((u) => u.includes('/latest/dex/tokens/')).length, 3);
});

test('snapshot: network errors never throw', async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error('ENOTFOUND');
  };
  const snap = await new DexScreenerSource({ fetchImpl, retries: 0, log: () => {} }).snapshot(['x']);
  assert.equal(snap.ok, false);
});
