import path from 'node:path';
import { readJsonSafe, stateDir } from './mm-contract.js';
import type { AppConfig, ExitRules, RankBy, SizingRules, StrategyRules } from './config.js';

/**
 * STRATEGY_SOURCE=arena: use the genome that agent-arena promoted
 * (`$MM_STATE_DIR/arena/promotions.json` → `promoted.genome`) instead of the static
 * env strategy. Promotion only ever changes strategy PARAMETERS — the mode
 * (paper / dry-run / live) is resolved from MODE + LIVE_TRADING_CONFIRM exactly as
 * before and is never read from this file.
 *
 * Genome → trader mapping (`mapGenomeToSettings`, pure):
 *
 * | arena gene        | trader setting                         | transform |
 * |-------------------|----------------------------------------|-----------|
 * | minLiquidityUsd   | strategy.minLiquidityUsd               | max(gene, 10 000) liquidity floor ($50 trades into thinner pools are mostly price impact) |
 * | minVolume24hUsd   | strategy.minVolume24hUsd               | as is |
 * | minAgeHours       | strategy.minAgeHours                   | as is |
 * | maxAgeHours       | strategy.maxAgeHours                   | as is |
 * | minBuySellRatio   | strategy.minBuySellRatio               | as is |
 * | minChangeM5       | strategy.minChangeM5                   | as is (skipped when DexScreener omits m5) |
 * | minChangeH1       | strategy.minChangeH1                   | as is |
 * | maxChangeH1       | strategy.maxChangeH1                   | as is |
 * | minChangeH24      | strategy.minChangeH24                  | as is |
 * | rankBy (0..3)     | strategy.rankBy                        | 0 h1-momentum, 1 turnover, 2 buy-pressure, 3 youngest |
 * | positionPct       | sizing.maxPositionPct                  | min(gene, static MAX_POSITION_PCT) — the env cap stays a hard limit |
 * | maxOpenPositions  | sizing.maxConcurrentPositions          | min(gene, static MAX_CONCURRENT_POSITIONS) |
 * | takeProfitPct     | exits.takeProfitPct                    | as is |
 * | stopLossPct       | exits.stopLossPct                      | as is |
 * | trailingStopPct   | exits.trailingStopPct                  | as is (0 = off); trailingActivationPct = 0 (the arena trails as soon as the peak is above entry) |
 * | maxHoldCycles     | exits.maxHoldHours                     | cycles × cycleMinutes / 60 |
 * | cooldownCycles    | entryCooldownHours                     | cycles × cycleMinutes / 60 (no new entries for that long after any close) |
 *
 * No genome field is ignored. Trader-only settings without a genome counterpart keep
 * their static env values, which can only make the promoted strategy stricter:
 * MIN/MAX_MARKET_CAP_USD, MIN_TXNS_24H, MIN_LIQUIDITY_TO_MCAP, MIN_SCORE,
 * MAX_USD_PER_TRADE, MIN_TRADE_USD, STARTING_CAPITAL_USD, the 24 h per-mint re-entry
 * cooldown and the paper fill model.
 *
 * Known semantic differences: the arena's entry price excludes the entry fee while
 * the trader's includes it (TP/SL trigger marginally later here), and the arena
 * measures time in cycles while the trader uses wall-clock hours.
 */

export const GENES = [
  'minLiquidityUsd',
  'minVolume24hUsd',
  'minAgeHours',
  'maxAgeHours',
  'minBuySellRatio',
  'minChangeM5',
  'minChangeH1',
  'maxChangeH1',
  'minChangeH24',
  'positionPct',
  'takeProfitPct',
  'stopLossPct',
  'trailingStopPct',
  'maxHoldCycles',
  'maxOpenPositions',
  'cooldownCycles',
  'rankBy',
] as const;
export type Gene = (typeof GENES)[number];

/** Gene bounds — a copy of agent-arena's TRADER_GENOME (src/species/trader.ts). */
export const GENOME_BOUNDS: Record<Gene, { min: number; max: number; integer?: boolean }> = {
  minLiquidityUsd: { min: 1_000, max: 5_000_000 },
  minVolume24hUsd: { min: 1_000, max: 50_000_000 },
  minAgeHours: { min: 0, max: 720 },
  maxAgeHours: { min: 1, max: 20_000 },
  minBuySellRatio: { min: 0.2, max: 4 },
  minChangeM5: { min: -20, max: 20 },
  minChangeH1: { min: -50, max: 50 },
  maxChangeH1: { min: -10, max: 300 },
  minChangeH24: { min: -90, max: 300 },
  positionPct: { min: 0.02, max: 0.5 },
  takeProfitPct: { min: 1, max: 500 },
  stopLossPct: { min: 1, max: 90 },
  trailingStopPct: { min: 0, max: 80 },
  maxHoldCycles: { min: 1, max: 2_000, integer: true },
  maxOpenPositions: { min: 1, max: 10, integer: true },
  cooldownCycles: { min: 0, max: 100, integer: true },
  rankBy: { min: 0, max: 3, integer: true },
};

export const ARENA_RANK_BY: RankBy[] = ['h1-momentum', 'turnover', 'buy-pressure', 'youngest'];
export const LIQUIDITY_FLOOR_USD = 10_000;
export const DEFAULT_CYCLE_MINUTES = 5;

export type ArenaGenome = Record<Gene, number>;

export type StrategySettings = {
  strategy: StrategyRules;
  exits: ExitRules;
  sizing: SizingRules;
  entryCooldownHours: number;
};

