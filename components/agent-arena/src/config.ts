import type { MarketSourceId } from './market.js';

export const STRATEGY_NAME = 'agent-arena';

export type ArenaConfig = {
  mode: 'paper';
  modeNotes: string[];
  market: MarketSourceId;
  /** undefined = random seed chosen at genesis (then persisted). */
  seed?: string;
  syntheticTokens: number;
  intervalMs: number;

  startingCapitalUsd: number;
  seedUsd: number;
  minPopulation: number;
  maxPopulation: number;
  upkeepUsd: number;
  deathUsd: number;
  reproMultiple: number;
  reproMinAge: number;
  reproShare: number;
  mutationRate: number;
  crossoverRate: number;
  /** Max spontaneous spawns from treasury per cycle (min-population refill). */
  maxSpawnsPerCycle: number;
  /** Random immigrants spawned from the treasury every cycle (exploration), on top of the min-population refill. */
  immigrantsPerCycle: number;
  /** Immigrants are only funded while treasury > this fraction of arena equity. */
  treasuryReservePct: number;

  feeBps: number;
  slippageBps: number;
  minTradeUsd: number;
  /** Positions without any price for this many cycles are written off at zero. */
  staleWriteOffCycles: number;

  llm: {
    apiKey?: string;
    every: number;
    genomes: number;
    dailyBudgetUsd: number;
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
    maxTokens: number;
  };

  equityCurveMax: number;
  graveyardMax: number;

  /** Spawn genomes from arena/pretrained.json (written by `backtest --evolve`) once into the live population. */
  adoptPretrained: boolean;
  promotion: PromotionCriteria;
};

/** Gates a genome must pass before it is promoted to the real (paper-by-default) trader. */
export type PromotionCriteria = {
  /** Min cycles the agent has lived in the live (non-synthetic) arena. */
  minCycles: number;
  /** Min closed paper trades in the arena. */
  minTrades: number;
  /** Max drawdown of the agent's arena balance (0..1). */
  maxDrawdown: number;
  /** Min closed trades in the out-of-sample backtest windows. */
  minOosTrades: number;
  /** Out-of-sample return after costs must be strictly above this (fraction). */
  minOosReturn: number;
  /** Max out-of-sample drawdown (0..1). */
  maxOosDrawdown: number;
  /** A challenger must beat the promoted strategy's score by this much. */
  margin: number;
  /** Backtest evidence older than this is ignored. */
  maxBacktestAgeHours: number;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class LiveModeRefused extends ConfigError {
  constructor() {
    super(
      'MODE=live refused: agent-arena is PAPER ONLY. It has no real-money execution path at all ' +
        '(no wallet, no swap client). Unset MODE or use MODE=paper.',
    );
    this.name = 'LiveModeRefused';
  }
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number, min: number, max: number, integer = false): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new ConfigError(`${key}=${raw} is not a number`);
  if (v < min || v > max) throw new ConfigError(`${key}=${raw} out of range [${min}, ${max}]`);
  if (integer && !Number.isInteger(v)) throw new ConfigError(`${key}=${raw} must be an integer`);
  return v;
}

