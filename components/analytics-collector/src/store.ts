import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJsonSafe, stateDir, writeJsonAtomic } from './mm-contract.js';
import { utcDay } from './privacy.js';

export const EVENTS = ['pageview', 'buy_click', 'download'] as const;
export type EventName = (typeof EVENTS)[number];
export type EventCounts = Record<EventName, number>;

/**
 * One file per site and UTC day: $MM_STATE_DIR/analytics/<site>/<yyyy-mm-dd>.json.
 * Aggregates only. Contains no IP addresses, user agents, hashes, salts or full referrer URLs.
 */
export type DayAggregate = {
  schema: 'mm.analytics-day/v1';
  site: string;
  day: string;
  updatedAt: string;
  /** Approximate unique visitors of the whole site on this day (daily salted hash, see README). */
  uniqueVisitors: number;
  events: EventCounts;
  paths: Record<string, EventCounts & { uniqueVisitors: number }>;
  /** Referrer hostnames → pageviews. */
  referrers: Record<string, number>;
  /** Events dropped by the bot filter (counted, nothing else stored). */
  botsFiltered: number;
};

export const OTHER = '(other)';

export const analyticsPaths = {
  root: () => path.join(stateDir(), 'analytics'),
  siteDir: (site: string) => path.join(stateDir(), 'analytics', site),
  day: (site: string, day: string) => path.join(stateDir(), 'analytics', site, `${day}.json`),
  /** Written by the running daemon on start and every flush; tells readers (venture-studio) that a live collector shares this state dir. */
  heartbeat: () => path.join(stateDir(), 'analytics', 'collector.json'),
};

export type Heartbeat = { schema: 'mm.analytics-collector/v1'; updatedAt: string; startedAt: string; retentionDays: number; flushIntervalMs: number };

const zero = (): EventCounts => ({ pageview: 0, buy_click: 0, download: 0 });

export function emptyDay(site: string, day: string, now: Date): DayAggregate {
  return { schema: 'mm.analytics-day/v1', site, day, updatedAt: now.toISOString(), uniqueVisitors: 0, events: zero(), paths: {}, referrers: {}, botsFiltered: 0 };
}

function isDayAggregate(x: unknown, site: string, day: string): x is DayAggregate {
  const d = x as DayAggregate | null;
  return !!d && d.schema === 'mm.analytics-day/v1' && d.site === site && d.day === day && typeof d.events === 'object' && typeof d.paths === 'object';
}

export type Hit = { site: string; path: string; event: EventName; refHost?: string; newVisitorForSite: boolean; newVisitorForPath: boolean };

export type StoreLimits = { maxPathsPerDay: number; maxReferrersPerDay: number };

/**
 * In-memory daily aggregates with periodic atomic flushes. On first touch of a (site, day)
 * the existing file is loaded, so restarts keep accumulating instead of overwriting.
 */
export class AggregateStore {
  private days = new Map<string, DayAggregate>();
  private dirty = new Set<string>();
  private loading = new Map<string, Promise<DayAggregate>>();
  lastFlushAt?: string;

