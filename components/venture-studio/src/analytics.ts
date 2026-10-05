import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { StudioConfig } from './config.js';
import type { DayAggregate } from './funnel.js';
import { fetchJson, type FetchLike } from './http.js';
import { readJsonSafe, stateDir } from './mm-contract.js';

/**
 * Reads the analytics-collector's daily aggregates. Two ways:
 *  - `files`: the collector shares this MM_STATE_DIR (it creates $MM_STATE_DIR/analytics/ on start)
 *  - `http`:  GET {STUDIO_ANALYTICS_URL}/stats?site=&from=&to= with ANALYTICS_READ_TOKEN
 */
export interface TrafficSource {
  readonly id: 'files' | 'http';
  load(site: string, fromDay: string, toDay: string): Promise<DayAggregate[]>;
}

export const analyticsRoot = () => path.join(stateDir(), 'analytics');
/** Written by a RUNNING collector on start and every flush (not by its `--once`). */
export const heartbeatFile = (root = analyticsRoot()) => path.join(root, 'collector.json');

/** A heartbeat older than this means the collector is down: its files are incomplete. */
export const HEARTBEAT_MAX_AGE_MS = 36 * 3_600_000;

export function readHeartbeat(root = analyticsRoot()): { updatedAt: string } | undefined {
  try {
    const hb = JSON.parse(fs.readFileSync(heartbeatFile(root), 'utf8')) as { schema?: string; updatedAt?: string };
    return hb.schema === 'mm.analytics-collector/v1' && typeof hb.updatedAt === 'string' ? { updatedAt: hb.updatedAt } : undefined;
  } catch {
    return undefined;
  }
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const SITE_RE = /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?$/;

export function isDayAggregate(x: unknown): x is DayAggregate {
  const d = x as DayAggregate | null;
  return !!d && d.schema === 'mm.analytics-day/v1' && typeof d.day === 'string' && typeof d.events === 'object' && typeof d.paths === 'object';
}

export class FileTrafficSource implements TrafficSource {
  readonly id = 'files' as const;
  constructor(
    private readonly root: string = analyticsRoot(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(site: string, fromDay: string, toDay: string): Promise<DayAggregate[]> {
    if (!SITE_RE.test(site)) throw new Error(`invalid analytics site id ${site}`);
    const hb = readHeartbeat(this.root);
    if (!hb) throw new Error('collector heartbeat missing (analytics-collector not running on this MM_STATE_DIR)');
    const age = this.now().getTime() - Date.parse(hb.updatedAt);
    if (age > HEARTBEAT_MAX_AGE_MS) throw new Error(`collector heartbeat stale (${Math.round(age / 3_600_000)} h old): traffic data incomplete`);
    let files: string[];
    try {
      files = await fsp.readdir(path.join(this.root, site));
    } catch {
      return []; // collector runs but has not seen this site yet
    }
    const out: DayAggregate[] = [];
    for (const f of files.sort()) {
      const day = DAY_FILE.exec(f)?.[1];
      if (!day || day < fromDay || day > toDay) continue;
      const d = await readJsonSafe<unknown>(path.join(this.root, site, f), null);
      if (isDayAggregate(d) && d.day === day) out.push(d);
    }
    return out;
  }
}

export class HttpTrafficSource implements TrafficSource {
  readonly id = 'http' as const;
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly opts: { fetchImpl?: FetchLike; backoffMs?: number; timeoutMs?: number } = {},
  ) {}

  async load(site: string, fromDay: string, toDay: string): Promise<DayAggregate[]> {
    const qs = new URLSearchParams({ site, from: fromDay, to: toDay });
    const res = await fetchJson<{ schema?: string; days?: unknown[] }>(`${this.baseUrl}/stats?${qs.toString()}`, {
      fetchImpl: this.opts.fetchImpl,
      backoffMs: this.opts.backoffMs ?? 500,
      timeoutMs: this.opts.timeoutMs ?? 10_000,
      init: { method: 'GET', headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' } },
    });
    if (res?.schema !== 'mm.analytics-stats/v1' || !Array.isArray(res.days)) throw new Error('unexpected /stats response');
    return res.days.filter(isDayAggregate);
  }
}

/**
 * Picks the source: shared state dir first (a running collector left its heartbeat there;
 * no network, no token), then HTTP when STUDIO_ANALYTICS_URL and ANALYTICS_READ_TOKEN are
 * set, else none.
 */
export function chooseTrafficSource(cfg: StudioConfig, opts: { fetchImpl?: FetchLike; root?: string; backoffMs?: number; now?: () => Date } = {}): TrafficSource | undefined {
  // Without a beacon on the pages there is nothing to measure (0 visits would look like "no-traffic").
  if (!cfg.analytics.site || !cfg.analytics.url) return undefined;
  const root = opts.root ?? analyticsRoot();
  if (readHeartbeat(root)) return new FileTrafficSource(root, opts.now);
  if (cfg.analytics.url && cfg.analytics.readToken) return new HttpTrafficSource(cfg.analytics.url, cfg.analytics.readToken, { fetchImpl: opts.fetchImpl, backoffMs: opts.backoffMs });
  return undefined;
}
