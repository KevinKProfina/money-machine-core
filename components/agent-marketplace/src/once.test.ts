import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openMarketplace, runOnce } from './app.ts';
import { checkInvariants } from './ledger.ts';
import { statePaths, type MarketplaceReport } from './mm-contract.ts';
import { seedMarketplace } from './seed.ts';
import { testConfig, useTempStateDir } from './test/helpers.ts';

const dir = useTempStateDir();

function assertValidReport(r: MarketplaceReport): void {
  assert.equal(r.schema, 'mm.marketplace/v1');
  assert.ok(!Number.isNaN(Date.parse(r.timestamp)));
  for (const k of ['agents', 'services', 'jobsCompleted', 'jobsFailed', 'grossVolumeUsd', 'platformRevenueUsd'] as const) {
    assert.equal(typeof r[k], 'number', k);
    assert.ok(r[k] >= 0);
  }
  assert.ok(Array.isArray(r.revenueEvents));
  for (const e of r.revenueEvents) {
    assert.equal(typeof e.id, 'string');
    assert.equal(typeof e.amountUsd, 'number');
    assert.equal(typeof e.serviceId, 'string');
  }
  const ids = r.revenueEvents.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'revenue event ids are unique');
}

test('--once processes queued jobs from persisted state and writes marketplace.json', async () => {
  const config = testConfig();
  // previous daemon session: seeded, buyer funded, two jobs queued but never executed
  const m = await openMarketplace(config, { log: () => {} });
  seedMarketplace(m);
  const buyer = m.registerAgent({ name: 'buyer' });
  m.deposit(buyer.agent.id, 1);
  const j1 = m.requestJob(buyer.agent.id, { capability: 'mm-status', input: null });
  const j2 = m.requestJob(buyer.agent.id, { capability: 'summarize', input: { nope: 1 } });
  await m.flush();

  const report = await runOnce(config, { log: () => {} });
  assert.ok(report);
  const onDisk = JSON.parse(fs.readFileSync(statePaths.marketplace(), 'utf8')) as MarketplaceReport;
  assertValidReport(onDisk);
  assert.equal(onDisk.jobsCompleted, 1);
  assert.equal(onDisk.jobsFailed, 1);
  assert.equal(onDisk.platformRevenueUsd, 0.005);
  assert.deepEqual(onDisk.revenueEvents.map((e) => e.id), [j1.id]);

  const reloaded = await openMarketplace(config);
  assert.equal(reloaded.getJob(j1.id).status, 'completed');
  assert.equal(reloaded.getJob(j2.id).status, 'refunded');
  assert.deepEqual(checkInvariants(reloaded.state), []);

  // second run is idempotent: revenue events are not duplicated
  await runOnce(config, { log: () => {} });
  const again = JSON.parse(fs.readFileSync(statePaths.marketplace(), 'utf8')) as MarketplaceReport;
  assert.deepEqual(again.revenueEvents, onDisk.revenueEvents);
  assert.ok(!fs.existsSync(path.join(dir, 'agent-marketplace', 'marketplace.lock')), 'lock released');
});

test('`tsx src/index.ts --once` succeeds on an empty state dir with no secrets', () => {
  const fresh = fs.mkdtempSync(path.join(path.dirname(dir), 'agent-mkt-once-'));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const env: NodeJS.ProcessEnv = { ...process.env, MM_STATE_DIR: fresh };
  delete env.ANTHROPIC_API_KEY;
  delete env.ADMIN_TOKEN;
  execFileSync(process.execPath, ['--import', 'tsx', 'src/index.ts', '--once'], { cwd: root, env, stdio: 'pipe' });
  const r = JSON.parse(fs.readFileSync(path.join(fresh, 'marketplace.json'), 'utf8')) as MarketplaceReport;
  assertValidReport(r);
  assert.equal(r.jobsCompleted, 0);
});
