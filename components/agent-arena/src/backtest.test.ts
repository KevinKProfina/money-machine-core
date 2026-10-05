import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { backtestGenome, combineMetrics, evaluateGenome, evolveOnWindow, walkForwardSplits, type BacktestMetrics } from './backtest.js';
import { runBacktest } from './backtest-cli.js';
import { genomeId } from './genome.js';
import { arenaPaths } from './state.js';
import { traderSpecies } from './species/trader.js';
import { Rng } from './rng.js';
import { easyGenome, tempStateDir, testConfig } from './testing/helpers.js';
import { fastClient, generatePools, geckoFetch, GEN_END, STEP } from './testing/gecko.js';

beforeEach(() => {
  tempStateDir();
});

const gen = generatePools(3);
const series = gen.map((g) => ({ pool: g.pool, candles: g.candles }));
const window = { fromTs: GEN_END - 2 * 86_400, toTs: GEN_END };

test('evaluateGenome: same input → identical result; metrics are sane and net of costs', async () => {
  const cfg = testConfig();
  const genome = easyGenome({ takeProfitPct: 10, stopLossPct: 8, maxHoldCycles: 50, positionPct: 0.3, maxOpenPositions: 2 });
  const a = await evaluateGenome(genome, series, window, { cfg, stepSec: STEP, capitalUsd: 100 });
  const b = await evaluateGenome(genome, series, window, { cfg, stepSec: STEP, capitalUsd: 100 });
  assert.deepEqual(a, b);
  assert.ok(a.trades > 0);
  assert.ok(a.winRate >= 0 && a.winRate <= 1);
  assert.ok(a.maxDrawdown >= 0 && a.maxDrawdown <= 1);
  assert.ok(a.exposure > 0 && a.exposure <= 1);
  assert.ok(a.timeInMarket >= a.exposure - 1e-9);
  assert.equal(a.steps, 2 * 288);
  // costs matter: with zero fees/slippage the same genome does strictly better
  const free = await evaluateGenome(genome, series, window, { cfg: testConfig({ ARENA_FEE_BPS: '0', ARENA_SLIPPAGE_BPS: '0' }), stepSec: STEP, capitalUsd: 100 });
  assert.ok(free.return > a.return);
});

test('a genome that never passes its filters does nothing and returns exactly 0', async () => {
  const picky = easyGenome({ minLiquidityUsd: 5_000_000 });
  const m = await evaluateGenome(picky, series, window, { cfg: testConfig(), stepSec: STEP, capitalUsd: 100 });
  assert.equal(m.trades, 0);
  assert.equal(m.return, 0);
  assert.equal(m.exposure, 0);
});

test('combineMetrics compounds returns and merges trade statistics', () => {
  const base: BacktestMetrics = { return: 0.1, trades: 2, wins: 1, winRate: 0.5, maxDrawdown: 0.1, sharpe: 0, exposure: 0.5, timeInMarket: 0.5, steps: 10, tradeMean: 0.05, tradeM2: 0.02 };
  const c = combineMetrics([base, { ...base, return: -0.1, maxDrawdown: 0.2, tradeMean: -0.05, exposure: 0.1, steps: 30 }])!;
  assert.ok(Math.abs(c.return - (1.1 * 0.9 - 1)) < 1e-12);
  assert.equal(c.trades, 4);
  assert.equal(c.maxDrawdown, 0.2);
  assert.ok(Math.abs(c.tradeMean) < 1e-12);
  assert.ok(Math.abs(c.exposure - (0.5 * 10 + 0.1 * 30) / 40) < 1e-12);
  assert.equal(combineMetrics([]), null);
});

test('backtestGenome: OOS only uses test windows after the training end', async () => {
  const splits = walkForwardSplits(window.fromTs, window.toTs, STEP, { folds: 2, trainFrac: 0.5 });
  const g = easyGenome({ takeProfitPct: 10, stopLossPct: 8 });
  const ext = await backtestGenome(g, 'test', series, splits, { cfg: testConfig(), stepSec: STEP, capitalUsd: 100 });
  assert.equal(ext.oosWindows, 2);
  assert.equal(ext.genomeId, genomeId(traderSpecies.validate(g, g).genome));
  const evolved = await backtestGenome(g, 'evolved', series, splits, { cfg: testConfig(), stepSec: STEP, capitalUsd: 100 }, splits[1]!.train.toTs, splits[1]!.train);
  assert.equal(evolved.oosWindows, 1);
  assert.equal(evolved.outOfSample!.steps, (splits[1]!.test.toTs - splits[1]!.test.fromTs) / STEP);
});

