import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readJsonSafe, statePaths, writeJsonAtomic, type FinalAllocations, type StrategyReport } from './mm-contract.js';
import { ClaudeGate } from './claude-gate.js';
import { loadConfig } from './config.js';
import { runCycle } from './cycle.js';
import { readDecisions, readExecutions } from './ledger.js';
import { SimulatedSource } from './sources/simulated.js';
import type { OpportunitySource } from './sources/types.js';

const execFileP = promisify(execFile);
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const silent = () => {};
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-test-'));
  process.env.MM_STATE_DIR = dir;
  delete process.env.MM_KILL;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function assertValidReport(r: StrategyReport) {
  assert.equal(r.schema, 'mm.strategy-report/v1');
  assert.equal(r.name, 'liquidation-hunter');
  assert.equal(r.kind, 'liquidation');
  for (const k of ['capitalUsd', 'deployedUsd', 'realizedPnlUsd', 'unrealizedPnlUsd', 'totalReturn', 'winRate', 'avgProfit', 'maxDrawdown', 'sharpeRatio', 'totalTrades', 'openPositions'] as const) {
    assert.equal(typeof r[k], 'number', k);
    assert.ok(Number.isFinite(r[k]), k);
  }
  assert.ok(r.winRate >= 0 && r.winRate <= 1);
  assert.ok(r.maxDrawdown >= 0 && r.maxDrawdown <= 1);
  assert.ok(!Number.isNaN(Date.parse(r.lastUpdated)));
}

