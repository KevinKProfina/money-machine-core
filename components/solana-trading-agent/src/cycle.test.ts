import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCycle, type CycleDeps } from './cycle.js';
import { PaperExecutor } from './executor.js';
import { DexScreenerSource } from './market.js';
import { statePaths, writeJsonAtomic, type FinalAllocations, type StrategyReport } from './mm-contract.js';
import { positionsPath } from './positions.js';
import { FIXTURE_NOW, MINTS, fixtureFetch, testConfig } from './testing/fixtures.js';

beforeEach(() => {
  process.env.MM_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-solana-trader-'));
  delete process.env.MM_KILL;
});

function deps(overrides: Partial<CycleDeps> & { prices?: Record<string, number>; env?: Record<string, string>; hours?: number } = {}): CycleDeps {
  const cfg = testConfig(overrides.env);
  const at = new Date(FIXTURE_NOW.getTime() + (overrides.hours ?? 0) * 3_600_000);
  return {
    cfg,
    market: new DexScreenerSource({ fetchImpl: fixtureFetch({ prices: overrides.prices }), now: () => at.getTime(), retries: 0 }),
    executor: cfg.mode === 'dry-run' ? undefined : new PaperExecutor(cfg.paperSlippageBps, cfg.paperFeeBps),
    now: () => at,
    ...overrides,
  };
}

function readReport(): StrategyReport {
  return JSON.parse(fs.readFileSync(statePaths.strategy('solana-trader'), 'utf8')) as StrategyReport;
}

