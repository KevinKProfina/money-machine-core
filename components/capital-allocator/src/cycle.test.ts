import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCycle } from './cycle.js';
import { readJsonSafe, statePaths, writeJsonAtomic, type AllocationProposal } from './mm-contract.js';
import { formatProposalTable } from './report.js';
import { makeConfig, makeReport } from './test/fixtures.js';

describe('full --once cycle against a temp MM_STATE_DIR', () => {
  let dir: string;
  const prevDir = process.env.MM_STATE_DIR;
  const log = console.log;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-alloc-'));
    process.env.MM_STATE_DIR = dir;
    console.log = () => {};
  });
  after(async () => {
    console.log = log;
    if (prevDir === undefined) delete process.env.MM_STATE_DIR;
    else process.env.MM_STATE_DIR = prevDir;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes an empty proposal when there are no reports (no demo data)', async () => {
    const res = await runCycle(makeConfig());
    assert.equal(res.reportCount, 0);
    const p = await readJsonSafe<AllocationProposal | null>(statePaths.proposal(), null);
    assert.ok(p);
    assert.deepEqual(p.allocations, {});
    // nothing else written to the state dir
    assert.deepEqual((await fs.readdir(dir)).sort(), ['allocation-proposal.json']);
  });

  it('scores fixture reports and writes the proposal', async () => {
    await writeJsonAtomic(statePaths.strategy('solana-trader'), makeReport({ name: 'solana-trader', totalTrades: 40 }));
    await writeJsonAtomic(
      statePaths.strategy('liquidation-hunter'),
      makeReport({ name: 'liquidation-hunter', kind: 'liquidation', totalTrades: 3, totalReturn: 0.5 }),
    );
    await writeJsonAtomic(statePaths.strategy('dead'), makeReport({ name: 'dead', status: 'failed' }));
    await fs.writeFile(path.join(statePaths.strategiesDir(), 'garbage.json'), '{not json', 'utf8');

    const res = await runCycle(makeConfig({ totalCapitalUsd: 2000 }));
    assert.equal(res.reportCount, 3);
    const p = (await readJsonSafe<AllocationProposal | null>(statePaths.proposal(), null))!;
    assert.equal(p.totalCapitalUsd, 2000);
    assert.equal(p.allocations.dead, 0);
    assert.ok(p.allocations['solana-trader']! > 0);
    assert.ok(p.allocations['liquidation-hunter']! > 0);
    const total = Object.values(p.allocations).reduce((s, v) => s + v, 0);
    assert.ok(total <= 2000);
    assert.match(formatProposalTable(p), /solana-trader/);
  });
});