export type ActiveStrategy = StrategySettings & {
  /** 'static' or the arena genome id. */
  id: string;
  source: 'static' | 'arena';
  notes: string[];
};

/** Validate a genome: every gene must be a finite number; values are clamped to bounds (reported). */
export function validateGenome(input: unknown): { ok: true; genome: ArenaGenome; clamped: string[] } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'genome is not an object' };
  const src = input as Record<string, unknown>;
  const genome = {} as ArenaGenome;
  const clamped: string[] = [];
  for (const k of GENES) {
    const b = GENOME_BOUNDS[k];
    const v = src[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `gene ${k} missing or not a finite number` };
    let c = Math.min(b.max, Math.max(b.min, v));
    if (b.integer) c = Math.round(c);
    if (c !== v) clamped.push(k);
    genome[k] = c;
  }
  if (genome.maxAgeHours < genome.minAgeHours + 1) {
    genome.maxAgeHours = Math.min(GENOME_BOUNDS.maxAgeHours.max, genome.minAgeHours + 1);
    clamped.push('maxAgeHours');
  }
  if (genome.maxChangeH1 < genome.minChangeH1) {
    genome.maxChangeH1 = genome.minChangeH1;
    clamped.push('maxChangeH1');
  }
  return { ok: true, genome, clamped };
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** Pure genome → trader settings mapping (see the table above). `base` is the static config. */
export function mapGenomeToSettings(genome: ArenaGenome, base: AppConfig, cycleMinutes = DEFAULT_CYCLE_MINUTES): StrategySettings {
  const g = genome;
  const hours = (cycles: number) => round((cycles * cycleMinutes) / 60);
  return {
    strategy: {
      ...base.strategy,
      minLiquidityUsd: Math.max(LIQUIDITY_FLOOR_USD, g.minLiquidityUsd),
      minVolume24hUsd: g.minVolume24hUsd,
      minAgeHours: g.minAgeHours,
      maxAgeHours: g.maxAgeHours,
      minBuySellRatio: g.minBuySellRatio,
      minChangeM5: g.minChangeM5,
      minChangeH1: g.minChangeH1,
      maxChangeH1: g.maxChangeH1,
      minChangeH24: g.minChangeH24,
      rankBy: ARENA_RANK_BY[g.rankBy] ?? 'h1-momentum',
    },
    exits: {
      takeProfitPct: g.takeProfitPct,
      stopLossPct: g.stopLossPct,
      trailingStopPct: g.trailingStopPct,
      trailingActivationPct: 0,
      maxHoldHours: hours(g.maxHoldCycles),
    },
    sizing: {
      ...base.sizing,
      maxPositionPct: Math.min(g.positionPct, base.sizing.maxPositionPct),
      maxConcurrentPositions: Math.min(g.maxOpenPositions, base.sizing.maxConcurrentPositions),
    },
    entryCooldownHours: hours(g.cooldownCycles),
  };
}

export function staticStrategy(cfg: AppConfig, notes: string[] = []): ActiveStrategy {
  return { id: 'static', source: 'static', strategy: cfg.strategy, exits: cfg.exits, sizing: cfg.sizing, entryCooldownHours: cfg.entryCooldownHours, notes };
}

export const promotionsPath = () => path.join(stateDir(), 'arena', 'promotions.json');

type PromotionsFile = {
  schema?: string;
  cycleMinutes?: unknown;
  promoted?: { genomeId?: unknown; genome?: unknown; cycleMinutes?: unknown; promotedAt?: unknown };
};

/**
 * Resolve the strategy for this cycle. static → env. arena → promoted genome, or
 * static with a note when the file is missing, invalid or has nothing promoted.
 */
export async function resolveStrategy(cfg: AppConfig): Promise<ActiveStrategy> {
  if (cfg.strategySource !== 'arena') return staticStrategy(cfg);
  const fallback = (why: string) => staticStrategy(cfg, [`STRATEGY_SOURCE=arena but ${why}; using the static strategy`]);
  const file = await readJsonSafe<PromotionsFile | null>(promotionsPath(), null);
  if (!file) return fallback(`${promotionsPath()} is missing or unreadable`);
  if (file.schema !== 'mm.arena-promotions/v1') return fallback(`promotions.json has an unknown schema (${String(file.schema)})`);
  const p = file.promoted;
  if (!p) return fallback('no strategy is promoted yet');
  if (typeof p.genomeId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.genomeId)) return fallback('promoted.genomeId is invalid');
  const v = validateGenome(p.genome);
  if (!v.ok) return fallback(`promoted genome ${p.genomeId} is invalid (${v.error})`);
  const cmRaw = typeof p.cycleMinutes === 'number' ? p.cycleMinutes : typeof file.cycleMinutes === 'number' ? file.cycleMinutes : DEFAULT_CYCLE_MINUTES;
  const cycleMinutes = Number.isFinite(cmRaw) && cmRaw >= 1 && cmRaw <= 1_440 ? cmRaw : DEFAULT_CYCLE_MINUTES;
  const settings = mapGenomeToSettings(v.genome, cfg, cycleMinutes);
  const notes = [`arena strategy ${p.genomeId}${typeof p.promotedAt === 'string' ? ` (promoted ${p.promotedAt})` : ''}, ${cycleMinutes} min/cycle`];
  if (v.clamped.length) notes.push(`arena genome ${p.genomeId}: clamped ${v.clamped.join(', ')}`);
  return { id: p.genomeId, source: 'arena', ...settings, notes };
}
