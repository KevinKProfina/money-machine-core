import { HttpError, type FetchLike } from './http.js';

/**
 * Historical market data from GeckoTerminal's public API (no key).
 *
 *   pools:  GET /api/v2/networks/solana/trending_pools?page=N
 *           GET /api/v2/networks/solana/pools?page=N            (top pools)
 *   candles GET /api/v2/networks/solana/pools/{pool}/ohlcv/{minute|hour|day}
 *               ?aggregate=n&limit=1000&before_timestamp=ts&currency=usd
 *           → data.attributes.ohlcv_list = [[ts, o, h, l, c, volumeUsd], ...] newest first
 *
 * The public API allows ~30 requests/minute. Every request goes through one
 * throttle (default one request per 2.1 s) and is retried with exponential backoff
 * on 429 / 5xx / network errors (a `Retry-After` header is honoured). Everything
 * (fetch, clock, sleep) is injectable so it is testable offline.
 */
export const GECKO_BASE = 'https://api.geckoterminal.com/api/v2';
export const GECKO_NETWORK = 'solana';

export type Timeframe = 'minute' | 'hour' | 'day';
export const TIMEFRAME_SECONDS: Record<Timeframe, number> = { minute: 60, hour: 3_600, day: 86_400 };
/** Aggregates GeckoTerminal accepts per timeframe. */
export const VALID_AGGREGATES: Record<Timeframe, number[]> = { minute: [1, 5, 15], hour: [1, 4, 12], day: [1] };

/** One OHLCV candle. `t` = bucket OPEN time (unix seconds); the close is only known at t + step. */
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type PoolInfo = {
  address: string;
  name: string;
  symbol: string;
  /** Base token mint (from relationships.base_token, falls back to the pool address). */
  baseTokenAddress: string;
  dexId: string;
  /** Values at discovery time (NOT historical). */
  baseTokenPriceUsd: number;
  reserveUsd: number;
  fdvUsd: number;
  volume24hUsd: number;
  /** ms epoch, NaN when unknown. */
  createdAtMs: number;
  priceChange: { m5?: number; h1?: number; h6?: number; h24?: number };
  buys24h: number;
  sells24h: number;
};

function num(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
}

function opt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

function stripNetwork(id: unknown): string | undefined {
  if (typeof id !== 'string' || id === '') return undefined;
  return id.startsWith(`${GECKO_NETWORK}_`) ? id.slice(GECKO_NETWORK.length + 1) : id;
}

type GeckoPool = {
  id?: string;
  attributes?: Record<string, unknown>;
  relationships?: { base_token?: { data?: { id?: string } }; dex?: { data?: { id?: string } } };
};

/** Parse a pools list response (trending_pools / pools). Unusable rows are dropped. */
export function parsePools(json: unknown): PoolInfo[] {
  const rows = (json as { data?: unknown })?.data;
  if (!Array.isArray(rows)) return [];
  const out: PoolInfo[] = [];
  for (const row of rows as GeckoPool[]) {
    const a = row?.attributes ?? {};
    const address = typeof a.address === 'string' && a.address ? a.address : stripNetwork(row?.id);
    if (!address) continue;
    const name = typeof a.name === 'string' ? a.name : address;
    const pc = (a.price_change_percentage ?? {}) as Record<string, unknown>;
    const tx = ((a.transactions ?? {}) as Record<string, { buys?: unknown; sells?: unknown }>).h24 ?? {};
    const created = typeof a.pool_created_at === 'string' ? Date.parse(a.pool_created_at) : Number.NaN;
    const priceChange: PoolInfo['priceChange'] = {};
    for (const k of ['m5', 'h1', 'h6', 'h24'] as const) {
      const v = opt(pc[k]);
      if (v !== undefined) priceChange[k] = v;
    }
    out.push({
      address,
      name,
      symbol: name.split('/')[0]!.trim() || '?',
      baseTokenAddress: stripNetwork(row?.relationships?.base_token?.data?.id) ?? address,
      dexId: row?.relationships?.dex?.data?.id ?? 'unknown',
      baseTokenPriceUsd: num(a.base_token_price_usd),
      reserveUsd: num(a.reserve_in_usd),
      fdvUsd: num(a.fdv_usd) || num(a.market_cap_usd),
      volume24hUsd: num((a.volume_usd as Record<string, unknown> | undefined)?.h24),
      createdAtMs: Number.isFinite(created) ? created : Number.NaN,
      priceChange,
      buys24h: num(tx.buys),
      sells24h: num(tx.sells),
    });
  }
  return out;
}

