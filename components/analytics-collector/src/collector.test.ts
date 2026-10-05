import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readConfig, type CollectorConfig } from './config.js';
import { runOnce, startCollector, type RunningCollector } from './index.js';
import { DailyVisitors, isBot, normalizePath, RateLimiter, referrerHost } from './privacy.js';
import { validateBeacon, type StatsResponse } from './server.js';
import { analyticsPaths, type DayAggregate } from './store.js';

const ORIGIN = 'https://shop.example.test';
const SITE = 'shop.example.test';
const TOKEN = 'read-token-0123456789abcdef';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const UA2 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

let dir: string;
let running: RunningCollector | undefined;
const clock = { t: Date.UTC(2026, 9, 5, 10) };
const now = () => new Date(clock.t);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analytics-test-'));
  process.env.MM_STATE_DIR = dir;
  clock.t = Date.UTC(2026, 9, 5, 10);
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

function cfg(env: Record<string, string> = {}): CollectorConfig {
  return readConfig({ ANALYTICS_ALLOWED_ORIGINS: ORIGIN, ANALYTICS_READ_TOKEN: TOKEN, PORT: '0', ANALYTICS_TRUST_PROXY: '1', ANALYTICS_FLUSH_INTERVAL_MS: '3600000', ...env });
}

async function start(env: Record<string, string> = {}): Promise<RunningCollector> {
  running = await startCollector(cfg(env), { now, log: () => undefined });
  return running;
}

type Res = { status: number; headers: http.IncomingHttpHeaders; body: string };

