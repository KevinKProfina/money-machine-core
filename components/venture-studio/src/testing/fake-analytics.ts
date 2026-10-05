/**
 * Offline stand-in for components/analytics-collector: writes the same daily aggregate
 * files (`mm.analytics-day/v1`) into $MM_STATE_DIR/analytics/<site>/<day>.json, i.e. it
 * behaves like a collector that shares the studio's MM_STATE_DIR. Tests/simulator only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyticsRoot, heartbeatFile } from '../analytics.js';
import type { DayAggregate, EventCounts } from '../funnel.js';

type EventName = keyof EventCounts;

export class FakeCollector {
  readonly days = new Map<string, DayAggregate>();

  /** `heartbeatAt` = the virtual "now" of the test/simulation (a running collector refreshes it on every flush). */
  constructor(
    readonly site: string,
    heartbeatAt: Date = new Date(),
  ) {
    fs.mkdirSync(analyticsRoot(), { recursive: true });
    this.heartbeat(heartbeatAt); // "a live collector shares MM_STATE_DIR"
  }

  heartbeat(at: Date): void {
    fs.writeFileSync(heartbeatFile(), JSON.stringify({ schema: 'mm.analytics-collector/v1', updatedAt: at.toISOString(), startedAt: at.toISOString(), retentionDays: 400, flushIntervalMs: 60_000 }));
  }

  private agg(day: string): DayAggregate {
    let d = this.days.get(day);
    if (!d) {
      d = { schema: 'mm.analytics-day/v1', site: this.site, day, updatedAt: '', uniqueVisitors: 0, events: { pageview: 0, buy_click: 0, download: 0 }, paths: {}, referrers: {}, botsFiltered: 0 };
      this.days.set(day, d);
    }
    return d;
  }

  record(at: Date, pagePath: string, event: EventName, opts: { newVisitor?: boolean; ref?: string; n?: number } = {}): void {
    const n = opts.n ?? 1;
    const d = this.agg(at.toISOString().slice(0, 10));
    d.events[event] += n;
    const p = (d.paths[pagePath] ??= { pageview: 0, buy_click: 0, download: 0, uniqueVisitors: 0 });
    p[event] += n;
    if (opts.newVisitor) {
      p.uniqueVisitors += n;
      d.uniqueVisitors += n;
    }
    if (opts.ref && event === 'pageview') d.referrers[opts.ref] = (d.referrers[opts.ref] ?? 0) + n;
    d.updatedAt = at.toISOString();
  }

  bot(at: Date, n = 1): void {
    this.agg(at.toISOString().slice(0, 10)).botsFiltered += n;
  }

  flush(at?: Date): void {
    if (at) this.heartbeat(at);
    const dir = path.join(analyticsRoot(), this.site);
    fs.mkdirSync(dir, { recursive: true });
    for (const d of this.days.values()) fs.writeFileSync(path.join(dir, `${d.day}.json`), JSON.stringify(d, null, 2));
  }
}
