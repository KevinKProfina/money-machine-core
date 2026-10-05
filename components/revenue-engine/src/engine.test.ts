import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { runCycle } from './engine.js';
import { type MarketplaceReport, type MMEvent, readJsonSafe, statePaths, writeJsonAtomic } from './mm-contract.js';
import { enginePaths, loadEvents, loadState } from './store.js';
import { fixture, fixtureFetch, strategyReport, useTempStateDir } from './test-utils.js';
import { type ExtendedRevenueReport, silentLogger } from './types.js';

async function readEvents(): Promise<MMEvent[]> {
  const text = await fsp.readFile(statePaths.events(), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as MMEvent);
}

test('full --once cycle: trading + marketplace + inbox + stripe + gumroad, then idempotent rerun', async () => {
  await useTempStateDir();
  await writeJsonAtomic(statePaths.strategy('solana-trader'), strategyReport({ name: 'solana-trader', realizedPnlUsd: 40, lastUpdated: '2026-10-03T00:00:00.000Z' }));
  await writeJsonAtomic(
    statePaths.strategy('liquidation-hunter'),
    strategyReport({ name: 'liquidation-hunter', kind: 'liquidation', realizedPnlUsd: 10, lastUpdated: '2026-10-03T00:00:00.000Z' }),
  );
  const market: MarketplaceReport = {
    schema: 'mm.marketplace/v1',
    timestamp: '2026-10-03T00:00:00.000Z',
    agents: 2,
    services: 3,
    jobsCompleted: 2,
    jobsFailed: 0,
    grossVolumeUsd: 100,
    platformRevenueUsd: 10,
    revenueEvents: [
      { id: 'm1', timestamp: '2026-10-02T00:00:00.000Z', amountUsd: 6, serviceId: 'svc-a' },
      { id: 'm2', timestamp: '2026-10-03T00:00:00.000Z', amountUsd: 4, serviceId: 'svc-b' },
      { id: 'm2', timestamp: '2026-10-03T00:00:00.000Z', amountUsd: 4, serviceId: 'svc-b' },
    ],
  };
  await writeJsonAtomic(statePaths.marketplace(), market);
  await fsp.mkdir(enginePaths.inbox(), { recursive: true });
  await fsp.writeFile(path.join(enginePaths.inbox(), 'aff.csv'), 'id,stream,kind,amountUsd,timestamp,note\naff-1,affiliate,affiliate,25,2026-10-01T00:00:00Z,payout\n');

  const { fetchImpl } = fixtureFetch([
    { match: (u) => u.includes('api.stripe.com') && u.includes('starting_after'), body: fixture('stripe-page2.json') },
    { match: (u) => u.includes('api.stripe.com'), body: fixture('stripe-page1.json') },
    { match: (u) => u.includes('api.gumroad.com'), status: 500, body: { error: 'down' } },
  ]);
  const env = { STRIPE_API_KEY: 'sk_live_fixture', GUMROAD_ACCESS_TOKEN: 'tok', REVENUE_SOURCES: '', REVENUE_HTTP_BACKOFF_MS: '1' };
  const now = new Date('2026-10-04T00:00:00.000Z');

  // Gumroad fails (5xx, retries exhausted) → degraded, cycle still succeeds.
  const first = await runCycle({ now, env, fetchImpl, log: silentLogger });
  const report = await readJsonSafe<ExtendedRevenueReport | null>(statePaths.revenue(), null);
  assert.ok(report);
  assert.equal(report.schema, 'mm.revenue/v1');
  assert.equal(report.streams['solana-trader'].totalUsd, 40);
  assert.equal(report.streams['solana-trader'].simulated, true);
  assert.equal(report.streams['liquidation-hunter'].kind, 'liquidation');
  assert.equal(report.streams['agent-marketplace'].totalUsd, 10);
  assert.equal(report.streams['agent-marketplace'].simulated, true);
  assert.equal(report.streams.affiliate.totalUsd, 25);
  assert.equal(report.streams.stripe.kind, 'saas');
  assert.equal(report.streams.stripe.totalUsd, 6.19);
  assert.ok(report.recommendations.length > 0);
  const gum = first.sources.find((s) => s.name === 'gumroad');
  assert.equal(gum?.ok, false);
  assert.equal(first.added.length, 2 + 2 + 1 + 6);

  const state = await loadState();
  assert.equal(state.tradingLastSeen['solana-trader:paper'].realizedPnlUsd, 40);
  assert.ok(state.cursors.stripe);
  assert.equal(state.cursors.gumroad, undefined, 'failed source must not advance its cursor');
  assert.equal((await fsp.readdir(enginePaths.inboxProcessed())).length, 1);

  const mmEvents = await readEvents();
  assert.ok(mmEvents.some((e) => e.type === 'revenue.new' && e.source === 'revenue-engine'));
  assert.ok(mmEvents.some((e) => e.type === 'revenue.source-failed'));

  // Second run with the same inputs: no duplicates, no new events.
  const second = await runCycle({ now: new Date('2026-10-04T01:00:00.000Z'), env, fetchImpl, log: silentLogger });
  assert.equal(second.added.length, 0);
  assert.equal((await loadEvents()).length, 11);

  // Strategy books more PnL → only the delta is added.
  await writeJsonAtomic(statePaths.strategy('solana-trader'), strategyReport({ name: 'solana-trader', realizedPnlUsd: 45.5, lastUpdated: '2026-10-04T00:30:00.000Z' }));
  const third = await runCycle({ now: new Date('2026-10-04T02:00:00.000Z'), env, fetchImpl, log: silentLogger });
  assert.deepEqual(third.added.map((e) => e.amountUsd), [5.5]);
  assert.equal(third.report.streams['solana-trader'].totalUsd, 45.5);
});

test('empty state dir with no secrets: cycle succeeds and writes an empty report', async () => {
  const dir = await useTempStateDir();
  const { report, added } = await runCycle({ env: {}, log: silentLogger });
  assert.equal(added.length, 0);
  assert.equal(report.totalUsd, 0);
  assert.equal(report.concentration, 0);
  const onDisk = await readJsonSafe<ExtendedRevenueReport | null>(path.join(dir, 'revenue.json'), null);
  assert.equal(onDisk?.schema, 'mm.revenue/v1');
});
