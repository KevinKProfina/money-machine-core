import { emitEvent, isKillSwitchActive, statePaths, writeJsonAtomic } from './mm-contract.js';
import { aggregate } from './aggregate.js';
import type { FetchLike } from './http.js';
import { AiServicesSource } from './sources/ai-services.js';
import { GumroadSource } from './sources/gumroad.js';
import { InboxSource } from './sources/inbox.js';
import { StripeSource } from './sources/stripe.js';
import { TradingSource } from './sources/trading.js';
import { type EngineState, loadEvents, loadState, mergeEvents, saveEvents, saveState, withLock } from './store.js';
import { type ExtendedRevenueReport, type Logger, type RevenueEvent, type RevenueSource, type SourceRunStatus, consoleLogger, roundUsd } from './types.js';

export const DEFAULT_SOURCES = ['trading', 'ai-services', 'inbox', 'stripe', 'gumroad'];

/** Builds the enabled adapters from env. Stripe/Gumroad are only enabled when their secrets are set. */
export function buildSources(
  state: EngineState,
  env: NodeJS.ProcessEnv = process.env,
  log: Logger = consoleLogger,
  fetchImpl?: FetchLike,
): RevenueSource[] {
  const wanted = (env.REVENUE_SOURCES?.trim() ? env.REVENUE_SOURCES : DEFAULT_SOURCES.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sources: RevenueSource[] = [];
  for (const name of wanted) {
    switch (name) {
      case 'trading':
        sources.push(new TradingSource(state));
        break;
      case 'ai-services':
        sources.push(new AiServicesSource());
        break;
      case 'inbox':
        sources.push(new InboxSource(log));
        break;
      case 'stripe': {
        const s = StripeSource.fromEnv(env, log, fetchImpl);
        if (s) sources.push(s);
        else log.info('stripe: STRIPE_API_KEY not set — skipped');
        break;
      }
      case 'gumroad': {
        const g = GumroadSource.fromEnv(env, log, fetchImpl);
        if (g) sources.push(g);
        else log.info('gumroad: GUMROAD_ACCESS_TOKEN not set — skipped');
        break;
      }
      default:
        log.warn(`unknown source "${name}" in REVENUE_SOURCES — ignored`);
    }
  }
  return sources;
}

export type CycleOptions = {
  now?: Date;
  log?: Logger;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Override adapters (tests, `npm run add`). Receives the loaded engine state. */
  sources?: (state: EngineState) => RevenueSource[];
};

export type CycleResult = { report: ExtendedRevenueReport; added: RevenueEvent[]; sources: SourceRunStatus[] };

/** One collection + aggregation cycle. Per-source failures degrade to "no new events". */
export async function runCycle(opts: CycleOptions = {}): Promise<CycleResult> {
  const log = opts.log ?? consoleLogger;
  const env = opts.env ?? process.env;
  return withLock(async () => {
    const now = opts.now ?? new Date();
    const state = await loadState();
    const existing = await loadEvents();
    const sources = opts.sources ? opts.sources(state) : buildSources(state, env, log, opts.fetchImpl);
    const backfillDays = Number(env.REVENUE_BACKFILL_DAYS ?? 30);
    const defaultSince = new Date(now.getTime() - (Number.isFinite(backfillDays) ? backfillDays : 30) * 24 * 3600 * 1000);

    if (isKillSwitchActive()) {
      log.info('kill switch active — revenue-engine only reads and aggregates (it never moves money), continuing');
    }

    let events = existing;
    const statuses: SourceRunStatus[] = [];
    const succeeded: RevenueSource[] = [];
    const added: RevenueEvent[] = [];
    for (const source of sources) {
      const cursor = state.cursors[source.name];
      const since = cursor ? new Date(cursor) : defaultSince;
      try {
        const collected = await source.collect(since);
        const res = mergeEvents(events, collected);
        events = res.merged;
        added.push(...res.added);
        if (res.invalid > 0) log.warn(`${source.name}: dropped ${res.invalid} invalid event(s)`);
        statuses.push({ name: source.name, ok: true, collected: collected.length, newEvents: res.added.length });
        succeeded.push(source);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        log.warn(`${source.name}: collect failed, skipping this cycle (${message})`);
        statuses.push({ name: source.name, ok: false, collected: 0, newEvents: 0, error: message });
        await emitEvent({ source: 'revenue-engine', level: 'warn', type: 'revenue.source-failed', message: `${source.name}: ${message}` });
      }
    }

    if (added.length > 0) await saveEvents(events);
    // Commit only after events are persisted: cursors advance, inbox files move.
    for (const source of succeeded) {
      try {
        await source.commit?.();
        state.cursors[source.name] = now.toISOString();
      } catch (err) {
        log.warn(`${source.name}: commit failed (${(err as Error).message})`);
      }
    }
    await saveState(state);

    const report: ExtendedRevenueReport = { ...aggregate(events, now), sources: statuses };
    await writeJsonAtomic(statePaths.revenue(), report);

    if (added.length > 0) {
      const byStream: Record<string, { amountUsd: number; count: number; simulated: boolean }> = {};
      for (const e of added) {
        const s = (byStream[e.stream] ??= { amountUsd: 0, count: 0, simulated: false });
        s.amountUsd = roundUsd(s.amountUsd + e.amountUsd);
        s.count++;
        s.simulated ||= e.simulated;
      }
      const sum = roundUsd(added.reduce((a, e) => a + e.amountUsd, 0));
      const anySim = added.some((e) => e.simulated);
      await emitEvent({
        source: 'revenue-engine',
        level: 'info',
        type: 'revenue.new',
        message: `${added.length} new revenue event(s), net ${sum.toFixed(2)} USD${anySim ? ' (includes simulated)' : ''}`,
        data: { byStream },
      });
    }
    log.info(
      `cycle done: ${added.length} new event(s), total ${report.totalUsd.toFixed(2)} USD ` +
        `(real ${report.realTotalUsd.toFixed(2)}, simulated ${report.simulatedTotalUsd.toFixed(2)}), HHI ${report.concentration.toFixed(3)}`,
    );
    return { report, added, sources: statuses };
  });
}
