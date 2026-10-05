import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJsonSafe, stateDir, writeJsonAtomic } from './mm-contract.js';
import { type RevenueEvent, isStreamKind } from './types.js';

export const enginePaths = {
  dir: () => path.join(stateDir(), 'revenue-engine'),
  events: () => path.join(stateDir(), 'revenue-engine', 'events.json'),
  state: () => path.join(stateDir(), 'revenue-engine', 'state.json'),
  lock: () => path.join(stateDir(), 'revenue-engine', '.lock'),
  inbox: () => path.join(stateDir(), 'revenue-engine', 'inbox'),
  inboxProcessed: () => path.join(stateDir(), 'revenue-engine', 'inbox', 'processed'),
  inboxFailed: () => path.join(stateDir(), 'revenue-engine', 'inbox', 'failed'),
};

type EventsFile = { schema: 'revenue-engine.events/v1'; updated: string; events: RevenueEvent[] };

export type EngineState = {
  schema: 'revenue-engine.state/v1';
  /** Last-seen realized PnL per `${strategy}:${mode}`. */
  tradingLastSeen: Record<string, { realizedPnlUsd: number; lastUpdated: string }>;
  /** Per-source cursor: ISO timestamp of the start of the last successful collect. */
  cursors: Record<string, string>;
};

export function emptyState(): EngineState {
  return { schema: 'revenue-engine.state/v1', tradingLastSeen: {}, cursors: {} };
}

export function isValidEvent(e: unknown): e is RevenueEvent {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    typeof r.stream === 'string' &&
    r.stream.length > 0 &&
    isStreamKind(r.kind) &&
    typeof r.amountUsd === 'number' &&
    Number.isFinite(r.amountUsd) &&
    typeof r.timestamp === 'string' &&
    Number.isFinite(Date.parse(r.timestamp)) &&
    typeof r.source === 'string' &&
    typeof r.simulated === 'boolean'
  );
}

export async function loadEvents(): Promise<RevenueEvent[]> {
  const file = await readJsonSafe<EventsFile | RevenueEvent[] | null>(enginePaths.events(), null);
  const list = Array.isArray(file) ? file : file?.events ?? [];
  return list.filter(isValidEvent);
}

export async function saveEvents(events: RevenueEvent[]): Promise<void> {
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  const file: EventsFile = { schema: 'revenue-engine.events/v1', updated: new Date().toISOString(), events: sorted };
  await writeJsonAtomic(enginePaths.events(), file);
}

/**
 * Merges incoming events into existing ones, deduplicated by id. Existing events win
 * (an id is immutable once recorded). Invalid events are dropped.
 */
export function mergeEvents(
  existing: RevenueEvent[],
  incoming: RevenueEvent[],
): { merged: RevenueEvent[]; added: RevenueEvent[]; invalid: number } {
  const byId = new Map<string, RevenueEvent>();
  for (const e of existing) if (!byId.has(e.id)) byId.set(e.id, e);
  const added: RevenueEvent[] = [];
  let invalid = 0;
  for (const e of incoming) {
    if (!isValidEvent(e)) {
      invalid++;
      continue;
    }
    if (byId.has(e.id)) continue;
    byId.set(e.id, e);
    added.push(e);
  }
  return { merged: [...byId.values()], added, invalid };
}

export async function loadState(): Promise<EngineState> {
  const s = await readJsonSafe<EngineState | null>(enginePaths.state(), null);
  if (!s || s.schema !== 'revenue-engine.state/v1') return emptyState();
  return { ...emptyState(), ...s, tradingLastSeen: { ...s.tradingLastSeen }, cursors: { ...s.cursors } };
}

export async function saveState(state: EngineState): Promise<void> {
  await writeJsonAtomic(enginePaths.state(), state);
}

const STALE_LOCK_MS = 10 * 60 * 1000;

/** Simple exclusive lock file so `npm run add` and a running loop never clobber each other. */
export async function withLock<T>(fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
  await fsp.mkdir(enginePaths.dir(), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await fsp.open(enginePaths.lock(), 'wx');
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}`);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const st = await fsp.stat(enginePaths.lock());
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          await fsp.rm(enginePaths.lock(), { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`could not acquire lock ${enginePaths.lock()}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(enginePaths.lock(), { force: true });
  }
}