test('paper cycle: writes ledger + valid report, executions are simulated, no tx hashes', async () => {
  const config = loadConfig({ SIM_SEED: '42', SIM_POSITIONS_PER_CYCLE: '40' });
  const source = new SimulatedSource(config.simSeed, config.simPositionsPerCycle);
  const s1 = await runCycle({ config, source, log: silent });
  const s2 = await runCycle({ config, source, log: silent });
  assert.equal(s1.cycle, 1);
  assert.equal(s2.cycle, 2);
  assert.ok(s1.executed + s2.executed > 0, 'expected some paper executions');

  const report = await readJsonSafe<StrategyReport | null>(statePaths.strategy('liquidation-hunter'), null);
  assert.ok(report);
  assertValidReport(report);
  assert.equal(report.mode, 'paper');
  assert.equal(report.status, 'active');
  assert.ok(report.notes?.some((n) => n.startsWith('SIMULATED')));
  assert.ok(report.notes?.includes('synthetic-market-data'));

  const executions = await readExecutions();
  const decisions = await readDecisions();
  assert.equal(executions.length, s1.executed + s2.executed);
  assert.equal(decisions.length, s1.decisions + s2.decisions);
  assert.equal(report.totalTrades, executions.length);
  for (const e of executions) {
    assert.equal(e.simulated, true);
    assert.equal(e.txSignature, undefined);
    assert.ok(e.repayUsd <= config.maxLiquidationSizeUsd);
  }
  // decisions are skips (never counted as executions)
  for (const d of decisions) assert.equal(d.decision, 'skip');
  const pnl = executions.reduce((s, e) => s + e.realizedPnlUsd, 0);
  assert.ok(Math.abs(report.realizedPnlUsd - pnl) < 0.01);
  assert.equal(report.winRate, executions.filter((e) => e.realizedPnlUsd > 0).length / executions.length);

  const events = fs.readFileSync(statePaths.events(), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(events.filter((e) => e.type === 'liquidation.execution').length, executions.length);
});

test('same seed in a fresh state dir reproduces the same ledger', async () => {
  const config = loadConfig({ SIM_SEED: '9', SIM_POSITIONS_PER_CYCLE: '30' });
  await runCycle({ config, source: new SimulatedSource(9, 30), log: silent });
  const strip = (xs: { ts: string }[]) => xs.map(({ ts: _ts, ...rest }) => rest);
  const first = strip(await readExecutions());
  fs.rmSync(dir, { recursive: true, force: true });
  await runCycle({ config, source: new SimulatedSource(9, 30), log: silent });
  assert.deepEqual(strip(await readExecutions()), first);
});

test('kill switch: no scan, no executions, status paused', async () => {
  fs.writeFileSync(path.join(dir, 'KILL'), '');
  let scanned = false;
  const source: OpportunitySource = {
    id: 'spy', simulated: true, implemented: true,
    async scan() { scanned = true; return []; },
  };
  const s = await runCycle({ config: loadConfig({}), source, log: silent });
  assert.equal(s.halted, true);
  assert.equal(scanned, false);
  assert.equal(s.report.status, 'paused');
  assert.equal((await readExecutions()).length, 0);
});

test('orchestrator budget caps size; zero budget / paused halts', async () => {
  const alloc = (budget: number, paused: string[] = []): FinalAllocations => ({
    schema: 'mm.allocations/v1', timestamp: new Date().toISOString(), totalCapitalUsd: 10_000, reserveUsd: 0,
    allocations: { 'liquidation-hunter': budget }, paused, killSwitch: false, reasons: {},
  });
  const config = loadConfig({ SIM_POSITIONS_PER_CYCLE: '60', MIN_LIQUIDATION_PROFIT_USD: '1' });
  await writeJsonAtomic(statePaths.allocations(), alloc(800));
  const s = await runCycle({ config, source: new SimulatedSource(3, 60), log: silent });
  assert.equal(s.report.capitalUsd, 800);
  for (const e of await readExecutions()) assert.ok(e.repayUsd <= 800);

  await writeJsonAtomic(statePaths.allocations(), alloc(0));
  assert.equal((await runCycle({ config, source: new SimulatedSource(3, 60), log: silent })).halted, true);
  await writeJsonAtomic(statePaths.allocations(), alloc(800, ['liquidation-hunter']));
  const p = await runCycle({ config, source: new SimulatedSource(3, 60), log: silent });
  assert.equal(p.halted, true);
  assert.equal(p.report.status, 'paused');
});

test('dry-run records would_execute decisions and no executions', async () => {
  const config = loadConfig({ MODE: 'dry-run', SIM_POSITIONS_PER_CYCLE: '40' });
  const s = await runCycle({ config, source: new SimulatedSource(42, 40), log: silent });
  assert.equal(s.executed, 0);
  assert.equal((await readExecutions()).length, 0);
  assert.ok((await readDecisions()).some((d) => d.decision === 'would_execute'));
  assert.equal(s.report.mode, 'dry-run');
  assertValidReport(s.report);
});

test('Claude gate SKIP blocks execution; scan failure degrades gracefully', async () => {
  const config = loadConfig({ SIM_POSITIONS_PER_CYCLE: '40' });
  const gate = new ClaudeGate({ beta: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'SKIP: no' }] }) } } });
  const s = await runCycle({ config, source: new SimulatedSource(42, 40), claudeGate: gate, log: silent });
  assert.equal(s.executed, 0);
  assert.ok((await readDecisions()).some((d) => d.stage === 'claude'));

  const broken: OpportunitySource = { id: 'x', simulated: true, implemented: true, async scan() { throw new Error('rpc down'); } };
  const b = await runCycle({ config, source: broken, log: silent });
  assert.equal(b.scanned, 0);
  assertValidReport(b.report);
});

test('CLI --once succeeds with no secrets; MODE=live refuses to start', async () => {
  const env = { PATH: process.env.PATH, MM_STATE_DIR: dir, HOME: process.env.HOME };
  const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  await execFileP(process.execPath, [tsxCli, 'src/index.ts', '--once'], { cwd: repoRoot, env });
  const report = await readJsonSafe<StrategyReport | null>(path.join(dir, 'strategies', 'liquidation-hunter.json'), null);
  assert.ok(report);
  assertValidReport(report);
  assert.equal(report.mode, 'paper');
  assert.ok(report.notes?.includes('synthetic-market-data'));

  await assert.rejects(
    execFileP(process.execPath, [tsxCli, 'src/index.ts', '--once'], {
      cwd: repoRoot,
      env: { ...env, MODE: 'live', LIVE_TRADING_CONFIRM: 'I_UNDERSTAND_REAL_MONEY_RISK' },
    }),
    (err: { code?: number; stderr?: string }) => err.code === 1 && /MODE=live is not supported/.test(err.stderr ?? ''),
  );
});