  constructor(
    private readonly limits: StoreLimits,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private key(site: string, day: string): string {
    return `${site}|${day}`;
  }

  private async get(site: string, day: string): Promise<DayAggregate> {
    const k = this.key(site, day);
    const have = this.days.get(k);
    if (have) return have;
    let p = this.loading.get(k);
    if (!p) {
      p = (async () => {
        const raw = await readJsonSafe<unknown>(analyticsPaths.day(site, day), null);
        const agg = isDayAggregate(raw, site, day) ? raw : emptyDay(site, day, this.now());
        for (const e of EVENTS) agg.events[e] ??= 0;
        this.days.set(k, agg);
        this.loading.delete(k);
        return agg;
      })();
      this.loading.set(k, p);
    }
    return p;
  }

  async record(hit: Hit): Promise<void> {
    const now = this.now();
    const day = utcDay(now);
    const agg = await this.get(hit.site, day);
    agg.events[hit.event]++;
    if (hit.newVisitorForSite) agg.uniqueVisitors++;
    let p = hit.path;
    if (!agg.paths[p] && Object.keys(agg.paths).length >= this.limits.maxPathsPerDay) p = OTHER;
    const pc = (agg.paths[p] ??= { ...zero(), uniqueVisitors: 0 });
    pc[hit.event]++;
    if (hit.newVisitorForPath) pc.uniqueVisitors++;
    if (hit.refHost && hit.event === 'pageview') {
      let r = hit.refHost;
      if (agg.referrers[r] === undefined && Object.keys(agg.referrers).length >= this.limits.maxReferrersPerDay) r = OTHER;
      agg.referrers[r] = (agg.referrers[r] ?? 0) + 1;
    }
    agg.updatedAt = now.toISOString();
    this.dirty.add(this.key(hit.site, day));
  }

  async recordBot(site: string): Promise<void> {
    const now = this.now();
    const day = utcDay(now);
    const agg = await this.get(site, day);
    agg.botsFiltered++;
    agg.updatedAt = now.toISOString();
    this.dirty.add(this.key(site, day));
  }

  /** Writes all dirty aggregates atomically; drops past days from memory once written. */
  async flush(): Promise<number> {
    const today = utcDay(this.now());
    let written = 0;
    for (const k of [...this.dirty]) {
      const agg = this.days.get(k);
      this.dirty.delete(k);
      if (!agg) continue;
      await writeJsonAtomic(analyticsPaths.day(agg.site, agg.day), agg);
      written++;
    }
    for (const [k, agg] of this.days) if (agg.day < today && !this.dirty.has(k)) this.days.delete(k);
    this.lastFlushAt = this.now().toISOString();
    return written;
  }

  get pending(): number {
    return this.dirty.size;
  }

  /** Days [from, to] of one site: unflushed in-memory state wins over the file. */
  async range(site: string, from: string, to: string): Promise<DayAggregate[]> {
    const files = await listDays(site);
    const days = new Set(files.filter((d) => d >= from && d <= to));
    for (const agg of this.days.values()) if (agg.site === site && agg.day >= from && agg.day <= to) days.add(agg.day);
    const out: DayAggregate[] = [];
    for (const day of [...days].sort()) {
      const mem = this.days.get(this.key(site, day));
      if (mem) out.push(structuredClone(mem));
      else {
        const raw = await readJsonSafe<unknown>(analyticsPaths.day(site, day), null);
        if (isDayAggregate(raw, site, day)) out.push(raw);
      }
    }
    return out;
  }

  /** Sites seen in memory or on disk. */
  async sites(): Promise<string[]> {
    const set = new Set<string>([...this.days.values()].map((d) => d.site));
    try {
      for (const e of await fsp.readdir(analyticsPaths.root(), { withFileTypes: true })) if (e.isDirectory()) set.add(e.name);
    } catch {
      // no data yet
    }
    return [...set].sort();
  }
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

export async function listDays(site: string): Promise<string[]> {
  try {
    return (await fsp.readdir(analyticsPaths.siteDir(site)))
      .map((f) => DAY_FILE.exec(f)?.[1])
      .filter((d): d is string => !!d)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Retention + compaction: deletes day files older than `retentionDays`, removes stray
 * temp files from interrupted writes and unreadable files. Returns what was removed.
 */
export async function compact(retentionDays: number, now: Date): Promise<{ removed: string[]; kept: number }> {
  const cutoff = utcDay(new Date(now.getTime() - retentionDays * 86_400_000));
  const removed: string[] = [];
  let kept = 0;
  let sites: string[] = [];
  try {
    sites = (await fsp.readdir(analyticsPaths.root(), { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { removed, kept };
  }
  for (const site of sites) {
    const dir = analyticsPaths.siteDir(site);
    for (const f of await fsp.readdir(dir)) {
      const full = path.join(dir, f);
      const m = DAY_FILE.exec(f);
      let drop = false;
      if (f.endsWith('.tmp')) {
        const st = await fsp.stat(full).catch(() => undefined);
        drop = !!st && now.getTime() - st.mtimeMs > 3_600_000;
      } else if (m) {
        if (m[1]! < cutoff) drop = true;
        else if (!isDayAggregate(await readJsonSafe<unknown>(full, null), site, m[1]!)) drop = true;
      }
      if (drop) {
        await fsp.rm(full, { force: true });
        removed.push(path.join(site, f));
      } else if (m) kept++;
    }
  }
  return { removed, kept };
}
