import type { Candle, PoolInfo } from './geckoterminal.js';
import type { MarketSnapshot, MarketSource, PriceChange, Token } from './market.js';

/**
 * Replays cached historical candles as a MarketSource, one snapshot per step, so the
 * unchanged arena engine (trader species + paper fills + ledger) can run on history.
 *
 * NO LOOKAHEAD: a candle with open time t is only "known" at its close, t + step.
 * The snapshot at virtual time T is derived exclusively from candles with
 * t + step <= T (see `snapshotAt`), so a decision taken at step T never sees later
 * prices or volume. This is asserted by tests that rewrite all future candles and
 * check that the snapshot (and every trade up to T) is unchanged.
 *
 * Fields that GeckoTerminal OHLCV does not provide historically are PROXIES:
 * - liquidityUsd: discovery-time `reserve_in_usd` scaled by sqrt(price_T / price_ref)
 *   (constant-product pools: pool value ∝ sqrt(price)). price_ref is the discovery-time
 *   price, so the *level* of the proxy is anchored to a value observed after T (a
 *   known, documented bias; its dynamics only use data ≤ T).
 * - marketCapUsd: discovery-time FDV scaled linearly with price (same caveat).
 * - buys24h / sells24h: USD volume of up-candles / down-candles over the last 24 h,
 *   in units of $100 (flat candles split half/half). Only the ratio is meaningful.
 * - priceChange m5/h1/h24: close at T vs the last close at or before T−5m/1h/24h;
 *   absent when the history does not reach back that far (m5 is absent when a step
 *   is longer than 5 minutes).
 * - ageHours: from `pool_created_at` (NaN when unknown).
 */
export type ReplayOptions = {
  stepSec: number;
  /** First snapshot is at fromTs + stepSec (the first candle of the window has closed). */
  fromTs: number;
  /** Last snapshot is at the last step <= toTs. */
  toTs: number;
  /** A token is an entry candidate only if its last candle closed within this many seconds (default 1 h). */
  maxCandidateStaleSec?: number;
  /** A token keeps a (stale) price for marking held positions this long after its last candle (default 24 h). */
  maxPriceAgeSec?: number;
};

export type ReplaySeries = { pool: PoolInfo; candles: Candle[] };

type Prepared = {
  pool: PoolInfo;
  closeT: number[];
  close: number[];
  /** prefix sums: cumVol[i] = Σ v over candles [0, i) */
  cumVol: number[];
  cumUp: number[];
  cumDown: number[];
  priceRef: number;
};

/** Index of the last element <= x in an ascending array, -1 if none. */
export function lastIndexAtOrBefore(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= x) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function prepareSeries(series: ReplaySeries[], stepSec: number): Prepared[] {
  // one series per base token: keep the deepest pool
  const byMint = new Map<string, ReplaySeries>();
  for (const s of series) {
    if (s.candles.length === 0) continue;
    const prev = byMint.get(s.pool.baseTokenAddress);
    if (!prev || s.pool.reserveUsd > prev.pool.reserveUsd) byMint.set(s.pool.baseTokenAddress, s);
  }
  return [...byMint.values()]
    .sort((a, b) => (a.pool.address < b.pool.address ? -1 : 1))
    .map(({ pool, candles }) => {
      const sorted = [...candles].sort((a, b) => a.t - b.t);
      const closeT: number[] = [];
      const close: number[] = [];
      const cumVol = [0];
      const cumUp = [0];
      const cumDown = [0];
      for (const c of sorted) {
        closeT.push(c.t + stepSec);
        close.push(c.c);
        const up = c.c > c.o ? c.v : c.c < c.o ? 0 : c.v / 2;
        cumVol.push(cumVol.at(-1)! + c.v);
        cumUp.push(cumUp.at(-1)! + up);
        cumDown.push(cumDown.at(-1)! + (c.v - up));
      }
      const priceRef = pool.baseTokenPriceUsd > 0 ? pool.baseTokenPriceUsd : close.at(-1)!;
      return { pool, closeT, close, cumVol, cumUp, cumDown, priceRef };
    });
}