/** Parse an OHLCV response into candles sorted oldest → newest (deduplicated by time, invalid rows dropped). */
export function parseOhlcv(json: unknown): Candle[] {
  const list = (json as { data?: { attributes?: { ohlcv_list?: unknown } } })?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const byT = new Map<number, Candle>();
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map((x) => num(x)) as [number, number, number, number, number, number];
    if (!(t > 0) || !(c > 0) || !(o > 0)) continue;
    byT.set(t, { t, o, h: Math.max(h, o, c), l: l > 0 ? Math.min(l, o, c) : Math.min(o, c), c, v: Math.max(0, v) });
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/** Merge candle arrays (later arrays win on equal timestamps), sorted oldest → newest. */
export function mergeCandles(...lists: Candle[][]): Candle[] {
  const byT = new Map<number, Candle>();
  for (const list of lists) for (const c of list) byT.set(c.t, c);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spaces calls at least `minIntervalMs` apart (one shared slot; calls are serialised). */
export class Throttle {
  private nextAt = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    readonly minIntervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {}

  wait(): Promise<void> {
    const run = async () => {
      const t = this.now();
      if (t < this.nextAt) await this.sleep(this.nextAt - t);
      this.nextAt = Math.max(t, this.nextAt) + this.minIntervalMs;
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

export type GeckoOptions = {
  fetchImpl?: FetchLike;
  /** Min spacing between requests (default 2100 ms ≈ 28.5 req/min, under the public ~30/min). */
  minIntervalMs?: number;
  retries?: number;
  /** Base backoff for retries (doubles each attempt). */
  backoffMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: Sleep;
  log?: (msg: string) => void;
  baseUrl?: string;
};

export type OhlcvRequest = {
  pool: string;
  timeframe: Timeframe;
  aggregate: number;
  /** Inclusive lower bound (unix seconds). */
  fromTs: number;
  /** Exclusive upper bound (unix seconds). */
  toTs: number;
  /** Safety cap on pages per request (each page ≤ 1000 candles). */
  maxPages?: number;
};

export class GeckoTerminalClient {
  readonly throttle: Throttle;
  requests = 0;
  private readonly sleep: Sleep;

  constructor(private readonly opts: GeckoOptions = {}) {
    this.sleep = opts.sleep ?? realSleep;
    this.throttle = new Throttle(opts.minIntervalMs ?? 2_100, opts.now ?? Date.now, this.sleep);
  }

  private log(msg: string) {
    (this.opts.log ?? console.error)(`[geckoterminal] ${msg}`);
  }

  /** Throttled GET with retry/backoff. Throws after the last attempt. */
  async get(pathAndQuery: string): Promise<unknown> {
    const url = `${this.opts.baseUrl ?? GECKO_BASE}${pathAndQuery}`;
    const fetchImpl = this.opts.fetchImpl ?? (globalThis.fetch as FetchLike);
    const retries = this.opts.retries ?? 3;
    const backoff = this.opts.backoffMs ?? 3_000;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.throttle.wait();
      this.requests++;
      let retryAfterMs = 0;
      try {
        const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
        if (!res.ok) {
          const ra = Number(res.headers?.get?.('retry-after'));
          if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(120_000, ra * 1_000);
          throw new HttpError(`HTTP ${res.status} for ${url}`, res.status);
        }
        return await res.json();
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof HttpError) || error.status === 429 || error.status >= 500;
        if (attempt === retries || !retryable) break;
        const wait = Math.max(retryAfterMs, backoff * 2 ** attempt);
        this.log(`${(error as Error).message}; retry ${attempt + 1}/${retries} in ${wait} ms`);
        await this.sleep(wait);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Discover pools: trending pools first, then top pools, until `limit` pools with a
   * distinct base token were found. Pages that fail are skipped (logged).
   */
  async discoverPools(limit: number, maxPagesPerList = 10): Promise<PoolInfo[]> {
    const out = new Map<string, PoolInfo>();
    let failures = 0;
    let attempts = 0;
    for (const list of ['trending_pools', 'pools']) {
      for (let page = 1; page <= maxPagesPerList && out.size < limit; page++) {
        attempts++;
        let pools: PoolInfo[];
        try {
          pools = parsePools(await this.get(`/networks/${GECKO_NETWORK}/${list}?page=${page}`));
        } catch (error) {
          failures++;
          this.log(`discovery ${list} page ${page} failed: ${(error as Error).message}`);
          break;
        }
        if (pools.length === 0) break;
        for (const p of pools) {
          if (out.size >= limit) break;
          const existing = out.get(p.baseTokenAddress);
          if (!existing) out.set(p.baseTokenAddress, p);
          else if (p.reserveUsd > existing.reserveUsd) out.set(p.baseTokenAddress, p);
        }
      }
    }
    if (attempts > 0 && failures === attempts) throw new Error('all GeckoTerminal discovery requests failed');
    return [...out.values()];
  }

  /**
   * Fetch candles in [fromTs, toTs) by paging backwards with `before_timestamp`.
   * Stops when a page reaches fromTs, returns fewer than 1000 rows (start of the
   * pool's history) or does not get older (defensive).
   */
  async fetchOhlcv(req: OhlcvRequest): Promise<Candle[]> {
    let before = req.toTs;
    let all: Candle[] = [];
    const maxPages = req.maxPages ?? 100;
    for (let page = 0; page < maxPages; page++) {
      const q = `?aggregate=${req.aggregate}&limit=1000&before_timestamp=${before}&currency=usd`;
      const candles = parseOhlcv(await this.get(`/networks/${GECKO_NETWORK}/pools/${req.pool}/ohlcv/${req.timeframe}${q}`));
      if (candles.length === 0) break;
      all = mergeCandles(candles, all);
      const oldest = candles[0]!.t;
      if (oldest <= req.fromTs || candles.length < 1000 || oldest >= before) break;
      before = oldest;
    }
    return all.filter((c) => c.t >= req.fromTs && c.t < req.toTs);
  }
}