function req(c: RunningCollector, method: string, p: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: c.port, method, path: p, headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

function beacon(c: RunningCollector, body: unknown, h: Record<string, string> = {}): Promise<Res> {
  return req(c, 'POST', '/e', {
    headers: { Origin: ORIGIN, 'Content-Type': 'text/plain;charset=UTF-8', 'User-Agent': UA, 'X-Forwarded-For': '203.0.113.7', ...h },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const dayFile = (day = '2026-10-05') => analyticsPaths.day(SITE, day);
const readDay = (day = '2026-10-05') => JSON.parse(fs.readFileSync(dayFile(day), 'utf8')) as DayAggregate;

// ---------------------------------------------------------------- pure helpers

test('beacon validation: fields, events, paths, unknown keys, site allow-list', () => {
  assert.equal(validateBeacon({ site: SITE, path: '/a/', event: 'pageview' }).ok, true);
  assert.equal(validateBeacon({ site: SITE, path: '/a/', event: 'buy_click', ref: 'https://x.test/' }).ok, true);
  for (const bad of [null, [], 'x', { site: SITE, path: '/a/' }, { site: SITE, path: '/a/', event: 'purchase' }, { site: 'Shop Example', path: '/', event: 'pageview' }, { site: SITE, path: 'a', event: 'pageview' }, { site: SITE, path: '/', event: 'pageview', email: 'x@y.z' }, { site: SITE, path: '/', event: 'pageview', ref: 5 }]) {
    assert.equal(validateBeacon(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(validateBeacon({ site: SITE, path: '/', event: 'pageview' }, ['other.test']).ok, false);
  const v = validateBeacon({ site: SITE, path: '/slug/0123456789abcdef0123456789abcdef/?utm=1#x', event: 'download' });
  assert.ok(v.ok);
  assert.equal(v.ok && v.beacon.path, '/slug/:token/', 'secret tokens and queries never reach the stats');
});

test('path normalisation and referrer reduction', () => {
  assert.equal(normalizePath('/a//b/?q=secret#frag'), '/a/b/');
  assert.equal(normalizePath('/x/' + 'A'.repeat(40)), '/x/:token');
  assert.equal(normalizePath('relative'), undefined);
  assert.equal(normalizePath('/%E0%A4%A'), undefined);
  assert.equal(referrerHost('https://www.google.com/search?q=private+question'), 'google.com');
  assert.equal(referrerHost('https://shop.example.test/other/', ['shop.example.test']), undefined, 'self-referral dropped');
  assert.equal(referrerHost('javascript:alert(1)'), undefined);
  assert.equal(referrerHost('not a url'), undefined);
});

test('bot filter: crawlers, CLI clients, headless and empty UAs are bots; browsers are not', () => {
  for (const ua of [undefined, '', 'curl/8.4.0', 'Wget/1.21', 'python-requests/2.32', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'facebookexternalhit/1.1', 'Go-http-client/2.0']) {
    assert.equal(isBot(ua), true, String(ua));
  }
  assert.equal(isBot(UA), false);
  assert.equal(isBot(UA2), false);
});

test('daily salt rotation: same visitor same hash within a day, unlinkable across days; dedup resets', () => {
  const v = new DailyVisitors();
  const d1 = new Date(Date.UTC(2026, 9, 5, 1));
  const d1b = new Date(Date.UTC(2026, 9, 5, 23));
  const d2 = new Date(Date.UTC(2026, 9, 6, 0, 1));
  const h1 = v.hash('203.0.113.7', UA, SITE, d1);
  assert.equal(v.hash('203.0.113.7', UA, SITE, d1b), h1);
  assert.notEqual(v.hash('203.0.113.8', UA, SITE, d1b), h1);
  assert.notEqual(v.hash('203.0.113.7', UA, 'other.test', d1b), h1);
  const salt1 = Buffer.from(v.currentSalt(d1b));
  assert.deepEqual(v.observe('203.0.113.7', UA, SITE, '/a/', d1b), { newForSite: true, newForPath: true });
  assert.deepEqual(v.observe('203.0.113.7', UA, SITE, '/a/', d1b), { newForSite: false, newForPath: false });
  assert.deepEqual(v.observe('203.0.113.7', UA, SITE, '/b/', d1b), { newForSite: false, newForPath: true });
  const h2 = v.hash('203.0.113.7', UA, SITE, d2);
  assert.notEqual(h2, h1, 'new day → new salt → different hash');
  assert.notDeepEqual(Buffer.from(v.currentSalt(d2)), salt1);
  assert.equal(v.rotations, 2);
  assert.deepEqual(v.observe('203.0.113.7', UA, SITE, '/a/', d2), { newForSite: true, newForPath: true }, 'counted again on the new day');
  assert.equal(v.size, 2, 'previous day dropped from memory');
});

test('rate limiter: fixed window per IP', () => {
  const r = new RateLimiter(3, 60_000);
  assert.deepEqual([1, 2, 3, 4].map(() => r.allow('a', 1000)), [true, true, true, false]);
  assert.equal(r.allow('b', 1000), true);
  assert.equal(r.allow('a', 61_001), true);
});

// ---------------------------------------------------------------- HTTP

test('CORS: preflight and beacons only for configured origins', async () => {
  const c = await start();
  const hb = JSON.parse(fs.readFileSync(analyticsPaths.heartbeat(), 'utf8'));
  assert.equal(hb.schema, 'mm.analytics-collector/v1', 'daemon writes a heartbeat for readers sharing the state dir');
  assert.equal(hb.updatedAt, now().toISOString());
  const ok = await req(c, 'OPTIONS', '/e', { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(ok.headers.vary, 'Origin');
  const bad = await req(c, 'OPTIONS', '/e', { headers: { Origin: 'https://evil.test' } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
  const r1 = await beacon(c, { site: SITE, path: '/', event: 'pageview' });
  assert.equal(r1.status, 204);
  assert.equal(r1.headers['access-control-allow-origin'], ORIGIN);
  assert.equal((await beacon(c, { site: SITE, path: '/', event: 'pageview' }, { Origin: 'https://evil.test' })).status, 403);
  const noOrigin = await req(c, 'POST', '/e', { headers: { 'Content-Type': 'text/plain', 'User-Agent': UA }, body: JSON.stringify({ site: SITE, path: '/', event: 'pageview' }) });
  assert.equal(noOrigin.status, 403);
  assert.equal(c.counters.accepted, 1);
});

test('HTTP validation: content type, size limit (2 KB), JSON, fields, unknown routes', async () => {
  const c = await start();
  assert.equal((await beacon(c, { site: SITE, path: '/', event: 'pageview' }, { 'Content-Type': 'application/json' })).status, 204);
  assert.equal((await beacon(c, { site: SITE, path: '/', event: 'pageview' }, { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await beacon(c, { site: SITE, path: '/', event: 'pageview', ref: 'https://a.test/' + 'x'.repeat(2100) })).status, 413);
  assert.equal((await beacon(c, '{not json')).status, 400);
  assert.equal((await beacon(c, { site: SITE, path: '/', event: 'hack' })).status, 400);
  assert.equal((await req(c, 'GET', '/e')).status, 405);
  assert.equal((await req(c, 'GET', '/nope')).status, 404);
  const health = await req(c, 'GET', '/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).status, 'ok');
});

test('aggregation: per site/day/path/event, unique visitors (approx), referrer hosts, bots counted only', async () => {
  const c = await start();
  const ref = 'https://www.google.com/search?q=very+personal+query';
  await beacon(c, { site: SITE, path: '/', event: 'pageview', ref });
  await beacon(c, { site: SITE, path: '/prod-a/', event: 'pageview', ref: `${ORIGIN}/` });
  await beacon(c, { site: SITE, path: '/prod-a/', event: 'pageview' }); // same visitor again
  await beacon(c, { site: SITE, path: '/prod-a/', event: 'buy_click' });
  await beacon(c, { site: SITE, path: '/prod-a/', event: 'pageview', ref: 'https://duckduckgo.com/' }, { 'User-Agent': UA2, 'X-Forwarded-For': '198.51.100.23' });
  await beacon(c, { site: SITE, path: '/prod-a/', event: 'download' }, { 'User-Agent': UA2, 'X-Forwarded-For': '198.51.100.23' });
  await beacon(c, { site: SITE, path: '/prod-a/', event: 'pageview' }, { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
  await beacon(c, { site: SITE, path: '/prod-a/', event: 'pageview' }, { 'User-Agent': UA, 'X-Forwarded-For': '192.0.2.99', DNT: '1' });
  assert.equal(await c.store.flush(), 1);
  const d = readDay();
  assert.equal(d.schema, 'mm.analytics-day/v1');
  assert.deepEqual(d.events, { pageview: 5, buy_click: 1, download: 1 });
  assert.equal(d.uniqueVisitors, 2, 'two hashed visitors; DNT visitor counted as event only');
  assert.deepEqual(d.paths['/prod-a/'], { pageview: 4, buy_click: 1, download: 1, uniqueVisitors: 2 });
  assert.deepEqual(d.paths['/'], { pageview: 1, buy_click: 0, download: 0, uniqueVisitors: 1 });
  assert.deepEqual(d.referrers, { 'google.com': 1, 'duckduckgo.com': 1 });
  assert.equal(d.botsFiltered, 1);

  // restart keeps accumulating instead of overwriting
  await c.stop();
  running = await startCollector(cfg(), { now, log: () => undefined });
  await beacon(running, { site: SITE, path: '/prod-a/', event: 'pageview' });
  await running.store.flush();
  assert.equal(readDay().events.pageview, 6);
});

test('PRIVACY: persisted files contain no IPs, user agents, hashes, salts, query strings or tokens', async () => {
  const c = await start();
  const ips = ['203.0.113.7', '198.51.100.23', '2001:db8::1'];
  for (const ip of ips) {
    await beacon(c, { site: SITE, path: '/p/?email=a@b.c', event: 'pageview', ref: 'https://news.example/item?id=42&user=alice' }, { 'X-Forwarded-For': ip });
    await beacon(c, { site: SITE, path: '/p/0123456789abcdef0123456789abcdef/', event: 'download' }, { 'X-Forwarded-For': ip, 'User-Agent': UA2 });
  }
  await c.stop();
  running = undefined;
  const files = fs.readdirSync(path.join(dir, 'analytics', SITE)).map((f) => fs.readFileSync(path.join(dir, 'analytics', SITE, f), 'utf8'));
  assert.ok(files.length >= 1);
  const all = files.join('\n') + fs.readdirSync(dir).join('\n');
  for (const ip of [...ips, '127.0.0.1', '::1']) assert.ok(!all.includes(ip), `IP ${ip} persisted`);
  for (const s of [UA, UA2, 'Mozilla', 'Chrome', 'Safari', 'alice', 'email', 'a@b.c', 'id=42', '0123456789abcdef', 'cookie', 'salt']) assert.ok(!all.toLowerCase().includes(s.toLowerCase()), `"${s}" persisted`);
  assert.ok(!/[A-Za-z0-9_-]{22}/.test(all.replace(/"[a-z_]+":/g, '')), 'no visitor hash persisted');
  assert.match(all, /"news\.example": 3/);
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')) ? fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').includes('203.0.113') : false, false);
});

test('rate limit: per-IP events beyond the limit are refused (429) and not counted', async () => {
  const c = await start({ ANALYTICS_RATE_LIMIT_PER_MIN: '3' });
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) statuses.push((await beacon(c, { site: SITE, path: '/', event: 'pageview' })).status);
  assert.deepEqual(statuses, [204, 204, 204, 429, 429]);
  assert.equal((await beacon(c, { site: SITE, path: '/', event: 'pageview' }, { 'X-Forwarded-For': '198.51.100.1' })).status, 204, 'other IPs unaffected');
  clock.t += 61_000;
  assert.equal((await beacon(c, { site: SITE, path: '/', event: 'pageview' })).status, 204, 'window reset');
  await c.store.flush();
  assert.equal(readDay().events.pageview, 5);
  assert.equal(c.counters.rateLimited, 2);
});

test('stats: bearer token required; returns days incl. unflushed data; disabled without token', async () => {
  const c = await start();
  await beacon(c, { site: SITE, path: '/a/', event: 'pageview' });
  await beacon(c, { site: SITE, path: '/a/', event: 'buy_click' });
  assert.equal((await req(c, 'GET', `/stats?site=${SITE}`)).status, 401);
  assert.equal((await req(c, 'GET', `/stats?site=${SITE}`, { headers: { Authorization: 'Bearer wrong-token-xxxxxxxxxxxx' } })).status, 401);
  const ok = await req(c, 'GET', `/stats?site=${SITE}&from=2026-10-01&to=2026-10-05`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(ok.status, 200);
  const s = JSON.parse(ok.body) as StatsResponse;
  assert.equal(s.schema, 'mm.analytics-stats/v1');
  assert.equal(s.days.length, 1);
  assert.deepEqual(s.totals.events, { pageview: 1, buy_click: 1, download: 0 });
  assert.equal((await req(c, 'GET', `/stats?site=..%2Fetc`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 400);
  assert.equal((await req(c, 'GET', `/stats?site=${SITE}&from=2026-10-09&to=2026-10-01`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 400);
  await c.stop();
  running = await startCollector(cfg({ ANALYTICS_READ_TOKEN: '' }), { now, log: () => undefined });
  assert.equal((await req(running, 'GET', `/stats?site=${SITE}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 503);
});

test('day rollover: events after midnight UTC land in a new file', async () => {
  const c = await start();
  clock.t = Date.UTC(2026, 9, 5, 23, 59);
  await beacon(c, { site: SITE, path: '/', event: 'pageview' });
  clock.t = Date.UTC(2026, 9, 6, 0, 1);
  await beacon(c, { site: SITE, path: '/', event: 'pageview' });
  await c.store.flush();
  assert.equal(readDay('2026-10-05').uniqueVisitors, 1);
  assert.equal(readDay('2026-10-06').uniqueVisitors, 1, 'same person, new day, new salt → counted again');
});

test('--once: retention removes old files, junk and stale temp files; keeps recent ones; exits cleanly', async () => {
  const siteDir = path.join(dir, 'analytics', SITE);
  fs.mkdirSync(siteDir, { recursive: true });
  const mk = (day: string) => fs.writeFileSync(path.join(siteDir, `${day}.json`), JSON.stringify({ schema: 'mm.analytics-day/v1', site: SITE, day, updatedAt: '', uniqueVisitors: 0, events: { pageview: 1, buy_click: 0, download: 0 }, paths: {}, referrers: {}, botsFiltered: 0 }));
  mk('2026-10-01');
  mk('2025-01-01');
  fs.writeFileSync(path.join(siteDir, '2026-10-02.json'), 'garbage');
  const tmp = path.join(siteDir, '2026-10-03.json.1.2.tmp');
  fs.writeFileSync(tmp, '{}');
  fs.utimesSync(tmp, new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 1)));
  const res = await runOnce(readConfig({ ANALYTICS_RETENTION_DAYS: '30' }), now());
  assert.equal(fs.existsSync(analyticsPaths.heartbeat()), false, '--once is not a running collector: no heartbeat');
  assert.equal(res.kept, 1);
  assert.deepEqual(fs.readdirSync(siteDir), ['2026-10-01.json']);
  assert.equal(res.removed.length, 3);
});

test('config: origins normalised, short token refused, defaults', () => {
  const c = readConfig({ ANALYTICS_ALLOWED_ORIGINS: 'https://Shop.Example.test/, http://localhost:8080' });
  assert.deepEqual(c.allowedOrigins, ['https://shop.example.test', 'http://localhost:8080']);
  assert.equal(c.port, 8791);
  assert.equal(c.host, '127.0.0.1');
  assert.equal(c.retentionDays, 400);
  assert.throws(() => readConfig({ ANALYTICS_READ_TOKEN: 'short' }));
  assert.throws(() => readConfig({ ANALYTICS_ALLOWED_ORIGINS: 'ftp://x' }));
  assert.ok(readConfig({}).notes.some((n) => n.includes('every beacon is refused')));
});
