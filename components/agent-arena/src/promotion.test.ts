import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGenesisState, Arena } from './arena.js';
import type { BacktestMetrics } from './backtest.js';
import { readConfig } from './config.js';
import { genomeId } from './genome.js';
import { statePaths, writeJsonAtomic } from './mm-contract.js';
import { evaluatePromotions, type BacktestResultEntry, type BacktestResults, type PromotionsFile } from './promotion.js';
import { ArenaRunner } from './runner.js';
import { arenaPaths, type ArenaState } from './state.js';
import { easyGenome, FakeMarket, tempStateDir, testConfig, token } from './testing/helpers.js';

beforeEach(() => {
  tempStateDir();
});

const NOW = new Date('2026-10-05T12:00:00Z');
const criteria = readConfig({}).promotion;

function metrics(over: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return { return: 0.08, trades: 12, wins: 7, winRate: 7 / 12, maxDrawdown: 0.1, sharpe: 0.3, exposure: 0.4, timeInMarket: 0.5, steps: 500, tradeMean: 0.01, tradeM2: 0.1, ...over };
}

function entry(genome: Record<string, number>, oos: Partial<BacktestMetrics> | null = {}, over: Partial<BacktestResultEntry> = {}): BacktestResultEntry {
  return {
    genomeId: genomeId(genome),
    genome,
    origin: 'test',
    trainedUntilTs: null,
    inSample: metrics(),
    outOfSample: oos === null ? null : metrics(oos),
    oosWindows: oos === null ? 0 : 1,
    runAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    dataSource: 'geckoterminal',
    stepMinutes: 5,
    ...over,
  };
}

function results(...entries: BacktestResultEntry[]): BacktestResults {
  return { schema: 'mm.arena-backtest-results/v1', updatedAt: NOW.toISOString(), results: Object.fromEntries(entries.map((e) => [e.genomeId, e])) };
}

/** A live-arena state with agents of the given genomes, all old and active enough. */
function liveState(market: ArenaState['market'], genomes: Array<Record<string, number>>, agentOver: Array<Partial<{ trades: number; bornCycle: number; cashUsd: number; maxDrawdown: number }>> = []): ArenaState {
  const cfg = testConfig({ ARENA_MIN_POPULATION: '0' });
  const state = createGenesisState({ ...cfg, market }, NOW, 'promo');
  const arena = new Arena({ ...cfg, market }, state, undefined, { market: new FakeMarket(), now: () => NOW, emit: async () => undefined });
  genomes.forEach((g, i) => {
    const a = arena.spawnFromTreasury('spawn', g)!;
    const o = agentOver[i] ?? {};
    a.bornCycle = o.bornCycle ?? 0;
    a.stats.trades = o.trades ?? 20;
    a.stats.wins = 12;
    a.cashUsd = o.cashUsd ?? 6;
    a.maxDrawdown = o.maxDrawdown ?? 0.1;
  });
  state.cycle = 1000;
  return state;
}

const G1 = easyGenome({ takeProfitPct: 12 });
const G2 = easyGenome({ takeProfitPct: 20 });

test('never promotes from a synthetic arena, even with perfect evidence', () => {
  const { file, change } = evaluatePromotions({ state: liveState('synthetic', [G1]), backtests: results(entry(G1, { return: 0.5 })), criteria, cycleMinutes: 5, now: NOW });
  assert.equal(file.promoted, undefined);
  assert.equal(change, undefined);
  assert.equal(file.candidates[0]!.eligible, false);
  assert.ok(file.candidates[0]!.reasons.some((r) => r.includes('synthetic-market-data')));
  assert.ok(file.notes.some((n) => n.includes('synthetic')));
  // replay populations are not live data either
  assert.equal(evaluatePromotions({ state: liveState('replay', [G1]), backtests: results(entry(G1)), criteria, cycleMinutes: 5, now: NOW }).file.promoted, undefined);
});

