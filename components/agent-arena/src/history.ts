import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './mm-contract.js';
import { arenaPaths } from './state.js';
import { mergeCandles, TIMEFRAME_SECONDS, type Candle, type GeckoTerminalClient, type PoolInfo, type Timeframe } from './geckoterminal.js';

/**
 * On-disk candle cache: `$MM_STATE_DIR/arena/history/<pool>-<timeframe><aggregate>.json`
 * (e.g. `…/history/7xKX…-minute5.json`). A cache file remembers which time range was
 * already requested (`coveredFromTs`/`coveredToTs`), so repeated backtests only fetch
 * the missing edges — or nothing. Incomplete (still open) candles are never cached.
 */
export type PoolHistory = {
  schema: 'mm.arena-history/v1';
  pool: PoolInfo;
  timeframe: Timeframe;
  aggregate: number;
  stepSec: number;
  fetchedAt: string;
  coveredFromTs: number;
  coveredToTs: number;
  candles: Candle[];
};

export type PoolIndex = { schema: 'mm.arena-pools/v1'; fetchedAt: string; pools: PoolInfo[] };

export const tfKey = (timeframe: Timeframe, aggregate: number) => `${timeframe}${aggregate}`;

export function historyPath(pool: string, timeframe: Timeframe, aggregate: number): string {
  const safe = pool.replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(arenaPaths.historyDir(), `${safe}-${tfKey(timeframe, aggregate)}.json`);
}

export const poolIndexPath = () => path.join(arenaPaths.historyDir(), 'pools.json');

/** JSON turns NaN into null; restore it. */
function revivePool(p: PoolInfo): PoolInfo {
  return { ...p, createdAtMs: typeof p.createdAtMs === 'number' ? p.createdAtMs : Number.NaN, priceChange: p.priceChange ?? {} };
}

export async function readCachedHistory(pool: string, timeframe: Timeframe, aggregate: number): Promise<PoolHistory | undefined> {
  const h = await readJsonSafe<PoolHistory | null>(historyPath(pool, timeframe, aggregate), null);
  if (!h || h.schema !== 'mm.arena-history/v1' || !Array.isArray(h.candles)) return undefined;
  return { ...h, pool: revivePool(h.pool) };
}

export async function readPoolIndex(): Promise<PoolInfo[]> {
  const idx = await readJsonSafe<PoolIndex | null>(poolIndexPath(), null);
  return idx?.schema === 'mm.arena-pools/v1' && Array.isArray(idx.pools) ? idx.pools.map(revivePool) : [];
}

export type HistoryRequest = {
  timeframe: Timeframe;
  aggregate: number;
  fromTs: number;
  toTs: number;
  /** Cache only: never call the API. */
  offline?: boolean;
  /** Wall clock (unix seconds) used to drop the still-open candle. */
  nowSec: number;
};

/**
 * Load candles for one pool, fetching only what the cache does not cover yet.
 * Returns undefined when nothing is available (offline + no cache, or API failure + no cache).
 */
