import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { extractiveSummary } from './handlers/builtin.ts';
import { agentAccount, balanceOf, checkInvariants, PLATFORM } from './ledger.ts';
import { MarketError } from './marketplace.ts';
import { statePaths, writeJsonAtomic } from './mm-contract.ts';
import { seedMarketplace } from './seed.ts';
import { seededMarket, useTempStateDir } from './test/helpers.ts';
import type { SendFn } from './webhook.ts';

useTempStateDir();

const usd = (m: ReturnType<typeof seededMarket>['m'], agentId: string) => m.balance(agentId).balanceUsd;

test('escrow success via marketplace: provider paid minus fee, revenue event = job id', async () => {
  const { m, buyer } = seededMarket();
  const seeded = seedMarketplace(m);
  const job = m.requestJob(buyer.agent.id, { capability: 'summarize', input: { text: 'One. Two. Three.' } });
  assert.equal(job.status, 'queued');
  assert.equal(usd(m, buyer.agent.id), 9.98);
  assert.deepEqual(checkInvariants(m.state), []);
  const done = await m.runJob(job.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { mode: 'fallback', summary: 'One. Two.', note: (done.result as { note: string }).note });
  assert.equal(done.feeUsd, 0.002);
  assert.equal(usd(m, seeded.agentId), 0.018);
  assert.equal(balanceOf(m.state, PLATFORM), 2_000);
  assert.deepEqual(m.state.revenueEvents, [{ id: job.id, timestamp: done.timings.finishedAt, amountUsd: 0.002, serviceId: job.serviceId }]);
  assert.deepEqual(checkInvariants(m.state), []);
  const r = m.report();
  assert.equal(r.jobsCompleted, 1);
  assert.equal(r.grossVolumeUsd, 0.02);
  assert.equal(r.platformRevenueUsd, 0.002);
});

test('escrow failure via marketplace: handler error refunds requester and hurts reputation', async () => {
  const { m, buyer } = seededMarket();
  seedMarketplace(m);
  const job = m.requestJob(buyer.agent.id, { capability: 'summarize', input: { wrong: true } });
  const done = await m.runJob(job.id);
  assert.equal(done.status, 'refunded');
  assert.match(done.error ?? '', /invalid input/);
  assert.equal(usd(m, buyer.agent.id), 10);
  assert.equal(balanceOf(m.state, PLATFORM), 0);
  assert.equal(m.state.revenueEvents.length, 0);
  assert.equal(m.state.reputation.services[job.serviceId]?.failures, 1);
  assert.deepEqual(checkInvariants(m.state), []);
  assert.equal(m.report().jobsFailed, 1);
});

test('insufficient funds, self-dealing and missing provider are rejected without moving money', () => {
  const { m, platform } = seededMarket();
  seedMarketplace(m);
  const poor = m.registerAgent({ name: 'poor' });
  assert.throws(() => m.requestJob(poor.agent.id, { capability: 'summarize', input: { text: 'x' } }), (e: unknown) => e instanceof MarketError && e.status === 402);
  assert.throws(() => m.requestJob(platform.agent.id, { capability: 'summarize', input: {} }), (e: unknown) => e instanceof MarketError && e.code === 'no_provider');
  assert.throws(() => m.requestJob(poor.agent.id, { capability: 'nope', input: {} }), (e: unknown) => e instanceof MarketError && e.status === 404);
  assert.deepEqual(checkInvariants(m.state), []);
  assert.equal(Object.keys(m.state.jobs).length, 0);
});

