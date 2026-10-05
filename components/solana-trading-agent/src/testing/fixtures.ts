import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../http.js';
import { readConfig, type AppConfig } from '../config.js';
import type { Token } from '../market.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const FIXTURE_NOW = new Date('2026-10-01T00:00:00Z');

export const MINTS = {
  GOOD1: 'GooD1111111111111111111111111111111111111pump',
  GOOD2: 'GooD2222222222222222222222222222222222222pump',
  NEWB: 'NewB3333333333333333333333333333333333333pump',
  THIN: 'Thin4444444444444444444444444444444444444pump',
  DUMP: 'Dump5555555555555555555555555555555555555pump',
};

export function loadFixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, 'fixtures', name), 'utf8')) as T;
}

type Pair = { baseToken: { address: string }; priceUsd: string };

/**
 * Fake fetch serving DexScreener fixtures. `prices` overrides priceUsd per mint so tests can move the market.
 * `calls` records requested URLs.
 */
export function fixtureFetch(opts: { prices?: Record<string, number>; fail?: boolean } = {}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (opts.fail) return new Response('down', { status: 503 });
    if (url.endsWith('/token-profiles/latest/v1')) return Response.json(loadFixture('dexscreener-token-profiles.json'));
    const m = /\/latest\/dex\/tokens\/(.+)$/.exec(url);
    if (m) {
      const wanted = new Set(m[1]!.split(','));
      const data = loadFixture<{ pairs: Pair[] }>('dexscreener-tokens.json');
      const pairs = data.pairs
        .filter((p) => wanted.has(p.baseToken.address))
        .map((p) => {
          const override = opts.prices?.[p.baseToken.address];
          return override === undefined ? p : { ...p, priceUsd: String(override) };
        });
      return Response.json({ schemaVersion: '1.0.0', pairs });
    }
    return new Response('not found', { status: 404 });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return readConfig({ ...env }, []);
}

export function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    mint: 'Mint1111111111111111111111111111111111111111',
    symbol: 'TEST',
    name: 'Test Token',
    pairAddress: 'Pair1',
    dexId: 'raydium',
    priceUsd: 1,
    liquidityUsd: 400_000,
    volume24hUsd: 1_500_000,
    marketCapUsd: 5_000_000,
    ageHours: 200,
    buys24h: 3000,
    sells24h: 2400,
    ...overrides,
  };
}
