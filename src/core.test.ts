import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  isKillSwitchActive,
  readStrategyBudget,
  readStrategyReports,
  statePaths,
  writeJsonAtomic,
  type FinalAllocations,
  type StrategyReport,
} from '../contract/mm-contract.js';
import { cyclePhases, type SystemConfig } from './config.js';
import { createDashboardServer } from './dashboard.js';
import { collectStatus, formatStatus, readRecentEvents } from './status.js';
import { clearKillSwitch, runCycle, setKillSwitch } from './supervisor.js';
import type { StepResult } from './runner.js';

beforeEach(() => {
  process.env.MM_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-core-'));
  delete process.env.MM_KILL;
});

const report = (name: string, overrides: Partial<StrategyReport> = {}): StrategyReport => ({
  schema: 'mm.strategy-report/v1',
  name,
  kind: 'trading',
  mode: 'paper',
  status: 'active',
  capitalUsd: 1000,
  deployedUsd: 200,
  realizedPnlUsd: 50,
  unrealizedPnlUsd: -10,
  totalReturn: 0.04,
  winRate: 0.6,
  avgProfit: 0.02,
  maxDrawdown: 0.05,
  sharpeRatio: 0.8,
  totalTrades: 10,
  openPositions: 1,
  lastUpdated: new Date().toISOString(),
  ...overrides,
});

function fakeConfig(): SystemConfig {
  const comp = (name: string, phase: number, type: 'cycle' | 'daemon' = 'cycle') => ({ name, dir: name, absDir: `/nope/${name}`, type, phase, script: 'once' });
  return {
    coreDir: '/nope', root: '/nope', stateDir: process.env.MM_STATE_DIR!, logsDir: '/nope/logs',
    cycleIntervalMs: 1000, stepTimeoutMs: 1000, dashboardPort: 0, dashboardHost: '127.0.0.1',
    components: [comp('orchestrator', 4), comp('trader', 1), comp('revenue', 2), comp('market', 0, 'daemon'), comp('hunter', 1), comp('allocator', 3)],
  };
}

test('cycle phases are ordered and exclude daemons', () => {
  const phases = cyclePhases(fakeConfig()).map((p) => p.map((c) => c.name));
  assert.deepEqual(phases, [['trader', 'hunter'], ['revenue'], ['allocator'], ['orchestrator']]);
});

test('runCycle runs phases in order, records state and failure events', async () => {
  const order: string[] = [];
  const result = await runCycle(fakeConfig(), async (c) => {
    order.push(c.name);
    const ok = c.name !== 'revenue';
    return { name: c.name, ok, exitCode: ok ? 0 : 2, timedOut: false, durationMs: 1, tail: ['boom'] } satisfies StepResult;
  });
  assert.equal(result.ok, false);
  assert.deepEqual(order, ['trader', 'hunter', 'revenue', 'allocator', 'orchestrator']);
  const status = await collectStatus();
  assert.equal(status.supervisor?.cycles, 1);
  assert.ok(status.warnings.some((w) => w.includes('revenue')));
  const events = await readRecentEvents();
  assert.equal(events[0].type, 'cycle.step-failed');
});

test('kill switch set/clear and budgets', async () => {
  await writeJsonAtomic(statePaths.allocations(), {
    schema: 'mm.allocations/v1', timestamp: new Date().toISOString(), totalCapitalUsd: 1000, reserveUsd: 100,
    allocations: { a: 500, b: 400 }, paused: ['b'], killSwitch: false, reasons: {},
  } satisfies FinalAllocations);
  assert.deepEqual(await readStrategyBudget('a'), { budgetUsd: 500, paused: false });
  assert.deepEqual(await readStrategyBudget('b'), { budgetUsd: 400, paused: true });
  assert.equal(isKillSwitchActive(), false);
  await setKillSwitch('test');
  assert.equal(isKillSwitchActive(), true);
  assert.equal((await collectStatus()).killSwitch.reason?.endsWith('test'), true);
  assert.equal(await clearKillSwitch(), true);
  assert.equal(isKillSwitchActive(), false);
  assert.equal(await clearKillSwitch(), false);
});