test('revenue split pays extra recipients and validates sums', async () => {
  const send: SendFn = async () => ({ status: 200, body: '{"answer":42}' });
  const { m, buyer } = seededMarket(
    { webhookAllowlist: ['hooks.example.com'] },
    { webhookSend: send, webhookLookup: async () => [{ address: '93.184.216.34', family: 4 }] },
  );
  const seller = m.registerAgent({ name: 'seller' });
  const referrer = m.registerAgent({ name: 'referrer' });
  const upstream = m.registerAgent({ name: 'upstream' });
  assert.throws(
    () =>
      m.createService(seller.agent.id, {
        name: 'x', capability: 'qa', description: '', priceUsd: 1, handler: 'webhook:https://hooks.example.com/qa',
        splits: [{ agentId: referrer.agent.id, pct: 60 }, { agentId: upstream.agent.id, pct: 50 }],
      }),
    /more than 100/,
  );
  const { service, webhookSecret } = m.createService(seller.agent.id, {
    name: 'QA', capability: 'qa', description: 'answers', priceUsd: 2, handler: 'webhook:https://hooks.example.com/qa',
    splits: [{ agentId: referrer.agent.id, pct: 10 }, { agentId: upstream.agent.id, pct: 30 }],
  });
  assert.ok(webhookSecret && webhookSecret.length === 64);
  assert.equal('webhookSecret' in m.publicService(service), false);
  const job = await m.runJob(m.requestJob(buyer.agent.id, { serviceId: service.id, input: { q: '?' } }).id);
  assert.equal(job.status, 'completed');
  assert.deepEqual(job.result, { answer: 42 });
  // price 2.00, fee 0.20, net 1.80 → referrer 0.18, upstream 0.54, seller 1.08
  assert.equal(usd(m, referrer.agent.id), 0.18);
  assert.equal(usd(m, upstream.agent.id), 0.54);
  assert.equal(usd(m, seller.agent.id), 1.08);
  assert.equal(usd(m, buyer.agent.id), 8);
  assert.deepEqual(checkInvariants(m.state), []);
});

test('webhook to a non-allowlisted host is rejected at registration; private DNS fails the job with refund', async () => {
  const { m, buyer } = seededMarket(
    { webhookAllowlist: ['hooks.example.com'] },
    { webhookLookup: async () => [{ address: '10.0.0.1', family: 4 }], webhookSend: async () => assert.fail('must not send') },
  );
  const seller = m.registerAgent({ name: 'seller' });
  assert.throws(
    () => m.createService(seller.agent.id, { name: 'x', capability: 'qa', description: '', priceUsd: 1, handler: 'webhook:https://169.254.169.254/' }),
    /WEBHOOK_ALLOWLIST/,
  );
  assert.throws(
    () => m.createService(seller.agent.id, { name: 'x', capability: 'qa', description: '', priceUsd: 1, handler: 'builtin:echo' }),
    /platform agent/,
  );
  const { service } = m.createService(seller.agent.id, { name: 'x', capability: 'qa', description: '', priceUsd: 1, handler: 'webhook:https://hooks.example.com/' });
  const job = await m.runJob(m.requestJob(buyer.agent.id, { serviceId: service.id, input: {} }).id);
  assert.equal(job.status, 'refunded');
  assert.match(job.error ?? '', /private/);
  assert.equal(usd(m, buyer.agent.id), 10);
  assert.deepEqual(checkInvariants(m.state), []);
});

test('payment routing picks the best provider by routing score and reputation evolves', async () => {
  const send: SendFn = async (req) => (req.url.pathname === '/bad' ? { status: 400, body: '{}' } : { status: 200, body: '{"ok":true}' });
  const { m, buyer } = seededMarket(
    { webhookAllowlist: ['hooks.example.com'] },
    { webhookSend: send, webhookLookup: async () => [{ address: '93.184.216.34', family: 4 }] },
  );
  m.deposit(buyer.agent.id, 100);
  const a = m.registerAgent({ name: 'a' });
  const b = m.registerAgent({ name: 'b' });
  const cheapBad = m.createService(a.agent.id, { name: 'cheap', capability: 'translate', description: '', priceUsd: 0.9, handler: 'webhook:https://hooks.example.com/bad' }).service;
  const good = m.createService(b.agent.id, { name: 'good', capability: 'translate', description: '', priceUsd: 1, handler: 'webhook:https://hooks.example.com/good' }).service;
  // with no history the cheaper one wins
  assert.equal(m.listServices({ capability: 'translate' })[0]?.service.id, cheapBad.id);
  for (let i = 0; i < 6; i++) await m.runJob(m.requestJob(buyer.agent.id, { serviceId: cheapBad.id, input: {} }).id);
  for (let i = 0; i < 6; i++) {
    const j = await m.runJob(m.requestJob(buyer.agent.id, { serviceId: good.id, input: {} }).id);
    m.rateJob(buyer.agent.id, j.id, 5);
  }
  const routed = m.requestJob(buyer.agent.id, { capability: 'translate', input: {} });
  assert.equal(routed.serviceId, good.id);
  assert.equal(m.state.reputation.services[good.id]?.ratingCount, 6);
  assert.equal(m.state.reputation.services[cheapBad.id]?.failures, 6);
  // maxPrice excludes the good one
  const capped = m.requestJob(buyer.agent.id, { capability: 'translate', input: {}, maxPriceUsd: 0.95 });
  assert.equal(capped.serviceId, cheapBad.id);
  await m.processQueue();
  assert.deepEqual(checkInvariants(m.state), []);
});

