import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle, PoolInfo } from '../geckoterminal.js';
import { GeckoTerminalClient } from '../geckoterminal.js';
import type { FetchLike } from '../http.js';
import { Rng } from '../rng.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadGeckoFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'geckoterminal', name), 'utf8'));
}

/** End of the generated test history (unix s, multiple of 300). */
export const GEN_END = 1_790_000_100 - (1_790_000_100 % 300);
export const STEP = 300;

export type GenPool = { pool: PoolInfo; candles: Candle[] };

/**
 * Deterministic generated pool histories (TEST DATA, not market data): a trending
 * token, a choppy one, one that rugs, and a young one. ~`days` of 5-minute candles
 * with random gaps (no-trade buckets are omitted, like GeckoTerminal does).
 */
export function generatePools(days = 3, seed = 'gecko-test'): GenPool[] {
  const rng = new Rng(seed);
  const n = Math.floor((days * 86_400) / STEP);
  const start = GEN_END - n * STEP;
  const specs = [
    { sym: 'UPP', drift: 0.0012, vol: 0.01, rugAt: -1, startFrac: 0, reserve: 400_000 },
    { sym: 'CHP', drift: 0, vol: 0.02, rugAt: -1, startFrac: 0, reserve: 150_000 },
    { sym: 'RUG', drift: 0.0005, vol: 0.015, rugAt: Math.floor(n * 0.6), startFrac: 0, reserve: 80_000 },
    { sym: 'NEW', drift: 0.0008, vol: 0.03, rugAt: -1, startFrac: 0.5, reserve: 60_000 },
  ];
  return specs.map((s, k) => {
    const candles: Candle[] = [];
    let p = 0.01 * (k + 1);
    const first = Math.floor(n * s.startFrac);
    for (let i = first; i < n; i++) {
      const o = p;
      let r = s.drift + s.vol * rng.normal();
      if (i === s.rugAt) r = Math.log(0.05);
      p = Math.max(1e-9, p * Math.exp(r));
      if (rng.chance(0.08) && i !== s.rugAt) continue; // no trades in this bucket
      const v = Math.round(1_000 + rng.next() * 20_000);
      candles.push({ t: start + i * STEP, o, h: Math.max(o, p) * 1.002, l: Math.min(o, p) * 0.998, c: p, v });
    }
    const createdAtMs = (start + first * STEP) * 1000 - 3_600_000;
    const pool: PoolInfo = {
      address: `Pool${s.sym}${'x'.repeat(30)}`,
      name: `${s.sym} / SOL`,
      symbol: s.sym,
      baseTokenAddress: `Mint${s.sym}${'y'.repeat(30)}`,
      dexId: 'raydium',
      baseTokenPriceUsd: candles.at(-1)!.c,
      reserveUsd: s.reserve,
      fdvUsd: s.reserve * 10,
      volume24hUsd: 0,
      createdAtMs,
      priceChange: {},
      buys24h: 0,
      sells24h: 0,
    };
    return { pool, candles };
  });
}

function poolJson(p: PoolInfo) {
  return {
    id: `solana_${p.address}`,
    type: 'pool',
    attributes: {
      address: p.address,
      name: p.name,
      base_token_price_usd: String(p.baseTokenPriceUsd),
      reserve_in_usd: String(p.reserveUsd),
      fdv_usd: String(p.fdvUsd),
      pool_created_at: Number.isFinite(p.createdAtMs) ? new Date(p.createdAtMs).toISOString() : null,
      volume_usd: { h24: '0' },
      price_change_percentage: {},
      transactions: { h24: { buys: 0, sells: 0 } },
    },
    relationships: { base_token: { data: { id: `solana_${p.baseTokenAddress}` } }, dex: { data: { id: p.dexId } } },
  };
}

/** Fake GeckoTerminal API over generated pools (2 per trending page, the rest on /pools). Records URLs. */
export function geckoFetch(pools: GenPool[], opts: { failAll?: boolean } = {}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (opts.failAll) return new Response('down', { status: 503 });
    const u = new URL(url);
    const page = Number(u.searchParams.get('page') ?? '1');
    if (u.pathname.endsWith('/networks/solana/trending_pools')) {
      return Response.json({ data: (page === 1 ? pools.slice(0, 2) : []).map((g) => poolJson(g.pool)) });
    }
    if (u.pathname.endsWith('/networks/solana/pools')) {
      return Response.json({ data: page === 1 ? pools.slice(2).map((g) => poolJson(g.pool)) : [] });
    }
    const m = /\/pools\/([^/]+)\/ohlcv\/(minute|hour|day)$/.exec(u.pathname);
    if (m) {
      const g = pools.find((x) => x.pool.address === m[1]);
      if (!g) return new Response('not found', { status: 404 });
      const before = Number(u.searchParams.get('before_timestamp') ?? Number.MAX_SAFE_INTEGER);
      const limit = Number(u.searchParams.get('limit') ?? '100');
      const rows = g.candles
        .filter((c) => c.t < before)
        .slice(-limit)
        .reverse()
        .map((c) => [c.t, c.o, c.h, c.l, c.c, c.v]);
      return Response.json({ data: { attributes: { ohlcv_list: rows } } });
    }
    return new Response('not found', { status: 404 });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/** A client with no throttle delay and no retry sleeps (tests). */
export function fastClient(fetchImpl: FetchLike): GeckoTerminalClient {
  return new GeckoTerminalClient({ fetchImpl, minIntervalMs: 0, retries: 0, sleep: async () => undefined, log: () => undefined });
}