/** Snapshot tokens at virtual time T (unix seconds) using only candles closed at or before T. */
export function snapshotAt(prepared: Prepared[], T: number, opts: ReplayOptions): { tokens: Map<string, Token>; candidates: Token[] } {
  const maxStale = opts.maxCandidateStaleSec ?? 3_600;
  const maxAge = opts.maxPriceAgeSec ?? 86_400;
  const tokens = new Map<string, Token>();
  const candidates: Token[] = [];
  for (const s of prepared) {
    const i = lastIndexAtOrBefore(s.closeT, T);
    if (i < 0) continue;
    const lastClose = s.closeT[i]!;
    if (T - lastClose > maxAge) continue;
    const price = s.close[i]!;
    const pct = (backSec: number): number | undefined => {
      const j = lastIndexAtOrBefore(s.closeT, T - backSec);
      if (j < 0) return undefined;
      const ref = s.close[j]!;
      return ref > 0 ? (price / ref - 1) * 100 : undefined;
    };
    const priceChange: PriceChange = {};
    if (opts.stepSec <= 300) {
      const m5 = pct(300);
      if (m5 !== undefined) priceChange.m5 = m5;
    }
    const h1 = pct(3_600);
    if (h1 !== undefined) priceChange.h1 = h1;
    const h24 = pct(86_400);
    if (h24 !== undefined) priceChange.h24 = h24;
    // candles closed in (T − 24h, T]
    const k = lastIndexAtOrBefore(s.closeT, T - 86_400); // last index NOT in the window
    const sum = (cum: number[]) => cum[i + 1]! - cum[k + 1]!;
    const ratio = price / s.priceRef;
    const created = s.pool.createdAtMs;
    const token: Token = {
      mint: s.pool.baseTokenAddress,
      symbol: s.pool.symbol,
      name: s.pool.name,
      pairAddress: s.pool.address,
      dexId: s.pool.dexId,
      priceUsd: price,
      liquidityUsd: s.pool.reserveUsd > 0 && ratio > 0 ? s.pool.reserveUsd * Math.sqrt(ratio) : 0,
      volume24hUsd: sum(s.cumVol),
      marketCapUsd: s.pool.fdvUsd > 0 ? s.pool.fdvUsd * ratio : 0,
      ageHours: Number.isFinite(created) ? Math.max(0, (T * 1000 - created) / 3_600_000) : Number.NaN,
      buys24h: Math.round(sum(s.cumUp) / 100),
      sells24h: Math.round(sum(s.cumDown) / 100),
      priceChange,
    };
    tokens.set(token.mint, token);
    if (T - lastClose <= maxStale) candidates.push(token);
  }
  return { tokens, candidates };
}

/** Steps of a replay window: fromTs + step, fromTs + 2·step, … <= toTs. */
export function replayTimeline(fromTs: number, toTs: number, stepSec: number): number[] {
  const out: number[] = [];
  for (let T = fromTs + stepSec; T <= toTs; T += stepSec) out.push(T);
  return out;
}

export class ReplayMarket implements MarketSource {
  readonly id = 'replay' as const;
  private readonly prepared: Prepared[];
  readonly timeline: number[];
  private cursor = -1;

  constructor(
    series: ReplaySeries[],
    private readonly opts: ReplayOptions,
  ) {
    this.prepared = prepareSeries(series, opts.stepSec);
    this.timeline = replayTimeline(opts.fromTs, opts.toTs, opts.stepSec);
  }

  get steps(): number {
    return this.timeline.length;
  }

  get done(): boolean {
    return this.cursor >= this.timeline.length - 1;
  }

  /** Virtual time of the current (last returned) snapshot, or the window start before the first one. */
  now(): Date {
    const T = this.cursor >= 0 ? this.timeline[Math.min(this.cursor, this.timeline.length - 1)]! : this.opts.fromTs;
    return new Date(T * 1000);
  }

  /** Advances one step. `heldMints` are priced like every other token (nothing extra is known for them). */
  async snapshot(_heldMints: string[]): Promise<MarketSnapshot> {
    this.cursor++;
    const T = this.timeline[this.cursor];
    if (T === undefined) {
      return { source: 'replay', ok: false, error: 'replay exhausted', fetchedAt: this.now().toISOString(), candidates: [], tokens: new Map() };
    }
    const { tokens, candidates } = snapshotAt(this.prepared, T, this.opts);
    return { source: 'replay', ok: true, fetchedAt: new Date(T * 1000).toISOString(), candidates, tokens };
  }
}
