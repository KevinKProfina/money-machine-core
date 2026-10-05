import type { RunMode } from './mm-contract.js';

export const STRATEGY_NAME = 'solana-trader';
export const LIVE_CONFIRM_PHRASE = 'I_UNDERSTAND_REAL_MONEY_RISK';

export type StrategyRules = {
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minAgeHours: number;
  minTxns24h: number;
  minBuySellRatio: number;
  minLiquidityToMcap: number;
  minScore: number;
  /** Max pair age (h). Infinity = no upper bound (default). */
  maxAgeHours: number;
  /** Momentum gates on DexScreener priceChange (%); undefined = gate off (default). A gate is skipped when the field is absent. */
  minChangeM5?: number;
  minChangeH1?: number;
  maxChangeH1?: number;
  minChangeH24?: number;
  /** Candidate order: 'score' (default) or one of the arena rankings. */
  rankBy: RankBy;
};

export const RANK_BY = ['score', 'h1-momentum', 'turnover', 'buy-pressure', 'youngest'] as const;
export type RankBy = (typeof RANK_BY)[number];
export type StrategySource = 'static' | 'arena';

export type ExitRules = {
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number;
  /** Trailing stop only arms once price has been at least this far above entry. */
  trailingActivationPct: number;
  maxHoldHours: number;
};

export type SizingRules = {
  startingCapitalUsd: number;
  maxUsdPerTrade: number;
  maxPositionPct: number;
  maxConcurrentPositions: number;
  minTradeUsd: number;
};

