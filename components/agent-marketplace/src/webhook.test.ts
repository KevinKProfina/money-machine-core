import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  callWebhook,
  hostAllowed,
  isPrivateIp,
  resolveWebhookTarget,
  signPayload,
  validateWebhookUrl,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  type SendFn,
} from './webhook.ts';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('private / reserved IPs are detected', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', 'not-an-ip']) {
    assert.ok(isPrivateIp(ip), `${ip} should be private`);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.ok(!isPrivateIp(ip), `${ip} should be public`);
  }
});

test('allowlist matching: exact and *.suffix', () => {
  assert.ok(hostAllowed('api.example.com', ['api.example.com']));
  assert.ok(hostAllowed('API.example.com.', ['api.example.com']));
  assert.ok(!hostAllowed('evil-api.example.com', ['api.example.com']));
  assert.ok(hostAllowed('a.b.example.com', ['*.example.com']));
  assert.ok(!hostAllowed('example.com', ['*.example.com']));
  assert.ok(!hostAllowed('example.com.evil.net', ['*.example.com']));
  assert.ok(!hostAllowed('anything.com', []));
});

test('static URL validation: https, allowlist, no creds, no private literals', () => {
  const opts = { allowlist: ['hooks.example.com', '127.0.0.1', '169.254.169.254'] };
  assert.equal(validateWebhookUrl('https://hooks.example.com/x', opts).hostname, 'hooks.example.com');
  assert.throws(() => validateWebhookUrl('http://hooks.example.com/x', opts), /https/);
  assert.throws(() => validateWebhookUrl('https://other.example.com/x', opts), /WEBHOOK_ALLOWLIST/);
  assert.throws(() => validateWebhookUrl('https://u:p@hooks.example.com/x', opts), /credentials/);
  assert.throws(() => validateWebhookUrl('https://127.0.0.1/x', opts), /private/);
  assert.throws(() => validateWebhookUrl('https://169.254.169.254/latest', opts), /private/);
  assert.throws(() => validateWebhookUrl('file:///etc/passwd', opts));
  assert.throws(() => validateWebhookUrl('not a url', opts), /invalid/);
});

test('DNS guard: allowlisted host resolving to a private IP is denied', async () => {
  const opts = { allowlist: ['hooks.example.com'] };
  await assert.rejects(
    resolveWebhookTarget('https://hooks.example.com/x', { ...opts, lookup: async () => [{ address: '10.0.0.5', family: 4 }] }),
    /private/,
  );
  await assert.rejects(
    resolveWebhookTarget('https://hooks.example.com/x', {
      ...opts,
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }),
    /private/,
  );
  const ok = await resolveWebhookTarget('https://hooks.example.com/x', { ...opts, lookup: publicLookup });
  assert.equal(ok.address, '93.184.216.34');
});

test('callWebhook signs the body with HMAC-SHA256 and pins the resolved IP', async () => {
  let seen: Parameters<SendFn>[0] | undefined;
  const send: SendFn = async (req) => {
    seen = req;
    return { status: 200, body: JSON.stringify({ ok: true }) };
  };
  const out = await callWebhook('https://hooks.example.com/run', { hello: 'world' }, {
    allowlist: ['hooks.example.com'],
    lookup: publicLookup,
    send,
    secret: 's3cret',
    timeoutMs: 1000,
    jobId: 'job_1',
  });
  assert.deepEqual(out, { ok: true });
  assert.ok(seen);
  assert.equal(seen.address, '93.184.216.34');
  const ts = seen.headers[TIMESTAMP_HEADER]!;
  const expected = 'sha256=' + createHmac('sha256', 's3cret').update(`${ts}.${seen.body}`).digest('hex');
  assert.equal(seen.headers[SIGNATURE_HEADER], expected);
  assert.equal(signPayload('s3cret', ts, seen.body), expected);
  assert.equal(seen.headers['x-marketplace-job-id'], 'job_1');
});

test('callWebhook retries 5xx with backoff, not 4xx, and rejects invalid JSON', async () => {
  const base = { allowlist: ['hooks.example.com'], lookup: publicLookup, secret: 's', timeoutMs: 1000, jobId: 'j', backoffMs: 1 };
  let calls = 0;
  const flaky: SendFn = async () => (++calls === 1 ? { status: 503, body: '' } : { status: 200, body: '{"v":1}' });
  assert.deepEqual(await callWebhook('https://hooks.example.com/', {}, { ...base, send: flaky }), { v: 1 });
  assert.equal(calls, 2);

  calls = 0;
  const bad: SendFn = async () => {
    calls++;
    return { status: 400, body: '{}' };
  };
  await assert.rejects(callWebhook('https://hooks.example.com/', {}, { ...base, send: bad }), /HTTP 400/);
  assert.equal(calls, 1);

  await assert.rejects(
    callWebhook('https://hooks.example.com/', {}, { ...base, send: async () => ({ status: 200, body: 'nope' }) }),
    /invalid JSON/,
  );
  // denied before any request is sent
  let sent = false;
  await assert.rejects(
    callWebhook('https://evil.example.net/', {}, { ...base, send: async () => ((sent = true), { status: 200, body: '{}' }) }),
    /WEBHOOK_ALLOWLIST/,
  );
  assert.equal(sent, false);
});