test('promotes the best eligible candidate on live data with positive out-of-sample evidence', () => {
  const state = liveState('dexscreener', [G1, G2]);
  const { file, change } = evaluatePromotions({ state, backtests: results(entry(G1, { return: 0.05 }), entry(G2, { return: 0.2 })), criteria, cycleMinutes: 5, now: NOW });
  assert.equal(file.schema, 'mm.arena-promotions/v1');
  assert.equal(file.promoted!.genomeId, genomeId(G2));
  assert.deepEqual(file.promoted!.genome, G2);
  assert.equal(file.promoted!.cycleMinutes, 5);
  assert.equal(change!.type, 'promoted');
  const c = file.candidates.find((x) => x.genomeId === genomeId(G2))!;
  assert.equal(c.agentId, state.agents[1]!.id);
  assert.equal(c.evidence.liveArenaCycles, 1000);
  assert.equal(c.evidence.arenaTrades, 20);
  assert.ok(Math.abs(c.evidence.arenaReturn - 0.2) < 1e-9);
  assert.deepEqual(c.evidence.backtestOos, { return: 0.2, trades: 12, maxDrawdown: 0.1, sharpe: 0.3 });
  assert.equal(file.history.length, 1);
});

test('criteria: every gate blocks promotion with a reason', () => {
  const cases: Array<[string, Parameters<typeof liveState>[2], BacktestResultEntry, RegExp]> = [
    ['young', [{ bornCycle: 900 }], entry(G1), /arena age 100 < 288/],
    ['few trades', [{ trades: 3 }], entry(G1), /arena trades 3 < 10/],
    ['arena drawdown', [{ maxDrawdown: 0.5 }], entry(G1), /arena drawdown/],
    ['negative oos', [{}], entry(G1, { return: -0.01 }), /out-of-sample return/],
    ['zero oos', [{}], entry(G1, { return: 0 }), /out-of-sample return/],
    ['oos drawdown', [{}], entry(G1, { maxDrawdown: 0.6 }), /out-of-sample drawdown/],
    ['oos trades', [{}], entry(G1, { trades: 1 }), /out-of-sample trades/],
    ['no oos', [{}], entry(G1, null), /no out-of-sample/],
    ['stale', [{}], entry(G1, {}, { runAt: new Date(NOW.getTime() - 30 * 86_400_000).toISOString() }), /old/],
    ['step mismatch', [{}], entry(G1, {}, { stepMinutes: 15 }), /step 15 min/],
    ['not real history', [{}], entry(G1, {}, { dataSource: 'fixture' }), /not real history/],
  ];
  for (const [name, over, e, re] of cases) {
    const { file } = evaluatePromotions({ state: liveState('dexscreener', [G1], over), backtests: results(e), criteria, cycleMinutes: 5, now: NOW });
    assert.equal(file.promoted, undefined, name);
    assert.ok(file.candidates[0]!.reasons.some((r) => re.test(r)), `${name}: ${file.candidates[0]!.reasons.join(' | ')}`);
  }
  // no backtest at all
  assert.equal(evaluatePromotions({ state: liveState('dexscreener', [G1]), backtests: null, criteria, cycleMinutes: 5, now: NOW }).file.promoted, undefined);
  // track record from before the market switch does not count
  const s = liveState('dexscreener', [G1]);
  s.marketSinceCycle = 10;
  const r = evaluatePromotions({ state: s, backtests: results(entry(G1)), criteria, cycleMinutes: 5, now: NOW });
  assert.equal(r.file.promoted, undefined);
  assert.ok(r.file.candidates[0]!.reasons.some((x) => x.includes('before the current market source')));
});