export type AppConfig = {
  mode: RunMode;
  /** Human-readable notes about how the mode was resolved (e.g. live requested but not confirmed). */
  modeNotes: string[];
  pollIntervalMs: number;
  maxCandidates: number;
  /** Where entry/exit/sizing parameters come from: env (static, default) or the arena's promoted genome. Never affects the mode. */
  strategySource: StrategySource;
  /** No new entries for this many hours after the most recent close (0 = off, default). */
  entryCooldownHours: number;
  strategy: StrategyRules;
  exits: ExitRules;
  sizing: SizingRules;
  paperSlippageBps: number;
  paperFeeBps: number;
  liveSlippageBps: number;
  killClosesPositions: boolean;
  useClaudeGate: boolean;
  anthropicApiKey?: string;
  solanaPrivateKey?: string;
  solanaRpcUrl: string;
  minSolBalance: number;
  telegramBotToken?: string;
  telegramChatId?: string;
};

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number (got "${raw}")`);
  return value;
}

function optNum(env: Env, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  return num(env, key, 0);
}

function flag(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function argValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

/**
 * Mode resolution (safe by default):
 * - live only when MODE=live AND LIVE_TRADING_CONFIRM matches the phrase exactly
 * - dry-run when requested via MODE/--mode or DRY_RUN=true
 * - everything else (including unconfirmed live and unknown values) → paper
 */
export function resolveMode(env: Env, argv: string[]): { mode: RunMode; notes: string[] } {
  const requested = (argValue(argv, '--mode') ?? env.MODE ?? '').trim().toLowerCase();
  const notes: string[] = [];
  if (requested === 'live') {
    if (env.LIVE_TRADING_CONFIRM === LIVE_CONFIRM_PHRASE) return { mode: 'live', notes };
    notes.push('MODE=live requested but LIVE_TRADING_CONFIRM is not set to the confirmation phrase; running in paper mode');
    return { mode: 'paper', notes };
  }
  if (requested === 'dry-run' || (requested === '' && flag(env, 'DRY_RUN', false))) return { mode: 'dry-run', notes };
  if (requested !== '' && requested !== 'paper') notes.push(`Unknown MODE "${requested}"; running in paper mode`);
  return { mode: 'paper', notes };
}

export function readConfig(env: Env = process.env, argv: string[] = process.argv): AppConfig {
  const { mode, notes } = resolveMode(env, argv);
  const source = (env.STRATEGY_SOURCE ?? '').trim().toLowerCase() || 'static';
  if (source !== 'static' && source !== 'arena') notes.push(`Unknown STRATEGY_SOURCE "${env.STRATEGY_SOURCE}"; using static`);
  const rankBy = (env.RANK_BY ?? '').trim().toLowerCase() || 'score';
  if (!(RANK_BY as readonly string[]).includes(rankBy)) throw new Error(`RANK_BY must be one of ${RANK_BY.join(', ')} (got "${env.RANK_BY}")`);
  const cfg: AppConfig = {
    mode,
    modeNotes: notes,
    pollIntervalMs: num(env, 'POLL_INTERVAL_MS', 300_000),
    maxCandidates: num(env, 'MAX_CANDIDATES', 30),
    strategySource: source === 'arena' ? 'arena' : 'static',
    entryCooldownHours: num(env, 'ENTRY_COOLDOWN_HOURS', 0),
    strategy: {
      minLiquidityUsd: num(env, 'MIN_LIQUIDITY_USD', 50_000),
      minVolume24hUsd: num(env, 'MIN_VOLUME_24H_USD', 100_000),
      minMarketCapUsd: num(env, 'MIN_MARKET_CAP_USD', 250_000),
      maxMarketCapUsd: num(env, 'MAX_MARKET_CAP_USD', 500_000_000),
      minAgeHours: num(env, 'MIN_AGE_HOURS', 24),
      minTxns24h: num(env, 'MIN_TXNS_24H', 200),
      minBuySellRatio: num(env, 'MIN_BUY_SELL_RATIO', 0.9),
      minLiquidityToMcap: num(env, 'MIN_LIQUIDITY_TO_MCAP', 0.03),
      minScore: num(env, 'MIN_SCORE', 50),
      maxAgeHours: num(env, 'MAX_AGE_HOURS', Number.POSITIVE_INFINITY),
      minChangeM5: optNum(env, 'MIN_CHANGE_M5'),
      minChangeH1: optNum(env, 'MIN_CHANGE_H1'),
      maxChangeH1: optNum(env, 'MAX_CHANGE_H1'),
      minChangeH24: optNum(env, 'MIN_CHANGE_H24'),
      rankBy: rankBy as RankBy,
    },
    exits: {
      takeProfitPct: num(env, 'TAKE_PROFIT_PCT', 25),
      stopLossPct: num(env, 'STOP_LOSS_PCT', 10),
      trailingStopPct: num(env, 'TRAILING_STOP_PCT', 8),
      trailingActivationPct: num(env, 'TRAILING_ACTIVATION_PCT', 5),
      maxHoldHours: num(env, 'MAX_HOLD_HOURS', 48),
    },
    sizing: {
      startingCapitalUsd: num(env, 'STARTING_CAPITAL_USD', 1_000),
      maxUsdPerTrade: num(env, 'MAX_USD_PER_TRADE', 50),
      maxPositionPct: num(env, 'MAX_POSITION_PCT', 0.1),
      maxConcurrentPositions: num(env, 'MAX_CONCURRENT_POSITIONS', 5),
      minTradeUsd: num(env, 'MIN_TRADE_USD', 5),
    },
    paperSlippageBps: num(env, 'PAPER_SLIPPAGE_BPS', 100),
    paperFeeBps: num(env, 'PAPER_FEE_BPS', 30),
    liveSlippageBps: num(env, 'LIVE_SLIPPAGE_BPS', 100),
    killClosesPositions: flag(env, 'KILL_CLOSES_POSITIONS', false),
    useClaudeGate: flag(env, 'USE_CLAUDE_GATE', true),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    solanaPrivateKey: env.SOLANA_PRIVATE_KEY || undefined,
    solanaRpcUrl: env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    minSolBalance: num(env, 'MIN_SOL_BALANCE', 0.05),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
  };
  assertConfig(cfg);
  return cfg;
}

export function assertConfig(cfg: AppConfig): void {
  const positive: Array<[string, number]> = [
    ['STARTING_CAPITAL_USD', cfg.sizing.startingCapitalUsd],
    ['MAX_USD_PER_TRADE', cfg.sizing.maxUsdPerTrade],
    ['MAX_POSITION_PCT', cfg.sizing.maxPositionPct],
    ['POLL_INTERVAL_MS', cfg.pollIntervalMs],
    ['STOP_LOSS_PCT', cfg.exits.stopLossPct],
    ['TAKE_PROFIT_PCT', cfg.exits.takeProfitPct],
  ];
  for (const [key, value] of positive) {
    if (!(value > 0)) throw new Error(`${key} must be positive`);
  }
  if (cfg.sizing.maxPositionPct > 1) throw new Error('MAX_POSITION_PCT is a fraction (0..1)');
  if (cfg.exits.stopLossPct >= 100) throw new Error('STOP_LOSS_PCT must be < 100');
  if (cfg.mode === 'live' && !cfg.solanaPrivateKey) {
    throw new Error('Live mode is confirmed but SOLANA_PRIVATE_KEY is not set');
  }
}
