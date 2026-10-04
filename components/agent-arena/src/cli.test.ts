import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, LiveModeRefused, readConfig } from './config.js';
import { statePaths, writeJsonAtomic, type FinalAllocations, type StrategyReport } from './mm-contract.js';
import { ArenaRunner } from './runner.js';
import type { ArenaSummary } from './report.js';
import { arenaPaths } from './state.js';
import { simulate } from './simulate.js';
import { tempStateDir, testConfig } from './testing/helpers.js';
import type { FetchLike } from './http.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

beforeEach(() => {
  tempStateDir();
});

function assertValidReport(r: StrategyReport) {
  assert.equal(r.schema, 'mm.strategy-report/v1');
  assert.equal(r.name, 'agent-arena');
  assert.equal(r.kind, 'trading');
  assert.equal(r.mode, 'paper');
  assert.ok(['active', 'paused', 'failed'].includes(r.status));
  for (const key of ['capitalUsd', 'deployedUsd', 'realizedPnlUsd', 'unrealizedPnlUsd', 'totalReturn', 'winRate', 'avgProfit', 'maxDrawdown', 'sharpeRatio', 'totalTrades', 'openPositions'] as const) {
    assert.equal(typeof r[key], 'number', key);
    assert.ok(Number.isFinite(r[key]), key);
  }
  assert.ok(r.winRate >= 0 && r.winRate <= 1);
  assert.ok(r.maxDrawdown >= 0 && r.maxDrawdown <= 1);
  assert.ok(r.deployedUsd <= r.capitalUsd + 1e-9);
  assert.ok(!Number.isNaN(Date.parse(r.lastUpdated)));
  assert.ok(r.notes?.some((n) => n.includes('PAPER ONLY')));
}

function assertValidSummary(s: ArenaSummary) {
  assert.equal(s.schema, 'mm.arena-summary/v1');
  assert.ok(s.population > 0);
  assert.ok(Array.isArray(s.equityCurve) && s.equityCurve.length <= 500);
  assert.ok(s.leaderboard.length <= 10 && s.leaderboard.length > 0);
  assert.ok(s.leaderboard[0]!.genome && typeof s.leaderboard[0]!.return === 'number');
  assert.ok(s.species.trader);
  assert.equal(typeof s.treasuryUsd, 'number');
  assert.equal(typeof s.llm.totalUsd, 'number');
}

test('config: MODE=live refuses to start; bad values are rejected; dry-run maps to paper', () => {
  assert.throws(() => readConfig({ MODE: 'live' }), LiveModeRefused);
  assert.throws(() => readConfig({ MODE: 'live', LIVE_TRADING_CONFIRM: 'I_UNDERSTAND_REAL_MONEY_RISK' }), /PAPER ONLY/);
  assert.throws(() => readConfig({ ARENA_UPKEEP_USD: 'abc' }), ConfigError);
  assert.throws(() => readConfig({ ARENA_MARKET: 'binance' }), ConfigError);
  assert.throws(() => readConfig({ ARENA_DEATH_USD: '10' }), /below ARENA_SEED_USD/);
  const c = readConfig({ MODE: 'dry-run' });
  assert.equal(c.mode, 'paper');
  assert.equal(c.modeNotes.length, 1);
  const d = readConfig({});
  assert.equal(d.startingCapitalUsd, 500);
  assert.equal(d.seedUsd, 5);
  assert.equal(d.minPopulation, 20);
  assert.equal(d.maxPopulation, 2000);
  assert.equal(d.upkeepUsd, 0.002);
  assert.equal(d.deathUsd, 0.5);
  assert.equal(d.reproMultiple, 2);
  assert.equal(d.reproShare, 0.5);
  assert.equal(d.market, 'dexscreener');
  assert.equal(d.llm.apiKey, undefined);
});

test('once (synthetic) writes a valid StrategyReport, summary, population and graveyard; state resumes', async () => {
  const cfg = testConfig({ ARENA_SEED: 'once' });
  const r1 = await ArenaRunner.open({ cfg, llm: null, log: () => {} });
  await r1.cycle();
  const { report, summary } = await r1.persist();
  assertValidReport(report);
  assertValidSummary(summary);
  assert.ok(report.notes!.includes('synthetic-market-data'));
  assert.ok(summary.notes.includes('synthetic-market-data'));
  assert.deepEqual(JSON.parse(fs.readFileSync(statePaths.strategy('agent-arena'), 'utf8')), report);
  assert.ok(fs.existsSync(arenaPaths.population()) && fs.existsSync(arenaPaths.graveyard()) && fs.existsSync(arenaPaths.syntheticMarket()));
  const r2 = await ArenaRunner.open({ cfg, llm: null, log: () => {} });
  assert.equal(r2.state.cycle, 1);
  await r2.cycle();
  const { summary: s2 } = await r2.persist();
  assert.equal(s2.cycle, 2);
});