test('ratings: only requester, only completed, only once', async () => {
  const { m, buyer } = seededMarket();
  seedMarketplace(m);
  const other = m.registerAgent({ name: 'other' });
  const job = await m.runJob(m.requestJob(buyer.agent.id, { capability: 'echo', input: 'hi' }).id);
  assert.deepEqual(job.result, { echo: 'hi' });
  assert.throws(() => m.rateJob(other.agent.id, job.id, 5), (e: unknown) => e instanceof MarketError && e.status === 403);
  m.rateJob(buyer.agent.id, job.id, 4);
  assert.throws(() => m.rateJob(buyer.agent.id, job.id, 5), /already rated/);
});

test('kill switch blocks new jobs and pauses the queue', async () => {
  const { m, buyer } = seededMarket();
  seedMarketplace(m);
  const job = m.requestJob(buyer.agent.id, { capability: 'echo', input: 1 });
  fs.writeFileSync(statePaths.kill(), '');
  try {
    assert.throws(() => m.requestJob(buyer.agent.id, { capability: 'echo', input: 1 }), (e: unknown) => e instanceof MarketError && e.status === 503);
    assert.equal(await m.processQueue(), 0);
    assert.equal(m.getJob(job.id).status, 'queued');
  } finally {
    fs.rmSync(statePaths.kill());
  }
  await m.processQueue();
  assert.equal(m.getJob(job.id).status, 'completed');
});

test('summarize uses Claude when available, falls back on SKIP; mm-status reads state', async () => {
  const { m, buyer } = seededMarket({}, { askClaude: async () => 'A crisp one-line summary.' });
  seedMarketplace(m);
  const j1 = await m.runJob(m.requestJob(buyer.agent.id, { capability: 'summarize', input: { text: 'Long text here. More.' } }).id);
  assert.deepEqual(j1.result, { mode: 'claude', summary: 'A crisp one-line summary.' });

  const { m: m2, buyer: b2 } = seededMarket({}, { askClaude: async () => 'SKIP' });
  seedMarketplace(m2);
  const j2 = await m2.runJob(m2.requestJob(b2.agent.id, { capability: 'summarize', input: { text: 'First. Second. Third.' } }).id);
  assert.equal((j2.result as { mode: string }).mode, 'fallback');

  await writeJsonAtomic(statePaths.portfolio(), {
    schema: 'mm.portfolio/v1', timestamp: 't', totalCapitalUsd: 1000, allocatedUsd: 800, reserveUsd: 200, totalPnlUsd: 5,
    portfolioReturn: 0.005, maxDrawdown: 0.01, riskScore: 0.2, activeStrategies: ['solana-trader'], pausedStrategies: [], reinvestedUsd: 0,
  });
  const j3 = await m.runJob(m.requestJob(buyer.agent.id, { capability: 'mm-status', input: null }).id);
  const res = j3.result as { portfolio: { totalCapitalUsd: number }; killSwitch: boolean };
  assert.equal(res.portfolio.totalCapitalUsd, 1000);
  assert.equal(res.killSwitch, false);
  assert.equal(extractiveSummary('Hello world. Bye now! Third?', 2), 'Hello world. Bye now!');
});
