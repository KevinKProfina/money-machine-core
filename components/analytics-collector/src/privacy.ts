import crypto from 'node:crypto';

/**
 * Privacy building blocks. Everything here works on data that only lives in memory for
 * the duration of a request (IP, user agent) or of one UTC day (salt, visitor hashes).
 * Nothing in this file is ever written to disk.
 */

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

const BOT_RE =
  /bot\b|bot\/|crawl|spider|slurp|archiver|headless|lighthouse|pagespeed|pingdom|uptime|monitor|curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java\/|libwww|httpclient|axios\/|node-fetch|undici|phantomjs|puppeteer|playwright|selenium|preview|facebookexternalhit|embedly|whatsapp|telegrambot|discordbot|slackbot|bingpreview|scrapy|feedfetcher|validator/i;

/** Heuristic bot filter on the User-Agent. Missing or implausibly short UAs count as bots. */
export function isBot(ua: string | undefined): boolean {
  if (!ua || ua.trim().length < 10) return true;
  if (!/mozilla\/|opera\//i.test(ua)) return true; // real browsers all send Mozilla/… or Opera/…
  return BOT_RE.test(ua);
}

/**
 * Referrer reduced to its hostname (no path, no query → no search terms, no tokens).
 * Returns undefined for missing/invalid referrers and for self-referrals.
 */
export function referrerHost(ref: unknown, ownHosts: Iterable<string> = []): string | undefined {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 2000) return undefined;
  let u: URL;
  try {
    u = new URL(ref);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host || host.length > 253) return undefined;
  for (const own of ownHosts) if (own.replace(/^www\./, '') === host) return undefined;
  return host;
}

/**
 * Path normalisation: no query/fragment, max 200 chars, collapse duplicate slashes, and
 * replace anything that looks like a secret token (long hex/base64-ish segment) so secret
 * download URLs can never end up in the statistics.
 */
export function normalizePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1000) return undefined;
  let p = raw.split(/[?#]/)[0]!;
  if (!p.startsWith('/')) return undefined;
  p = p.replace(/\/{2,}/g, '/');
  try {
    p = decodeURIComponent(p);
  } catch {
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/.test(p)) return undefined;
  p = p
    .split('/')
    .map((seg) => (/^[0-9a-f]{24,}$/i.test(seg) || /^[A-Za-z0-9_-]{32,}$/.test(seg) ? ':token' : seg))
    .join('/');
  return p.slice(0, 200);
}

/**
 * Approximate unique visitors: hash(salt_day + ip + ua + site [+ path]). The salt is random,
 * generated in memory, and replaced (not derived) when the UTC day changes, so hashes of
 * different days cannot be linked and nothing can be recomputed after the day ended.
 * Neither salt nor hashes are ever persisted; only the resulting counts are.
 */
export class DailyVisitors {
  private day = '';
  private salt: Buffer = Buffer.alloc(0);
  private seen = new Set<string>();
  /** How often the salt was rotated (for tests/diagnostics). */
  rotations = 0;

  constructor(private readonly maxEntries = 500_000) {}

  private rotate(day: string): void {
    this.day = day;
    this.salt = crypto.randomBytes(32);
    this.seen = new Set();
    this.rotations++;
  }

  /** Visible for tests: the current day's salt (never persisted, never exposed over HTTP). */
  currentSalt(now: Date): Buffer {
    if (utcDay(now) !== this.day) this.rotate(utcDay(now));
    return this.salt;
  }

  hash(ip: string, ua: string, site: string, now: Date): string {
    const salt = this.currentSalt(now);
    return crypto.createHash('sha256').update(salt).update('\0').update(ip).update('\0').update(ua).update('\0').update(site).digest('base64url').slice(0, 22);
  }

  /**
   * Records a visitor for (site) and (site, path); returns which of the two are new today.
   * Over the memory cap, visitors are no longer deduplicated (counts become an upper bound).
   */
  observe(ip: string, ua: string, site: string, path: string, now: Date): { newForSite: boolean; newForPath: boolean } {
    const h = this.hash(ip, ua, site, now);
    const siteKey = `${site}|${h}`;
    const pathKey = `${site}|${path}|${h}`;
    const newForSite = !this.seen.has(siteKey);
    const newForPath = !this.seen.has(pathKey);
    if (this.seen.size < this.maxEntries) {
      this.seen.add(siteKey);
      this.seen.add(pathKey);
    }
    return { newForSite, newForPath };
  }

  get size(): number {
    return this.seen.size;
  }
}

/** Fixed-window per-IP rate limit, in memory only (the map is cleared every window). */
export class RateLimiter {
  private windowStart = 0;
  private counts = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  allow(ip: string, nowMs: number): boolean {
    if (nowMs - this.windowStart >= this.windowMs) {
      this.windowStart = nowMs;
      this.counts.clear();
    }
    const n = (this.counts.get(ip) ?? 0) + 1;
    this.counts.set(ip, n);
    return n <= this.limit;
  }

  get trackedClients(): number {
    return this.counts.size;
  }
}