export async function loadPoolHistory(
  client: GeckoTerminalClient | undefined,
  pool: PoolInfo,
  req: HistoryRequest,
  log: (msg: string) => void = () => undefined,
): Promise<PoolHistory | undefined> {
  const stepSec = TIMEFRAME_SECONDS[req.timeframe] * req.aggregate;
  const cached = await readCachedHistory(pool.address, req.timeframe, req.aggregate);
  // Never ask for (or cache) the bucket that is still open.
  const toTs = Math.min(req.toTs, Math.floor(req.nowSec / stepSec) * stepSec);
  const fromTs = Math.min(req.fromTs, toTs);
  const ranges: Array<[number, number]> = [];
  if (!cached) ranges.push([fromTs, toTs]);
  else {
    if (fromTs < cached.coveredFromTs) ranges.push([fromTs, cached.coveredFromTs]);
    if (toTs - cached.coveredToTs >= stepSec) ranges.push([cached.coveredToTs, toTs]);
  }
  if (ranges.length === 0 || req.offline || !client) {
    if (!cached && (req.offline || !client)) return undefined;
    return cached;
  }
  let candles = cached?.candles ?? [];
  let coveredFrom = cached?.coveredFromTs ?? Number.POSITIVE_INFINITY;
  let coveredTo = cached?.coveredToTs ?? Number.NEGATIVE_INFINITY;
  for (const [a, b] of ranges) {
    try {
      const fresh = await client.fetchOhlcv({ pool: pool.address, timeframe: req.timeframe, aggregate: req.aggregate, fromTs: a, toTs: b });
      candles = mergeCandles(candles, fresh.filter((c) => c.t + stepSec <= toTs));
      coveredFrom = Math.min(coveredFrom, a);
      coveredTo = Math.max(coveredTo, b);
    } catch (error) {
      log(`[history] ${pool.symbol} (${pool.address}) candles ${a}..${b} failed: ${(error as Error).message}`);
    }
  }
  if (!Number.isFinite(coveredFrom)) return cached; // every fetch failed
  const history: PoolHistory = {
    schema: 'mm.arena-history/v1',
    pool: cached ? { ...pool, createdAtMs: Number.isFinite(pool.createdAtMs) ? pool.createdAtMs : cached.pool.createdAtMs } : pool,
    timeframe: req.timeframe,
    aggregate: req.aggregate,
    stepSec,
    fetchedAt: new Date(req.nowSec * 1000).toISOString(),
    coveredFromTs: coveredFrom,
    coveredToTs: coveredTo,
    candles,
  };
  await writeJsonAtomic(historyPath(pool.address, req.timeframe, req.aggregate), history);
  return history;
}

export type DatasetRequest = {
  pools: number;
  days: number;
  timeframe: Timeframe;
  aggregate: number;
  offline?: boolean;
  nowSec: number;
};

export type Dataset = {
  dataSource: 'geckoterminal';
  fromTs: number;
  toTs: number;
  stepSec: number;
  histories: PoolHistory[];
};

/**
 * Discover pools (or use the cached pool index when offline / discovery fails),
 * then load each pool's candles for the last `days` days through the cache.
 */
export async function loadDataset(client: GeckoTerminalClient | undefined, req: DatasetRequest, log: (msg: string) => void = () => undefined): Promise<Dataset> {
  const stepSec = TIMEFRAME_SECONDS[req.timeframe] * req.aggregate;
  const toTs = Math.floor(req.nowSec / stepSec) * stepSec;
  const fromTs = toTs - Math.round(req.days * 86_400);
  let pools: PoolInfo[] = [];
  if (!req.offline && client) {
    try {
      pools = await client.discoverPools(req.pools);
      await writeJsonAtomic(poolIndexPath(), { schema: 'mm.arena-pools/v1', fetchedAt: new Date(req.nowSec * 1000).toISOString(), pools } satisfies PoolIndex);
    } catch (error) {
      log(`[history] pool discovery failed (${(error as Error).message}); using cached pool index`);
    }
  }
  if (pools.length === 0) pools = (await readPoolIndex()).slice(0, req.pools);
  const loaded: PoolHistory[] = [];
  for (const pool of pools.slice(0, req.pools)) {
    const h = await loadPoolHistory(client, pool, { timeframe: req.timeframe, aggregate: req.aggregate, fromTs, toTs, offline: req.offline, nowSec: req.nowSec }, log);
    if (h) loaded.push(h);
  }
  // Offline (or partially failed) runs: end the window where the cached data ends.
  const dataTo = Math.min(toTs, Math.max(Number.NEGATIVE_INFINITY, ...loaded.map((h) => h.coveredToTs)));
  const effTo = Number.isFinite(dataTo) ? dataTo : toTs;
  const effFrom = effTo - Math.round(req.days * 86_400);
  const histories = loaded.filter((h) => h.candles.some((c) => c.t >= effFrom && c.t < effTo));
  return { dataSource: 'geckoterminal', fromTs: effFrom, toTs: effTo, stepSec, histories };
}
