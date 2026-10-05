export const COMPONENT_NAME = 'analytics-collector';

export type CollectorConfig = {
  port: number;
  host: string;
  /** Exact origins (scheme://host[:port]) allowed to send beacons. Empty → no beacon is accepted. */
  allowedOrigins: string[];
  /** Optional allow-list of site ids; empty → any well-formed site id. */
  sites: string[];
  /** Bearer token for GET /stats; undefined → /stats disabled (503). */
  readToken?: string;
  retentionDays: number;
  flushIntervalMs: number;
  /** Max accepted events per client IP per minute (in memory only). */
  rateLimitPerMinute: number;
  /** Use the first X-Forwarded-For entry as client IP (only behind your own reverse proxy). */
  trustProxy: boolean;
  /** Max distinct paths / referrer hosts per site and day; the rest is counted under "(other)". */
  maxPathsPerDay: number;
  maxReferrersPerDay: number;
  notes: string[];
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v)) throw new ConfigError(`${key}=${raw} must be an integer`);
  if (v < min || v > max) throw new ConfigError(`${key}=${raw} out of range [${min}, ${max}]`);
  return v;
}

const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Site ids are used as directory names: lowercase hostname-like strings only. */
export const SITE_RE = /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?$/;

export function normalizeOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`ANALYTICS_ALLOWED_ORIGINS: "${raw}" is not a URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ConfigError(`ANALYTICS_ALLOWED_ORIGINS: "${raw}" must be http(s)`);
  return u.origin;
}

export function readConfig(env: Env = process.env): CollectorConfig {
  const notes: string[] = [];
  const allowedOrigins = list(env.ANALYTICS_ALLOWED_ORIGINS).map(normalizeOrigin);
  if (allowedOrigins.length === 0) notes.push('ANALYTICS_ALLOWED_ORIGINS empty: every beacon is refused (set it to your site origin, e.g. https://shop.example.com)');
  const sites = list(env.ANALYTICS_SITES).map((s) => s.toLowerCase());
  for (const s of sites) if (!SITE_RE.test(s)) throw new ConfigError(`ANALYTICS_SITES: "${s}" is not a valid site id (lowercase hostname)`);
  const readToken = env.ANALYTICS_READ_TOKEN?.trim() || undefined;
  if (!readToken) notes.push('ANALYTICS_READ_TOKEN not set: GET /stats is disabled');
  else if (readToken.length < 16) throw new ConfigError('ANALYTICS_READ_TOKEN must be at least 16 characters');
  const host = env.HOST?.trim() || '127.0.0.1';
  return {
    port: num(env, 'PORT', 8791, 0, 65535),
    host,
    allowedOrigins,
    sites,
    readToken,
    retentionDays: num(env, 'ANALYTICS_RETENTION_DAYS', 400, 1, 3650),
    flushIntervalMs: num(env, 'ANALYTICS_FLUSH_INTERVAL_MS', 60_000, 100, 3_600_000),
    rateLimitPerMinute: num(env, 'ANALYTICS_RATE_LIMIT_PER_MIN', 60, 1, 100_000),
    trustProxy: env.ANALYTICS_TRUST_PROXY === '1' || env.ANALYTICS_TRUST_PROXY === 'true',
    maxPathsPerDay: num(env, 'ANALYTICS_MAX_PATHS_PER_DAY', 500, 10, 100_000),
    maxReferrersPerDay: num(env, 'ANALYTICS_MAX_REFERRERS_PER_DAY', 200, 10, 100_000),
    notes,
  };
}
