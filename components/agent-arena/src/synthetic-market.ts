import { Rng, type RngState } from './rng.js';
import type { MarketSnapshot, MarketSource, Token } from './market.js';

/**
 * Seeded random-walk market for demos, tests and offline evolution runs.
 * Tokens have hidden, slowly changing trends (so momentum is weakly persistent),
 * fat-tailed jumps, rug pulls (price and liquidity collapse, then delisting) and a
 * steady stream of new listings. One snapshot = one 5-minute step.
 *
 * It is NOT a model of any real market. Anything learned on it proves nothing
 * about real markets; every report built from it carries the note
 * `synthetic-market-data`.
 */
export const SYNTHETIC_NOTE = 'synthetic-market-data';
const STEP_MINUTES = 5;
const HISTORY = 289; // 24 h of 5-minute steps + current

type SynToken = {
  mint: string;
  symbol: string;
  price: number;
  liquidity: number;
  turnover: number;
  createdStep: number;
  trend: number;
  vol: number;
  rugged: boolean;
  ruggedAtStep?: number;
  history: number[];
};

export type SyntheticMarketState = {
  schema: 'mm.arena-synthetic-market/v1';
  step: number;
  rng: RngState;
  nextIndex: number;
  regime: number;
  tokens: SynToken[];
};

export type SyntheticOptions = { seed: number | string; tokens?: number; now?: () => Date };

export class SyntheticMarket implements MarketSource {
  readonly id = 'synthetic' as const;
  private rng: Rng;
  private state: SyntheticMarketState;
  private readonly target: number;

  constructor(private readonly opts: SyntheticOptions, restored?: SyntheticMarketState) {
    this.target = opts.tokens ?? 40;
    if (restored && restored.schema === 'mm.arena-synthetic-market/v1') {
      this.state = restored;
      this.rng = new Rng(restored.rng);
    } else {
      this.rng = new Rng(`synthetic:${opts.seed}`);
      this.state = { schema: 'mm.arena-synthetic-market/v1', step: 0, rng: this.rng.state, nextIndex: 0, regime: 0, tokens: [] };
      for (let i = 0; i < this.target; i++) this.list(-this.rng.int(0, 24 * 60)); // ages 0..~120 days of steps/12
      for (let i = 0; i < HISTORY; i++) this.advance(); // warm up so priceChange fields are meaningful
    }
  }

  exportState(): SyntheticMarketState {
    return { ...this.state, rng: this.rng.state };
  }

  get step(): number {
    return this.state.step;
  }

  private list(createdStep = this.state.step): void {
    const idx = this.state.nextIndex++;
    const price = Math.exp(this.rng.range(Math.log(1e-6), Math.log(5)));
    this.state.tokens.push({
      mint: `SYN${idx.toString().padStart(6, '0')}${this.rng.hex(8)}`,
      symbol: `SYN${idx}`,
      price,
      liquidity: Math.exp(this.rng.range(Math.log(3_000), Math.log(3_000_000))),
      turnover: this.rng.range(0.2, 6),
      createdStep,
      trend: this.rng.normal() * 0.003,
      vol: this.rng.range(0.004, 0.03),
      rugged: false,
      history: [price],
    });
  }

  private ageHours(t: SynToken): number {
    return ((this.state.step - t.createdStep) * STEP_MINUTES) / 60;
  }

  /** Advance the market by one step. */
  advance(): void {
    const s = this.state;
    const rng = this.rng;
    s.step++;
    if (rng.chance(0.005)) s.regime = rng.normal() * 0.0012;
    for (const t of s.tokens) {
      if (t.rugged) {
        t.price *= Math.exp(rng.normal() * 0.05 - 0.01);
        t.liquidity = Math.max(50, t.liquidity * 0.97);
      } else {
        if (rng.chance(0.02)) t.trend = rng.normal() * 0.003;
        let logRet = t.trend + s.regime + t.vol * rng.normal();
        if (rng.chance(0.004)) logRet += rng.normal() * 0.25; // jump
        t.price *= Math.exp(logRet);
        t.liquidity = Math.max(500, t.liquidity * Math.exp(0.5 * logRet + rng.normal() * 0.01));
        if (rng.chance(0.01)) t.turnover = Math.min(20, Math.max(0.05, t.turnover * Math.exp(rng.normal() * 0.3)));
        const rugP = 0.0004 + 0.004 * Math.exp(-this.ageHours(t) / 48);
        if (rng.chance(rugP)) {
          t.rugged = true;
          t.ruggedAtStep = s.step;
          t.price *= rng.range(0.01, 0.1);
          t.liquidity *= rng.range(0.005, 0.05);
        }
      }
      t.history.push(t.price);
      if (t.history.length > HISTORY) t.history.splice(0, t.history.length - HISTORY);
    }
    // delist rugged tokens after 2 hours; list new tokens to keep the universe size
    s.tokens = s.tokens.filter((t) => !(t.rugged && s.step - (t.ruggedAtStep ?? s.step) > 24));
    while (s.tokens.length < this.target) this.list();
    if (rng.chance(0.03)) this.list();
    if (s.tokens.length > this.target * 1.5) s.tokens.shift();
  }

  private toToken(t: SynToken): Token {
    const h = t.history;
    const pct = (back: number) => {
      const ref = h[Math.max(0, h.length - 1 - back)]!;
      return ref > 0 ? (t.price / ref - 1) * 100 : 0;
    };
    const momentum = t.rugged ? -0.02 : t.trend;
    const ratio = Math.exp(momentum * 120 + this.rng.normal() * 0.25);
    const volume = t.liquidity * t.turnover;
    const txns = Math.max(1, Math.round(volume / 250));
    const buys = Math.round((txns * ratio) / (1 + ratio));
    const ageHours = this.ageHours(t);
    return {
      mint: t.mint,
      symbol: t.symbol,
      name: `Synthetic ${t.symbol}`,
      pairAddress: `${t.mint}-pool`,
      dexId: 'synthetic',
      priceUsd: t.price,
      liquidityUsd: t.liquidity,
      volume24hUsd: volume,
      marketCapUsd: t.liquidity * 8,
      ageHours,
      buys24h: buys,
      sells24h: txns - buys,
      priceChange: { m5: pct(1), h1: pct(12), ...(h.length >= HISTORY ? { h24: pct(HISTORY - 1) } : {}) },
    };
  }

  async snapshot(_heldMints: string[]): Promise<MarketSnapshot> {
    this.advance();
    const tokens = new Map<string, Token>();
    for (const t of this.state.tokens) tokens.set(t.mint, this.toToken(t));
    const now = this.opts.now?.() ?? new Date();
    return { source: 'synthetic', ok: true, fetchedAt: now.toISOString(), candidates: [...tokens.values()], tokens };
  }
}