test('reports with wrong schema are ignored; stale and live reports produce warnings', async () => {
  await writeJsonAtomic(statePaths.strategy('good'), report('good'));
  await writeJsonAtomic(statePaths.strategy('old'), report('old', { lastUpdated: new Date(Date.now() - 3_600_000).toISOString(), mode: 'live' }));
  await fsp.writeFile(path.join(statePaths.strategiesDir(), 'junk.json'), '{"schema":"other"}');
  await fsp.writeFile(path.join(statePaths.strategiesDir(), 'broken.json'), '{');
  assert.deepEqual((await readStrategyReports()).map((r) => r.name), ['good', 'old']);
  const status = await collectStatus();
  assert.ok(status.warnings.some((w) => w.includes('old') && w.includes('stale')));
  assert.ok(status.warnings.some((w) => w.includes('LIVE')));
  const text = formatStatus(status);
  assert.match(text, /good/);
  assert.match(text, /\[STALE\]/);
});

test('dashboard: status is public, kill requires token', async () => {
  const server = createDashboardServer({ host: '127.0.0.1', port: 0, adminToken: 'secret-token' });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
    assert.equal((await fetch(`${base}/api/kill`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/api/kill`, { method: 'POST', headers: { authorization: 'Bearer wrong-token!' } })).status, 401);
    const ok = await fetch(`${base}/api/kill`, { method: 'POST', headers: { authorization: 'Bearer secret-token' }, body: '{"reason":"drill"}' });
    assert.equal(ok.status, 200);
    assert.equal(isKillSwitchActive(), true);
    assert.equal((await fetch(`${base}/api/resume`, { method: 'POST', headers: { authorization: 'Bearer secret-token' } })).status, 200);
    assert.equal(isKillSwitchActive(), false);
    assert.equal((await fetch(`${base}/`)).headers.get('content-type'), 'text/html; charset=utf-8');
  } finally {
    server.close();
  }
});

test('dashboard: kill endpoint disabled without admin token', async () => {
  const server = createDashboardServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/api/kill`, { method: 'POST', headers: { authorization: 'Bearer x' } })).status, 403);
  } finally {
    server.close();
  }
});

test('arena summary is shown when present and ignored when malformed', async () => {
  await writeJsonAtomic(path.join(process.env.MM_STATE_DIR!, 'arena', 'summary.json'), {
    schema: 'mm.arena-summary/v1', timestamp: new Date().toISOString(), cycle: 7, population: 42, maxGeneration: 3,
    treasuryUsd: 300, equityUsd: 498.5, births: { total: 10, lastCycle: 1 }, deaths: { total: 4, lastCycle: 0 },
    leaderboard: [{ id: 'agt-1', generation: 3, balance: 12.5, return: 1.5, age: 6 }],
  });
  const status = await collectStatus();
  assert.equal(status.arena?.population, 42);
  assert.match(formatStatus(status), /Arena: cycle 7 \| population 42/);
  await writeJsonAtomic(path.join(process.env.MM_STATE_DIR!, 'arena', 'summary.json'), { schema: 'other' });
  assert.equal((await collectStatus()).arena, null);
});

test('alerts fire on state changes only', async () => {
  const { diffAlerts, telegramSender } = await import('./alerts.js');
  const empty = { failing: [], killSwitch: false, live: [] };
  const broken = { failing: ['orchestrator'], killSwitch: true, live: ['solana-trader'] };
  assert.equal(diffAlerts(empty, broken).length, 3);
  assert.deepEqual(diffAlerts(broken, broken), []);
  const recovered = diffAlerts(broken, empty);
  assert.ok(recovered.some((t) => t.includes('recovered')) && recovered.some((t) => t.includes('cleared')));
  assert.equal(telegramSender('', ''), undefined);
  let sent = '';
  const fake = (async (_url: string, init: { body: string }) => {
    sent = init.body;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  await telegramSender('t', 'c', fake)!('hello');
  assert.match(sent, /"chat_id":"c"/);
});
