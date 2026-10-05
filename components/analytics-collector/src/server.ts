import crypto from 'node:crypto';
import http from 'node:http';
import { SITE_RE, type CollectorConfig } from './config.js';
import { DailyVisitors, isBot, normalizePath, RateLimiter, referrerHost, utcDay } from './privacy.js';
import { AggregateStore, EVENTS, type DayAggregate, type EventCounts, type EventName } from './store.js';

export const MAX_BODY_BYTES = 2048;
const MAX_STATS_DAYS = 800;

export type Beacon = { site: string; path: string; event: EventName; ref?: string };

export type ValidationResult = { ok: true; beacon: Beacon } | { ok: false; error: string };

/** Pure validation of a parsed beacon body. */
export function validateBeacon(body: unknown, allowedSites: string[] = []): ValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const allowedKeys = new Set(['site', 'path', 'event', 'ref']);
  for (const k of Object.keys(b)) if (!allowedKeys.has(k)) return { ok: false, error: `unknown field ${k}` };
  if (typeof b.site !== 'string' || !SITE_RE.test(b.site)) return { ok: false, error: 'invalid site' };
  if (allowedSites.length > 0 && !allowedSites.includes(b.site)) return { ok: false, error: 'unknown site' };
  if (typeof b.event !== 'string' || !(EVENTS as readonly string[]).includes(b.event)) return { ok: false, error: 'invalid event' };
  const p = normalizePath(b.path);
  if (!p) return { ok: false, error: 'invalid path' };
  if (b.ref !== undefined && b.ref !== null && typeof b.ref !== 'string') return { ok: false, error: 'invalid ref' };
  return { ok: true, beacon: { site: b.site, path: p, event: b.event as EventName, ...(typeof b.ref === 'string' && b.ref ? { ref: b.ref } : {}) } };
}

export type StatsResponse = {
  schema: 'mm.analytics-stats/v1';
  site: string;
  from: string;
  to: string;
  generatedAt: string;
  days: DayAggregate[];
  totals: { uniqueVisitorsSumOfDays: number; events: EventCounts; botsFiltered: number };
};

export type CollectorOptions = { now?: () => Date; log?: (m: string) => void };

export type Collector = {
  server: http.Server;
  store: AggregateStore;
  visitors: DailyVisitors;
  limiter: RateLimiter;
  counters: { accepted: number; rejected: number; bots: number; rateLimited: number };
};