test('once (dexscreener, injected fetch) follows the orchestrator budget and kill switch', async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('/token-profiles/') || url.includes('/token-boosts/')) return Response.json([{ chainId: 'solana', tokenAddress: 'aaa' }]);
    return Response.json({
      pairs: [{ chainId: 'solana', dexId: 'raydium', pairAddress: 'p', baseToken: { address: 'aaa', symbol: 'AAA' }, priceUsd: '1', liquidity: { usd: 1e6 }, volume: { h24: 1e6 }, txns: { h24: { buys: 10, sells: 5 } }, priceChange: { h1: 2 }, pairCreatedAt: Date.now() - 100 * 3_600_000 }],
    });
  };
  const alloc: FinalAllocations = { schema: 'mm.allocations/v1', timestamp: new Date().toISOString(), totalCapitalUsd: 1000, reserveUsd: 0, allocations: { 'agent-arena': 300 }, paused: [], killSwitch: false, reasons: {} };
  await writeJsonAtomic(statePaths.allocations(), alloc);
  const cfg = readConfig({ ARENA_SEED: 'dex' });
  const runner = await ArenaRunner.open({ cfg, fetchImpl, llm: null, log: () => {} });
  await runner.cycle();
  const { report } = await runner.persist();
  assertValidReport(report);
  assert.equal(report.status, 'active');
  // budget is applied at cycle start; the cycle's own costs (upkeep, slippage) follow
  assert.ok(Math.abs(report.capitalUsd - 300) < 1, String(report.capitalUsd));
  assert.ok(Math.abs(runner.state.ledger.adjustmentsUsd + 200) < 1e-6);
  assert.ok(!report.notes!.includes('synthetic-market-data'));
  fs.writeFileSync(statePaths.kill(), '');
  const entriesBefore = runner.state.agents.reduce((s, a) => s + a.positions.length, 0);
  await runner.cycle();
  const { report: killed } = await runner.persist();
  assert.equal(killed.status, 'paused');
  assert.equal(runner.state.lastCycle.entries, 0);
  assert.equal(runner.state.lastCycle.births, 0);
  assert.ok(runner.state.agents.reduce((s, a) => s + a.positions.length, 0) <= entriesBefore);
});

test('npm run once equivalent (subprocess, synthetic, no secrets) succeeds; MODE=live exits non-zero', () => {
  const dir = tempStateDir();
  const env = { ...process.env, MM_STATE_DIR: dir, ARENA_MARKET: 'synthetic', ANTHROPIC_API_KEY: '', MODE: '' };
  const ok = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--once'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.match(ok.stdout, /cycle=1 market=synthetic/);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'strategies', 'agent-arena.json'), 'utf8')) as StrategyReport;
  assertValidReport(report);
  assertValidSummary(JSON.parse(fs.readFileSync(path.join(dir, 'arena', 'summary.json'), 'utf8')) as ArenaSummary);
  const live = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--once'], { cwd: ROOT, env: { ...env, MODE: 'live' }, encoding: 'utf8' });
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /MODE=live refused/);
});

test('simulate runs offline in a temp state dir and is reproducible', async () => {
  const before = process.env.MM_STATE_DIR;
  const a = await simulate(['--cycles', '60', '--seed', '7', '--quiet']);
  const b = await simulate(['--cycles', '60', '--seed', '7', '--quiet']);
  process.env.MM_STATE_DIR = before;
  assert.notEqual(a.stateDir, b.stateDir);
  const strip = (t: string) => t.replace(/in \d+ ms \([\d.]+ ms\/cycle\)/, '').replace(/state written to .*/, '');
  assert.equal(strip(a.text), strip(b.text));
  assert.match(a.text, /synthetic-market-data/);
  await assert.rejects(simulate(['--market', 'dexscreener']), /offline-only/);
});
