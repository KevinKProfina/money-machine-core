import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetKillSwitch, runCycle } from './cycle.js';
import { readJsonSafe, statePaths, writeJsonAtomic, type FinalAllocations, type PortfolioState } from './mm-contract.js';
import { loadState, orchestratorStatePath } from './state.js';
import { NOW, makeConfig, makeProposal, makeReport, makeRevenue } from './test/fixtures.js';

describe('full --once cycle against a temp MM_STATE_DIR', () => {
  let dir: string;
  const prevDir = process.env.MM_STATE_DIR;
  const prevKill = process.env.MM_KILL;
  const log = console.log;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-orch-'));
    process.env.MM_STATE_DIR = dir;
    delete process.env.MM_KILL;
    console.log = () => {};
  });
  after(async () => {
    console.log = log;
    if (prevDir === undefined) delete process.env.MM_STATE_DIR;
    else process.env.MM_STATE_DIR = prevDir;
    if (prevKill !== undefined) process.env.MM_KILL = prevKill;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const readAlloc = () => readJsonSafe<FinalAllocations | null>(statePaths.allocations(), null);

  it('empty state dir: writes empty allocations, portfolio and state', async () => {
    await runCycle(makeConfig(), NOW);
    const a = (await readAlloc())!;
    assert.equal(a.schema, 'mm.allocations/v1');
    assert.deepEqual(a.allocations, {});
    assert.equal(a.killSwitch, false);
    const p = await readJsonSafe<PortfolioState | null>(statePaths.portfolio(), null);
    assert.equal(p?.schema, 'mm.portfolio/v1');
    assert.equal((await loadState()).history.length, 1);
    await fs.rm(statePaths.allocations()); // start the fixture run from a clean slate
  });

  it('runs a cycle from fixture reports, proposal and revenue', async () => {
    await writeJsonAtomic(statePaths.strategy('solana-trader'), makeReport({ name: 'solana-trader', realizedPnlUsd: 10 }));
    await writeJsonAtomic(
      statePaths.strategy('liquidation-hunter'),
      makeReport({ name: 'liquidation-hunter', kind: 'liquidation', realizedPnlUsd: 5 }),
    );
    await writeJsonAtomic(statePaths.strategy('broken'), makeReport({ name: 'broken', status: 'failed' }));
    await writeJsonAtomic(statePaths.proposal(), makeProposal({ 'solana-trader': 400, 'liquidation-hunter': 300, broken: 0 }));
    await writeJsonAtomic(
      statePaths.revenue(),
      makeRevenue({
        'solana-trader': { kind: 'trading', totalUsd: 10, last7dUsd: 0, last30dUsd: 0, simulated: true },
        'ai-services': { kind: 'ai-services', totalUsd: 20, last7dUsd: 0, last30dUsd: 0, simulated: false },
      }),
    );

    const d1 = await runCycle(makeConfig(), NOW);
    const a1 = (await readAlloc())!;
    assert.equal(a1.allocations['solana-trader'], 360);
    assert.equal(a1.allocations['liquidation-hunter'], 270);
    assert.equal(a1.allocations.broken, 0);
    assert.deepEqual(a1.paused, ['broken']);
    assert.equal(a1.totalCapitalUsd, 1000);
    assert.ok(d1.events.some((e) => e.type === 'strategy-paused'));
    const events = await fs.readFile(statePaths.events(), 'utf8');
    assert.match(events, /strategy-paused/);
    await fs.access(orchestratorStatePath());

    // Next cycle: +40 realized trading, +10 trading revenue (ignored), +30 ai-services revenue.
    await writeJsonAtomic(statePaths.strategy('solana-trader'), makeReport({ name: 'solana-trader', realizedPnlUsd: 50 }));
    await writeJsonAtomic(
      statePaths.revenue(),
      makeRevenue({
        'solana-trader': { kind: 'trading', totalUsd: 50, last7dUsd: 0, last30dUsd: 0, simulated: true },
        'ai-services': { kind: 'ai-services', totalUsd: 50, last7dUsd: 0, last30dUsd: 0, simulated: false },
      }),
    );
    await runCycle(makeConfig(), NOW);
    const a2 = (await readAlloc())!;
    // delta 70 -> 50 % reinvested -> capital 1035
    assert.equal(a2.totalCapitalUsd, 1035);
    const p2 = (await readJsonSafe<PortfolioState | null>(statePaths.portfolio(), null))!;
    assert.equal(p2.reinvestedUsd, 35);
    assert.ok(p2.allocatedUsd <= p2.totalCapitalUsd * 0.9);
  });

  it('KILL file zeroes every allocation', async () => {
    await fs.writeFile(statePaths.kill(), '');
    await runCycle(makeConfig(), NOW);
    const a = (await readAlloc())!;
    assert.equal(a.killSwitch, true);
    assert.ok(Object.values(a.allocations).every((v) => v === 0));
    await fs.rm(statePaths.kill());
  });

  it('drawdown kill switch latches until reset', async () => {
    await writeJsonAtomic(statePaths.strategy('solana-trader'), makeReport({ name: 'solana-trader', realizedPnlUsd: 50, unrealizedPnlUsd: -400 }));
    await runCycle(makeConfig(), NOW);
    assert.equal((await readAlloc())!.killSwitch, true);
    assert.equal((await loadState()).killSwitch.tripped, true);
    await resetKillSwitch();
    await runCycle(makeConfig(), NOW);
    const a = (await readAlloc())!;
    assert.equal(a.killSwitch, false);
    assert.ok(a.allocations['solana-trader']! > 0);
  });
});