test('evolveOnWindow: full lifecycle on history is deterministic per seed', async () => {
  const cfg = testConfig({ ARENA_MIN_POPULATION: '15', ARENA_REPRO_MIN_AGE: '6', ARENA_REPRO_MULTIPLE: '1.2' });
  const w = { fromTs: GEN_END - 86_400, toTs: GEN_END };
  const a = await evolveOnWindow(series, w, { cfg, stepSec: STEP, seed: 's1', epochs: 2, top: 3 });
  const b = await evolveOnWindow(series, w, { cfg, stepSec: STEP, seed: 's1', epochs: 2, top: 3 });
  assert.deepEqual(a, b);
  assert.equal(a.cycles, 2 * 288);
  assert.ok(a.births >= 15);
  assert.ok(a.top.length <= 3);
  assert.equal(new Set(a.top.map((t) => genomeId(t.genome))).size, a.top.length);
});

test('CLI: backtest of genomes from a file → reports, results, cache; offline rerun is identical and makes no requests', async () => {
  const rng = new Rng(5);
  const genomes = [easyGenome({ takeProfitPct: 10, stopLossPct: 8 }), traderSpecies.randomGenome(rng)];
  const file = `${process.env.MM_STATE_DIR}/genomes.json`;
  fs.writeFileSync(file, JSON.stringify({ genomes }));
  const fetch = geckoFetch(gen);
  const client = fastClient(fetch);
  const events: string[] = [];
  const args = ['--pools', '4', '--days', '2', '--genomes', file, '--folds', '2', '--train-frac', '0.5'];
  const deps = { env: {}, client, nowSec: () => GEN_END + 60, log: () => undefined, emit: async (e: { type: string }) => void events.push(e.type) };
  const r1 = await runBacktest(args, deps);
  assert.equal(r1.report.schema, 'mm.arena-backtest/v1');
  assert.equal(r1.report.dataSource, 'geckoterminal');
  assert.equal(r1.report.results.length, 2);
  assert.equal(r1.report.pools.length, 4);
  assert.equal(r1.report.splits.length, 2);
  assert.ok(r1.report.notes.some((n) => n.includes('survivorship')));
  assert.ok(r1.text.includes('OUT-OF-SAMPLE'));
  assert.ok(fs.existsSync(arenaPaths.backtestLatest()));
  const results = JSON.parse(fs.readFileSync(arenaPaths.backtestResults(), 'utf8'));
  assert.equal(Object.keys(results.results).length, 2);
  const entry = results.results[r1.report.results[0]!.genomeId];
  assert.equal(entry.stepMinutes, 5);
  assert.equal(entry.dataSource, 'geckoterminal');
  assert.ok(entry.outOfSample);
  // promotions are re-evaluated (no live population → nothing promoted)
  assert.equal(r1.promotions.schema, 'mm.arena-promotions/v1');
  assert.equal(r1.promotions.promoted, undefined);
  assert.ok(fs.existsSync(arenaPaths.promotions()));
  assert.ok(fs.readdirSync(arenaPaths.historyDir()).some((f) => f.endsWith('-minute5.json')));

  const before = fetch.calls.length;
  const r2 = await runBacktest([...args, '--offline'], { ...deps, nowSec: () => GEN_END + 5 * 86_400 });
  assert.equal(fetch.calls.length, before, 'offline: no requests');
  assert.deepEqual(r2.report.results, r1.report.results, 'deterministic from cache');
});

test('CLI: --evolve pre-trains on history, writes pretrained.json; bad args and no data fail clearly', async () => {
  const client = fastClient(geckoFetch(gen));
  const deps = { env: { ARENA_MIN_POPULATION: '10' }, client, nowSec: () => GEN_END, log: () => undefined, emit: async () => undefined };
  const r = await runBacktest(['--pools', '4', '--days', '2', '--evolve', '--top', '2', '--seed', '7'], deps);
  assert.ok(r.report.params.evolve);
  assert.ok(r.report.results.length <= 2);
  for (const x of r.report.results) {
    assert.ok(x.origin.startsWith('evolved:fold0'));
    assert.equal(x.oosWindows, 1);
  }
  const pre = JSON.parse(fs.readFileSync(arenaPaths.pretrained(), 'utf8'));
  assert.equal(pre.schema, 'mm.arena-pretrained/v1');
  assert.equal(pre.dataSource, 'geckoterminal');
  assert.equal(pre.genomes.length, r.report.results.length);

  await assert.rejects(runBacktest(['--timeframe', 'week'], deps), /--timeframe/);
  await assert.rejects(runBacktest(['--aggregate', '7'], deps), /--aggregate/);
  await assert.rejects(runBacktest(['--genomes', 'leaderboard', '--pools', '4', '--days', '2'], deps), /no genomes/);
  tempStateDir(); // empty cache + API down → clear error
  await assert.rejects(runBacktest(['--days', '2', '--genomes', 'random:2'], { ...deps, client: fastClient(geckoFetch(gen, { failAll: true })) }), /no historical candles/);
  await assert.rejects(runBacktest([], { ...deps, env: { MODE: 'live' } }), /PAPER ONLY/);
});