export function readConfig(env: Env = process.env): ArenaConfig {
  const modeNotes: string[] = [];
  const mode = (env.MODE ?? 'paper').trim().toLowerCase() || 'paper';
  if (mode === 'live') throw new LiveModeRefused();
  if (mode === 'dry-run') modeNotes.push('MODE=dry-run: agent-arena only has simulated paper fills; running in paper mode');
  else if (mode !== 'paper') throw new ConfigError(`MODE=${env.MODE} unknown (paper | dry-run)`);

  const market = (env.ARENA_MARKET ?? 'dexscreener').trim().toLowerCase();
  if (market !== 'dexscreener' && market !== 'synthetic') throw new ConfigError(`ARENA_MARKET=${env.ARENA_MARKET} unknown (dexscreener | synthetic)`);

  const seedUsd = num(env, 'ARENA_SEED_USD', 5, 0.01, 1e9);
  const deathUsd = num(env, 'ARENA_DEATH_USD', 0.5, 0, 1e9);
  if (deathUsd >= seedUsd) throw new ConfigError(`ARENA_DEATH_USD (${deathUsd}) must be below ARENA_SEED_USD (${seedUsd})`);
  const minPopulation = num(env, 'ARENA_MIN_POPULATION', 20, 0, 1e6, true);
  const maxPopulation = num(env, 'ARENA_MAX_POPULATION', 2000, 1, 1e6, true);
  if (minPopulation > maxPopulation) throw new ConfigError('ARENA_MIN_POPULATION must be <= ARENA_MAX_POPULATION');

  return {
    mode: 'paper',
    modeNotes,
    market,
    seed: env.ARENA_SEED?.trim() || undefined,
    syntheticTokens: num(env, 'ARENA_SYNTHETIC_TOKENS', 40, 5, 1000, true),
    intervalMs: num(env, 'ARENA_INTERVAL_MS', 300_000, 1_000, 86_400_000, true),

    startingCapitalUsd: num(env, 'ARENA_STARTING_CAPITAL_USD', 500, 0, 1e12),
    seedUsd,
    minPopulation,
    maxPopulation,
    upkeepUsd: num(env, 'ARENA_UPKEEP_USD', 0.002, 0, 1e6),
    deathUsd,
    reproMultiple: num(env, 'ARENA_REPRO_MULTIPLE', 2, 1.01, 1000),
    reproMinAge: num(env, 'ARENA_REPRO_MIN_AGE', 12, 0, 1e9, true),
    reproShare: num(env, 'ARENA_REPRO_SHARE', 0.5, 0.01, 0.99),
    mutationRate: num(env, 'ARENA_MUTATION_RATE', 0.2, 0, 1),
    crossoverRate: num(env, 'ARENA_CROSSOVER_RATE', 0.15, 0, 1),
    maxSpawnsPerCycle: num(env, 'ARENA_MAX_SPAWNS_PER_CYCLE', 20, 0, 1e6, true),
    immigrantsPerCycle: num(env, 'ARENA_IMMIGRANTS_PER_CYCLE', 1, 0, 1e6, true),
    treasuryReservePct: num(env, 'ARENA_TREASURY_RESERVE_PCT', 0.2, 0, 1),

    feeBps: num(env, 'ARENA_FEE_BPS', 30, 0, 5_000),
    slippageBps: num(env, 'ARENA_SLIPPAGE_BPS', 100, 0, 5_000),
    minTradeUsd: num(env, 'ARENA_MIN_TRADE_USD', 0.25, 0, 1e9),
    staleWriteOffCycles: num(env, 'ARENA_STALE_WRITE_OFF_CYCLES', 288, 1, 1e9, true),

    llm: {
      apiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
      every: num(env, 'ARENA_LLM_EVERY', 50, 1, 1e9, true),
      genomes: num(env, 'ARENA_LLM_GENOMES', 5, 1, 50, true),
      dailyBudgetUsd: num(env, 'ARENA_LLM_DAILY_BUDGET_USD', 1, 0, 1e6),
      inputUsdPerMTok: num(env, 'ARENA_LLM_INPUT_USD_PER_MTOK', 4, 0, 1e4),
      outputUsdPerMTok: num(env, 'ARENA_LLM_OUTPUT_USD_PER_MTOK', 20, 0, 1e4),
      maxTokens: 2000,
    },

    equityCurveMax: 500,
    graveyardMax: 500,

    adoptPretrained: (env.ARENA_ADOPT_PRETRAINED ?? '1').trim() !== '0',
    promotion: {
      minCycles: num(env, 'ARENA_PROMO_MIN_CYCLES', 288, 0, 1e9, true),
      minTrades: num(env, 'ARENA_PROMO_MIN_TRADES', 10, 0, 1e9, true),
      maxDrawdown: num(env, 'ARENA_PROMO_MAX_DRAWDOWN', 0.3, 0, 1),
      minOosTrades: num(env, 'ARENA_PROMO_MIN_OOS_TRADES', 5, 0, 1e9, true),
      minOosReturn: num(env, 'ARENA_PROMO_MIN_OOS_RETURN', 0, -1, 100),
      maxOosDrawdown: num(env, 'ARENA_PROMO_MAX_OOS_DRAWDOWN', 0.3, 0, 1),
      margin: num(env, 'ARENA_PROMO_MARGIN', 0.02, 0, 100),
      maxBacktestAgeHours: num(env, 'ARENA_PROMO_MAX_BACKTEST_AGE_HOURS', 168, 1, 1e6),
    },
  };
}