function tokenEquals(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createCollector(cfg: CollectorConfig, opts: CollectorOptions = {}): Collector {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => undefined);
  const store = new AggregateStore({ maxPathsPerDay: cfg.maxPathsPerDay, maxReferrersPerDay: cfg.maxReferrersPerDay }, now);
  const visitors = new DailyVisitors();
  const limiter = new RateLimiter(cfg.rateLimitPerMinute);
  const counters = { accepted: 0, rejected: 0, bots: 0, rateLimited: 0 };
  const allowed = new Set(cfg.allowedOrigins);
  const startedAt = Date.now();

  const send = (res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    const h: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers };
    if (body === undefined) {
      res.writeHead(status, h);
      res.end();
      return;
    }
    h['Content-Type'] = 'application/json; charset=utf-8';
    res.writeHead(status, h);
    res.end(JSON.stringify(body));
  };

  const corsHeaders = (origin: string): Record<string, string> => ({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  });

  const clientIp = (req: http.IncomingMessage): string => {
    if (cfg.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const readBody = (req: http.IncomingMessage): Promise<string | 'too-large'> =>
    new Promise((resolve, reject) => {
      const len = Number(req.headers['content-length'] ?? 0);
      if (len > MAX_BODY_BYTES) {
        req.resume();
        resolve('too-large');
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on('data', (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          done = true;
          resolve('too-large');
          req.resume();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!done) {
          done = true;
          resolve(Buffer.concat(chunks).toString('utf8'));
        }
      });
      req.on('error', reject);
    });

  async function handleBeacon(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) {
      counters.rejected++;
      req.resume();
      send(res, 403, { error: 'origin not allowed' });
      return;
    }
    const cors = corsHeaders(origin);
    const ip = clientIp(req);
    if (!limiter.allow(ip, now().getTime())) {
      counters.rateLimited++;
      req.resume();
      send(res, 429, { error: 'rate limited' }, { ...cors, 'Retry-After': '60' });
      return;
    }
    const ctype = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (ctype !== 'text/plain' && ctype !== 'application/json') {
      counters.rejected++;
      req.resume();
      send(res, 415, { error: 'content-type must be text/plain or application/json' }, cors);
      return;
    }
    const raw = await readBody(req);
    if (raw === 'too-large') {
      counters.rejected++;
      send(res, 413, { error: `body larger than ${MAX_BODY_BYTES} bytes` }, { ...cors, Connection: 'close' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      counters.rejected++;
      send(res, 400, { error: 'invalid JSON' }, cors);
      return;
    }
    const v = validateBeacon(parsed, cfg.sites);
    if (!v.ok) {
      counters.rejected++;
      send(res, 400, { error: v.error }, cors);
      return;
    }
    const ua = req.headers['user-agent'];
    if (isBot(ua)) {
      counters.bots++;
      await store.recordBot(v.beacon.site);
      send(res, 204, undefined, cors);
      return;
    }
    // Do Not Track / Global Privacy Control: count the event, but do not compute a visitor hash.
    const optOut = req.headers.dnt === '1' || req.headers['sec-gpc'] === '1';
    const seen = optOut ? { newForSite: false, newForPath: false } : visitors.observe(ip, ua!, v.beacon.site, v.beacon.path, now());
    let ownHost: string[] = [];
    try {
      ownHost = [new URL(origin).hostname.toLowerCase()];
    } catch {
      // origin was validated against the allow-list; ignore
    }
    await store.record({
      site: v.beacon.site,
      path: v.beacon.path,
      event: v.beacon.event,
      refHost: referrerHost(v.beacon.ref, ownHost),
      newVisitorForSite: seen.newForSite,
      newVisitorForPath: seen.newForPath,
    });
    counters.accepted++;
    send(res, 204, undefined, cors);
  }

  async function handleStats(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (!cfg.readToken) {
      send(res, 503, { error: 'stats disabled (ANALYTICS_READ_TOKEN not set)' });
      return;
    }
    const auth = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m || !tokenEquals(m[1]!.trim(), cfg.readToken)) {
      send(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    const site = url.searchParams.get('site') ?? '';
    if (!SITE_RE.test(site)) {
      send(res, 400, { error: 'invalid site' });
      return;
    }
    const today = utcDay(now());
    const to = url.searchParams.get('to') ?? today;
    const from = url.searchParams.get('from') ?? utcDay(new Date(now().getTime() - 29 * 86_400_000));
    if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
      send(res, 400, { error: 'from/to must be yyyy-mm-dd with from <= to' });
      return;
    }
    if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_STATS_DAYS) {
      send(res, 400, { error: `range larger than ${MAX_STATS_DAYS} days` });
      return;
    }
    const days = await store.range(site, from, to);
    const events: EventCounts = { pageview: 0, buy_click: 0, download: 0 };
    let uniques = 0;
    let bots = 0;
    for (const d of days) {
      for (const e of EVENTS) events[e] += d.events[e] ?? 0;
      uniques += d.uniqueVisitors;
      bots += d.botsFiltered;
    }
    const body: StatsResponse = { schema: 'mm.analytics-stats/v1', site, from, to, generatedAt: now().toISOString(), days, totals: { uniqueVisitorsSumOfDays: uniques, events, botsFiltered: bots } };
    send(res, 200, body);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://collector.invalid');
    const route = `${req.method} ${url.pathname}`;
    const run = async () => {
      if (url.pathname === '/e') {
        if (req.method === 'OPTIONS') {
          const origin = req.headers.origin;
          if (origin && allowed.has(origin)) send(res, 204, undefined, corsHeaders(origin));
          else send(res, 403, { error: 'origin not allowed' });
          return;
        }
        if (req.method === 'POST') return handleBeacon(req, res);
        send(res, 405, { error: 'method not allowed' }, { Allow: 'POST, OPTIONS' });
        return;
      }
      if (route === 'GET /health') {
        send(res, 200, { status: 'ok', uptimeS: Math.round((Date.now() - startedAt) / 1000), pendingDays: store.pending, lastFlushAt: store.lastFlushAt ?? null, counters });
        return;
      }
      if (route === 'GET /stats') return handleStats(req, res, url);
      req.resume();
      send(res, 404, { error: 'not found' });
    };
    run().catch((error: unknown) => {
      log(`[collector] ${route} failed: ${(error as Error).message}`);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  // never log request lines: they would contain IP addresses
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return { server, store, visitors, limiter, counters };
}
