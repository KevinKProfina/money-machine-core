import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGenome, walkForwardSplits, type StepRecord } from './backtest.js';
import type { Candle, PoolInfo } from './geckoterminal.js';
import { lastIndexAtOrBefore, prepareSeries, ReplayMarket, replayTimeline, snapshotAt } from './replay-market.js';
import { easyGenome, testConfig } from './testing/helpers.js';
import { generatePools, GEN_END, STEP } from './testing/gecko.js';

function pool(overrides: Partial<PoolInfo> = {}): PoolInfo {
  return {
    address: 'PoolT',
    name: 'TT / SOL',
    symbol: 'TT',
    baseTokenAddress: 'MintT',
    dexId: 'raydium',
    baseTokenPriceUsd: 2,
    reserveUsd: 100_000,
    fdvUsd: 1_000_000,
    volume24hUsd: 0,
    createdAtMs: 0,
    priceChange: {},
    buys24h: 0,
    sells24h: 0,
    ...overrides,
  };
}

const T0 = 1_800_000_000 - (1_800_000_000 % 300);

/** 300 candles, price 1 → linearly up, volume 100 each, every 3rd candle down. */
function linear(n = 300): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 1 + i * 0.01;
    const o = i % 3 === 2 ? c + 0.005 : c - 0.005;
    return { t: T0 + i * STEP, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 100 };
  });
}

test('lastIndexAtOrBefore / timeline basics', () => {
  assert.equal(lastIndexAtOrBefore([1, 3, 5], 0), -1);
  assert.equal(lastIndexAtOrBefore([1, 3, 5], 3), 1);
  assert.equal(lastIndexAtOrBefore([1, 3, 5], 9), 2);
  assert.deepEqual(replayTimeline(0, 1000, 300), [300, 600, 900]);
});

test('snapshot derivation: price, m5/h1/h24 changes, 24h volume, proxies, age', () => {
  const candles = linear(300);
  const prepared = prepareSeries([{ pool: pool({ createdAtMs: (T0 - 7200) * 1000 }), candles }], STEP);
  // T = close of candle 299 → all 300 candles known
  const T = T0 + 300 * STEP;
  const { tokens, candidates } = snapshotAt(prepared, T, { stepSec: STEP, fromTs: T0, toTs: T });
  const t = tokens.get('MintT')!;
  assert.equal(candidates.length, 1);
  assert.equal(t.priceUsd, candles[299]!.c);
  assert.equal(t.pairAddress, 'PoolT');
  // m5: vs close of candle 298; h1: vs candle 287; h24: vs candle 11 (24h = 288 steps)
  assert.ok(Math.abs(t.priceChange.m5! - (candles[299]!.c / candles[298]!.c - 1) * 100) < 1e-9);
  assert.ok(Math.abs(t.priceChange.h1! - (candles[299]!.c / candles[287]!.c - 1) * 100) < 1e-9);
  assert.ok(Math.abs(t.priceChange.h24! - (candles[299]!.c / candles[11]!.c - 1) * 100) < 1e-9);
  assert.equal(t.volume24hUsd, 288 * 100, 'only candles closed in (T−24h, T]');
  // 24h window = candles 12..299: 96 down candles (i%3==2)
  assert.equal(t.sells24h, 96);
  assert.equal(t.buys24h, 192);
  assert.ok(Math.abs(t.liquidityUsd - 100_000 * Math.sqrt(t.priceUsd / 2)) < 1e-6);
  assert.ok(Math.abs(t.marketCapUsd - 1_000_000 * (t.priceUsd / 2)) < 1e-6);
  assert.ok(Math.abs(t.ageHours - (T - (T0 - 7200)) / 3600) < 1e-9);

  // early in the history: no h24 (and no h1) reference exists yet
  const early = snapshotAt(prepared, T0 + 3 * STEP, { stepSec: STEP, fromTs: T0, toTs: T }).tokens.get('MintT')!;
  assert.equal(early.priceChange.h24, undefined);
  assert.equal(early.priceChange.h1, undefined);
  assert.notEqual(early.priceChange.m5, undefined);
  // 15-minute steps: m5 is not derivable
  const p15 = prepareSeries([{ pool: pool(), candles }], 900);
  assert.equal(snapshotAt(p15, T0 + 100 * 900, { stepSec: 900, fromTs: T0, toTs: T }).tokens.get('MintT')!.priceChange.m5, undefined);
});

test('stale pools: not a candidate after 1h without candles, unpriced after 24h; unknown age = NaN', () => {
  const candles = linear(10);
  const prepared = prepareSeries([{ pool: pool({ createdAtMs: Number.NaN }), candles }], STEP);
  const last = T0 + 10 * STEP;
  const opts = { stepSec: STEP, fromTs: T0, toTs: last + 2 * 86_400 };
  assert.equal(snapshotAt(prepared, last + 3600, opts).candidates.length, 1);
  assert.ok(Number.isNaN(snapshotAt(prepared, last, opts).tokens.get('MintT')!.ageHours));
  const stale = snapshotAt(prepared, last + 3600 + STEP, opts);
  assert.equal(stale.candidates.length, 0);
  assert.equal(stale.tokens.size, 1, 'still priced for held positions');
  assert.equal(snapshotAt(prepared, last + 86_400 + STEP, opts).tokens.size, 0);
});