function readEvents(): Array<{ type: string; source: string }> {
  const file = statePaths.events();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

function assertValidReport(r: StrategyReport) {
  assert.equal(r.schema, 'mm.strategy-report/v1');
  assert.equal(r.name, 'solana-trader');
  assert.equal(r.kind, 'trading');
  assert.ok(['dry-run', 'paper', 'live'].includes(r.mode));
  assert.ok(['active', 'paused', 'failed'].includes(r.status));
  for (const key of ['capitalUsd', 'deployedUsd', 'realizedPnlUsd', 'unrealizedPnlUsd', 'totalReturn', 'winRate', 'avgProfit', 'maxDrawdown', 'sharpeRatio', 'totalTrades', 'openPositions'] as const) {
    assert.equal(typeof r[key], 'number', key);
    assert.ok(Number.isFinite(r[key]), key);
  }
  assert.ok(r.winRate >= 0 && r.winRate <= 1);
  assert.ok(r.maxDrawdown >= 0 && r.maxDrawdown <= 1);
  assert.ok(r.deployedUsd <= r.capitalUsd + 1e-9);
  assert.ok(!Number.isNaN(Date.parse(r.lastUpdated)));
}

test('full paper cycle with fixture market data writes a valid StrategyReport', async () => {
  const { report, opened } = await runCycle(deps());
  assertValidReport(report);
  assert.deepEqual(readReport(), report);
  assert.equal(report.mode, 'paper');
  assert.equal(report.status, 'active');
  assert.equal(report.capitalUsd, 1000);
  assert.deepEqual(opened.map((p) => p.mint), [MINTS.GOOD1, MINTS.GOOD2]);
  assert.ok(opened.every((p) => p.simulated && p.mode === 'paper' && p.sizeUsd === 50));
  assert.equal(report.deployedUsd, 100);
  assert.equal(report.openPositions, 2);
  assert.equal(report.totalTrades, 0);
  // marked at market right after a costly fill → small unrealized loss (slippage + fee)
  assert.ok(report.unrealizedPnlUsd < 0 && report.unrealizedPnlUsd > -2);
  assert.ok(report.notes!.some((n) => n.includes('simulated')));
  assert.ok(fs.existsSync(positionsPath('paper')));
  assert.equal(readEvents().filter((e) => e.type === 'position.opened' && e.source === 'solana-trader').length, 2);
});

test('second cycle closes on take-profit, keeps the other open, no duplicate or re-entry', async () => {
  await runCycle(deps());
  const { report, closed, opened } = await runCycle(deps({ hours: 1, prices: { [MINTS.GOOD1]: 0.0125 * 1.4 } }));
  assertValidReport(report);
  assert.equal(opened.length, 0, 'GOOD2 still held, GOOD1 in cooldown');
  assert.equal(closed.length, 1);
  assert.equal(closed[0]!.exitReason, 'take-profit');
  assert.ok(closed[0]!.realizedPnlUsd! > 0);
  assert.equal(report.totalTrades, 1);
  assert.equal(report.winRate, 1);
  assert.equal(report.openPositions, 1);
  assert.equal(report.deployedUsd, 50);
  assert.ok(report.realizedPnlUsd > 15);
  assert.ok(report.totalReturn > 0);
  assert.equal(readEvents().filter((e) => e.type === 'position.closed').length, 1);
});

test('stop-loss and max-hold exits use current market prices', async () => {
  await runCycle(deps());
  const r1 = await runCycle(deps({ hours: 2, prices: { [MINTS.GOOD2]: 0.84 * 0.85 } }));
  assert.deepEqual(r1.closed.map((p) => p.exitReason), ['stop-loss']);
  assert.ok(r1.report.realizedPnlUsd < 0);
  assert.ok(r1.report.maxDrawdown > 0);
  const r2 = await runCycle(deps({ hours: 49 }));
  assert.deepEqual(r2.closed.map((p) => p.exitReason), ['max-hold']);
});

test('kill switch: no new entries, positions kept unless KILL_CLOSES_POSITIONS=true', async () => {
  await runCycle(deps());
  fs.writeFileSync(statePaths.kill(), '');
  const killed = await runCycle(deps({ hours: 1 }));
  assert.equal(killed.report.status, 'paused');
  assert.equal(killed.opened.length, 0);
  assert.equal(killed.closed.length, 0);
  assert.equal(killed.report.openPositions, 2);
  assert.ok(killed.report.notes!.some((n) => n.includes('kill switch')));

  const closing = await runCycle(deps({ hours: 2, env: { KILL_CLOSES_POSITIONS: 'true' } }));
  assert.deepEqual(closing.closed.map((p) => p.exitReason), ['kill-switch', 'kill-switch']);
  assert.equal(closing.report.openPositions, 0);
  assert.equal(closing.report.deployedUsd, 0);
});

test('exits still run while killed', async () => {
  await runCycle(deps());
  process.env.MM_KILL = '1';
  const r = await runCycle(deps({ hours: 1, prices: { [MINTS.GOOD1]: 0.0125 * 1.5 } }));
  assert.deepEqual(r.closed.map((p) => p.exitReason), ['take-profit']);
  assert.equal(r.opened.length, 0);
});

test('orchestrator budget caps sizing; paused allocation blocks entries', async () => {
  const alloc: FinalAllocations = {
    schema: 'mm.allocations/v1', timestamp: FIXTURE_NOW.toISOString(), totalCapitalUsd: 1000, reserveUsd: 100,
    allocations: { 'solana-trader': 60 }, paused: [], killSwitch: false, reasons: {},
  };
  await writeJsonAtomic(statePaths.allocations(), alloc);
  const { report, opened } = await runCycle(deps());
  assert.equal(report.capitalUsd, 60);
  assert.deepEqual(opened.map((p) => p.sizeUsd), [6, 6]);

  await writeJsonAtomic(statePaths.allocations(), { ...alloc, paused: ['solana-trader'] });
  const paused = await runCycle(deps({ hours: 1 }));
  assert.equal(paused.report.status, 'paused');
  assert.equal(paused.opened.length, 0);
});

test('max concurrent positions respected', async () => {
  const { opened, report } = await runCycle(deps({ env: { MAX_CONCURRENT_POSITIONS: '1' } }));
  assert.equal(opened.length, 1);
  assert.ok(report.notes!.some((n) => n.includes('max concurrent')));
});

test('Claude gate SKIP blocks entries', async () => {
  const { opened } = await runCycle(deps({ gate: async () => ({ decision: 'SKIP', reason: 'nope' }) }));
  assert.equal(opened.length, 0);
});

test('dry-run evaluates only and persists no positions', async () => {
  const { report, opened } = await runCycle(deps({ env: { MODE: 'dry-run' } }));
  assertValidReport(report);
  assert.equal(report.mode, 'dry-run');
  assert.equal(opened.length, 0);
  assert.equal(report.openPositions, 0);
  assert.ok(report.notes!.some((n) => n.startsWith('dry-run: would open')));
  assert.equal(fs.existsSync(positionsPath('paper')), false);
});

test('market outage still produces a report', async () => {
  const cfg = testConfig();
  const { report } = await runCycle({
    cfg,
    market: new DexScreenerSource({ fetchImpl: fixtureFetch({ fail: true }), retries: 0 }),
    executor: new PaperExecutor(0, 0),
  });
  assertValidReport(report);
  assert.equal(report.openPositions, 0);
  assert.ok(report.notes!.some((n) => n.includes('no candidates')));
});
