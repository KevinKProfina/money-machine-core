import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Arena, createGenesisState, type ArenaDeps } from '../arena.js';
import { readConfig, type ArenaConfig } from '../config.js';
import type { MarketSnapshot, MarketSource, Token } from '../market.js';
import type { MMEvent } from '../mm-contract.js';
import type { Genome } from '../genome.js';
import { traderSpecies } from '../species/trader.js';

export function tempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-arena-test-'));
  process.env.MM_STATE_DIR = dir;
  delete process.env.MM_KILL;
  return dir;
}

export function testConfig(env: Record<string, string> = {}): ArenaConfig {
  return readConfig({ ARENA_MARKET: 'synthetic', ARENA_SEED: 'test', ...env });
}

export function token(mint: string, overrides: Partial<Token> = {}): Token {
  return {
    mint,
    symbol: mint.toUpperCase(),
    name: mint,
    pairAddress: `${mint}-pair`,
    dexId: 'test',
    priceUsd: 1,
    liquidityUsd: 1_000_000,
    volume24hUsd: 2_000_000,
    marketCapUsd: 10_000_000,
    ageHours: 100,
    buys24h: 1200,
    sells24h: 1000,
    priceChange: { m5: 1, h1: 5, h24: 10 },
    ...overrides,
  };
}

/** Controllable market: set `tokens`/`ok` between cycles. */
export class FakeMarket implements MarketSource {
  readonly id = 'synthetic' as const;
  ok = true;
  tokens = new Map<string, Token>();
  candidates?: Token[];
  calls: string[][] = [];
  set(...tokens: Token[]) {
    this.tokens = new Map(tokens.map((t) => [t.mint, t]));
  }
  price(mint: string, priceUsd: number) {
    const t = this.tokens.get(mint);
    if (t) this.tokens.set(mint, { ...t, priceUsd });
  }
  async snapshot(held: string[]): Promise<MarketSnapshot> {
    this.calls.push(held);
    if (!this.ok) return { source: 'synthetic', ok: false, error: 'fake outage', fetchedAt: new Date().toISOString(), candidates: [], tokens: new Map() };
    return { source: 'synthetic', ok: true, fetchedAt: new Date().toISOString(), candidates: this.candidates ?? [...this.tokens.values()], tokens: new Map(this.tokens) };
  }
}

/** A permissive genome that buys any test token and has wide exits. */
export function easyGenome(overrides: Partial<Genome> = {}): Genome {
  const g = traderSpecies.validate(
    {
      minLiquidityUsd: 1000,
      minVolume24hUsd: 1000,
      minAgeHours: 0,
      maxAgeHours: 20000,
      minBuySellRatio: 0.2,
      minChangeM5: -20,
      minChangeH1: -50,
      maxChangeH1: 300,
      minChangeH24: -90,
      positionPct: 0.5,
      takeProfitPct: 50,
      stopLossPct: 30,
      trailingStopPct: 0,
      maxHoldCycles: 1000,
      maxOpenPositions: 1,
      cooldownCycles: 0,
      rankBy: 0,
      ...overrides,
    },
    {},
  ).genome;
  return g;
}

export function makeArena(cfg: ArenaConfig, market: MarketSource, extra: Partial<ArenaDeps> = {}) {
  const events: Array<Omit<MMEvent, 'ts'>> = [];
  const state = createGenesisState(cfg, new Date('2026-01-01T00:00:00Z'), cfg.seed ?? 'test');
  const arena = new Arena(cfg, state, undefined, {
    market,
    now: () => new Date('2026-01-01T00:00:00Z'),
    emit: async (e) => {
      events.push(e);
    },
    ...extra,
  });
  return { arena, state, events };
}