test('NO LOOKAHEAD: snapshot at T is unchanged when every candle not closed by T is rewritten', () => {
  const candles = linear(300);
  const T = T0 + 150 * STEP; // candles 0..149 are closed; candle 150 opens at T
  const future = candles.map((c, i) => (i >= 150 ? { ...c, o: 999, h: 999, l: 999, c: 999, v: 1e9 } : c));
  const truncated = candles.slice(0, 150);
  const opts = { stepSec: STEP, fromTs: T0, toTs: T0 + 300 * STEP };
  const a = snapshotAt(prepareSeries([{ pool: pool(), candles }], STEP), T, opts);
  const b = snapshotAt(prepareSeries([{ pool: pool(), candles: future }], STEP), T, opts);
  const c = snapshotAt(prepareSeries([{ pool: pool(), candles: truncated }], STEP), T, opts);
  assert.deepEqual(a.tokens.get('MintT'), b.tokens.get('MintT'));
  assert.deepEqual(a.tokens.get('MintT'), c.tokens.get('MintT'));
  assert.equal(a.tokens.get('MintT')!.priceUsd, candles[149]!.c, 'the candle opening at T is not visible yet');
});

test('NO LOOKAHEAD end-to-end: every decision up to step k is identical with the future cut off', async () => {
  const gen = generatePools(3);
  const fromTs = GEN_END - 2 * 86_400;
  const k = 300; // steps
  const cutT = fromTs + k * STEP;
  const genome = easyGenome({ minLiquidityUsd: 1_000, minVolume24hUsd: 1_000, takeProfitPct: 8, stopLossPct: 6, maxHoldCycles: 40, maxOpenPositions: 2, positionPct: 0.3 });
  const cfg = testConfig();
  const run = async (series: typeof gen) => {
    const steps: StepRecord[] = [];
    await evaluateGenome(genome, series, { fromTs, toTs: GEN_END }, { cfg, stepSec: STEP, capitalUsd: 100, onStep: (r) => steps.push(r) });
    return steps.filter((s) => s.T <= cutT);
  };
  const full = await run(gen);
  // future candles replaced by garbage (a moonshot then a rug)
  const poisoned = gen.map((g) => ({ ...g, candles: g.candles.map((c) => (c.t + STEP > cutT ? { ...c, o: c.o * 50, h: c.h * 50, l: c.l * 50, c: c.c * 50, v: 1e9 } : c)) }));
  const cut = gen.map((g) => ({ ...g, candles: g.candles.filter((c) => c.t + STEP <= cutT) }));
  assert.equal(full.length, k);
  assert.ok(full.some((s) => s.positions.length > 0), 'the genome traded before the cut');
  assert.deepEqual(await run(poisoned), full);
  assert.deepEqual(await run(cut), full);
});

test('walk-forward splits: ordered, non-overlapping, test after train, expanding train', () => {
  const s1 = walkForwardSplits(0, 1000 * STEP, STEP);
  assert.equal(s1.length, 1);
  assert.equal(s1[0]!.train.fromTs, 0);
  assert.equal(s1[0]!.train.toTs, s1[0]!.test.fromTs);
  assert.equal(s1[0]!.test.toTs, 1000 * STEP);
  assert.equal(s1[0]!.test.toTs - s1[0]!.test.fromTs, 300 * STEP);

  const s3 = walkForwardSplits(0, 1000 * STEP, STEP, { folds: 3, trainFrac: 0.4 });
  assert.equal(s3.length, 3);
  for (let i = 0; i < 3; i++) {
    const s = s3[i]!;
    assert.equal(s.train.fromTs, 0);
    assert.equal(s.train.toTs, s.test.fromTs, 'no gap, no overlap');
    assert.ok(s.test.toTs > s.test.fromTs);
    if (i > 0) assert.equal(s.test.fromTs, s3[i - 1]!.test.toTs, 'test windows tile the tail');
  }
  assert.equal(s3[2]!.test.toTs, 1000 * STEP);
  assert.throws(() => walkForwardSplits(0, 5 * STEP, STEP, { folds: 3 }), /not enough history/);
  assert.throws(() => walkForwardSplits(0, 1000 * STEP, STEP, { trainFrac: 1 }), /trainFrac/);
});

test('ReplayMarket: one snapshot per step on the virtual clock, then exhausted', async () => {
  const m = new ReplayMarket([{ pool: pool(), candles: linear(20) }], { stepSec: STEP, fromTs: T0, toTs: T0 + 10 * STEP });
  assert.equal(m.steps, 10);
  const s1 = await m.snapshot([]);
  assert.equal(s1.source, 'replay');
  assert.equal(s1.fetchedAt, new Date((T0 + STEP) * 1000).toISOString());
  assert.equal(m.now().getTime(), (T0 + STEP) * 1000);
  assert.equal(s1.tokens.get('MintT')!.priceUsd, linear(1)[0]!.c);
  for (let i = 1; i < 10; i++) await m.snapshot([]);
  assert.ok(m.done);
  const over = await m.snapshot([]);
  assert.equal(over.ok, false);
});
