import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addressPort, startDaemon, type Daemon } from './app.ts';
import { checkInvariants } from './ledger.ts';
import { seedMarketplace } from './seed.ts';
import { testConfig, useTempStateDir } from './test/helpers.ts';

useTempStateDir();
const ADMIN = 'test-admin-token';
let daemon: Daemon;
let base: string;

before(async () => {
  daemon = await startDaemon(testConfig({ adminToken: ADMIN, maxBodyBytes: 2048 }), { askClaude: undefined, log: () => {} });
  seedMarketplace(daemon.market);
  base = `http://127.0.0.1:${addressPort(daemon.server)}`;
});

after(async () => {
  await daemon.stop();
});

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as any };
}

test('HTTP API happy path: register, deposit, discover, job, rating, balance, metrics', async () => {
  const health = await call('GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');

  const reg = await call('POST', '/agents', { name: 'buyer-bot' });
  assert.equal(reg.status, 201);
  const key: string = reg.json.apiKey;
  const id: string = reg.json.agent.id;
  assert.ok(key.startsWith('amk_'));
  assert.equal(reg.json.agent.apiKeyHash, undefined);

  assert.equal((await call('POST', '/deposits', { agentId: id, amountUsd: 1 }, 'wrong')).status, 401);
  assert.equal((await call('POST', '/deposits', { agentId: id, amountUsd: 1 }, key)).status, 401);
  const dep = await call('POST', '/deposits', { agentId: id, amountUsd: 1 }, ADMIN);
  assert.equal(dep.status, 201);
  assert.equal(dep.json.balanceUsd, 1);

  const list = await call('GET', '/services?capability=summarize');
  assert.equal(list.status, 200);
  assert.equal(list.json.services.length, 1);
  assert.equal(list.json.services[0].capability, 'summarize');
  assert.equal(typeof list.json.services[0].routingScore, 'number');

  const job = await call('POST', '/jobs', { capability: 'summarize', input: { text: 'Alpha is first. Beta is second. Gamma.' }, wait: true }, key);
  assert.equal(job.status, 200);
  assert.equal(job.json.status, 'completed');
  assert.equal(job.json.result.mode, 'fallback');

  const fetched = await call('GET', `/jobs/${job.json.id}`, undefined, key);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.id, job.json.id);

  const rated = await call('POST', `/jobs/${job.json.id}/rating`, { rating: 5 }, key);
  assert.equal(rated.status, 200);
  assert.equal(rated.json.rating, 5);

  const bal = await call('GET', `/agents/${id}/balance`, undefined, key);
  assert.equal(bal.json.balanceUsd, 0.98);

  const async = await call('POST', '/jobs', { capability: 'echo', input: { ping: 1 } }, key);
  assert.equal(async.status, 202);
  await daemon.market.runJob(async.json.id);
  assert.equal((await call('GET', `/jobs/${async.json.id}`, undefined, key)).json.status, 'completed');

  const metrics = await call('GET', '/metrics');
  assert.equal(metrics.json.schema, 'mm.marketplace/v1');
  assert.equal(metrics.json.jobsCompleted, 2);
  assert.equal(metrics.json.platformRevenueUsd, 0.002);
  assert.equal(metrics.json.revenueEvents[0].id, job.json.id);
  assert.deepEqual(checkInvariants(daemon.market.state), []);
});

test('HTTP API rejects bad keys, bad input, oversize bodies and foreign jobs with error JSON', async () => {
  const noAuth = await call('POST', '/jobs', { capability: 'echo', input: 1 });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.json.error.code, 'unauthorized');
  assert.equal((await call('POST', '/jobs', { capability: 'echo', input: 1 }, 'amk_bogus')).status, 401);
  assert.equal((await call('POST', '/services', { name: 'x' }, 'amk_bogus')).status, 401);

  const a = (await call('POST', '/agents', { name: 'a' })).json;
  const b = (await call('POST', '/agents', { name: 'b' })).json;
  const invalid = await call('POST', '/jobs', { serviceId: 'x', capability: 'y' }, a.apiKey);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'validation_error');
  assert.equal((await call('POST', '/agents', '{not json')).json.error.code, 'invalid_json');
  const big = await call('POST', '/agents', { name: 'x'.repeat(5000) });
  assert.equal(big.status, 413);
  assert.equal((await call('POST', '/jobs', { capability: 'echo', input: 1 }, a.apiKey)).status, 202); // echo is free
  const poor = await call('POST', '/jobs', { capability: 'summarize', input: { text: 'x' } }, a.apiKey);
  assert.equal(poor.status, 402);
  assert.equal((await call('GET', `/agents/${a.agent.id}/balance`, undefined, b.apiKey)).status, 403);
  assert.equal((await call('GET', '/nope')).status, 404);
  const dup = await call('POST', '/services', { name: 's', capability: 'c', priceUsd: 1, handler: 'webhook:https://evil.example.net/' }, a.apiKey);
  assert.equal(dup.status, 400);
  assert.equal(dup.json.error.code, 'invalid_handler');
});