test('a challenger must beat the promoted strategy by the margin; history is kept', () => {
  const first = evaluatePromotions({ state: liveState('dexscreener', [G1]), backtests: results(entry(G1, { return: 0.1 })), criteria, cycleMinutes: 5, now: NOW }).file;
  assert.equal(first.promoted!.genomeId, genomeId(G1));
  const later = new Date(NOW.getTime() + 60_000);
  // slightly better → kept
  const close = evaluatePromotions({ state: liveState('dexscreener', [G1, G2]), backtests: results(entry(G1, { return: 0.1 }), entry(G2, { return: 0.11 })), previous: first, criteria, cycleMinutes: 5, now: later });
  assert.equal(close.file.promoted!.genomeId, genomeId(G1));
  assert.equal(close.change, undefined);
  assert.equal(close.file.promoted!.promotedAt, first.promoted!.promotedAt);
  // clearly better → replaced
  const better = evaluatePromotions({ state: liveState('dexscreener', [G1, G2]), backtests: results(entry(G1, { return: 0.1 }), entry(G2, { return: 0.3 })), previous: close.file, criteria, cycleMinutes: 5, now: later });
  assert.equal(better.file.promoted!.genomeId, genomeId(G2));
  assert.equal(better.change?.type === 'promoted' && better.change.replaced, genomeId(G1));
  assert.equal(better.file.history.length, 2);
  assert.ok(better.file.history[0]!.endReason?.includes('replaced'));
});

test('demotion when a fresh backtest of the promoted genome fails out of sample', () => {
  const first = evaluatePromotions({ state: liveState('dexscreener', [G1]), backtests: results(entry(G1)), criteria, cycleMinutes: 5, now: NOW }).file;
  const r = evaluatePromotions({ state: liveState('dexscreener', [G1]), backtests: results(entry(G1, { return: -0.2 })), previous: first, criteria, cycleMinutes: 5, now: NOW });
  assert.equal(r.file.promoted, undefined);
  assert.equal(r.change?.type, 'demoted');
  assert.ok(r.file.history[0]!.endReason?.startsWith('demoted'));
});

test('runner writes promotions.json every cycle and emits arena.strategy-promoted; pretrained genomes are adopted once', async () => {
  const market = new FakeMarket();
  market.set(token('m1'));
  const cfg = testConfig({ ARENA_MARKET: 'dexscreener', ARENA_PROMO_MIN_CYCLES: '1', ARENA_PROMO_MIN_TRADES: '0', ARENA_MIN_POPULATION: '2' });
  await writeJsonAtomic(arenaPaths.pretrained(), {
    schema: 'mm.arena-pretrained/v1',
    createdAt: NOW.toISOString(),
    dataSource: 'geckoterminal',
    genomes: [
      { genomeId: genomeId(G1), genome: G1, oosReturn: 0.05 },
      { genomeId: genomeId(G2), genome: G2, oosReturn: -0.05 },
    ],
  });
  const events: string[] = [];
  const emit = async (e: { type: string }) => void events.push(e.type);
  const runner = await ArenaRunner.open({ cfg, market, llm: null, now: () => NOW, emit, log: () => undefined });
  const designed = runner.state.agents.filter((a) => a.origin === 'designed');
  assert.equal(designed.length, 1, 'only the positive out-of-sample genome');
  assert.deepEqual(designed[0]!.genome, G1);
  await runner.cycle({ paused: false });
  await writeJsonAtomic(arenaPaths.backtestResults(), results(entry(G1)));
  await runner.cycle({ paused: false });
  const { promotions } = await runner.persist();
  assert.equal(promotions.promoted?.genomeId, genomeId(G1));
  assert.ok(events.includes('arena.strategy-promoted'));
  const onDisk = JSON.parse(fs.readFileSync(arenaPaths.promotions(), 'utf8')) as PromotionsFile;
  assert.equal(onDisk.promoted!.genomeId, genomeId(G1));

  // reopening does not adopt the same genome again
  const again = await ArenaRunner.open({ cfg, market, llm: null, now: () => NOW, emit, log: () => undefined });
  assert.equal(again.state.agents.filter((a) => a.origin === 'designed').length, 1);
  assert.ok(fs.existsSync(statePaths.strategy('agent-arena')));
});
