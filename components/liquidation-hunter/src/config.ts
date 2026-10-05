import type { RunMode } from './mm-contract.js';

export const STRATEGY_NAME = 'liquidation-hunter';
export const LIVE_CONFIRM_PHRASE = 'I_UNDERSTAND_REAL_MONEY_RISK';

export type SourceId = 'simulated' | 'kamino' | 'marginfi' | 'save' | 'aave-v3';

export type Config = {
  mode: RunMode;
  liveConfirmed: boolean;
  source: SourceId;
  simSeed: number;
  simPositionsPerCycle: number;
  intervalMs: number;
  startingCapitalUsd: number;
  minNetProfitUsd: number;
  maxLiquidationSizeUsd: number;
  maxGasShare: number;
  maxRiskScore: number;
  maxExecutionsPerCycle: number;
  collateralSlippageBps: number;
  useFlashLoan: boolean;
  flashLoanFeeBps: number;
  paperBaseWinProbability: number;
  competitionRefUsd: number;
  competitionSizeRefUsd: number;
  paperTxFailureProbability: number;
  paperRevertGasFraction: number;
  paperMaxAdverseSlippageBps: number;
  paperMaxGasSpikeMultiplier: number;
  paperPriceMoveHorizonSec: number;
  paperAdverseSelectionFraction: number;
  paperTailLossProbability: number;
  paperTailLossMin: number;
  paperTailLossMax: number;
  anthropicApiKey?: string;
  claudeGateEnabled: boolean;
  telegramBotToken?: string;
  telegramChatId?: string;
};

export class ConfigError extends Error {}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number, got "${raw}"`);
  if (opts.min !== undefined && n < opts.min) throw new ConfigError(`${key} must be >= ${opts.min}, got ${n}`);
  if (opts.max !== undefined && n > opts.max) throw new ConfigError(`${key} must be <= ${opts.max}, got ${n}`);
  return n;
}

function str(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

/** Reads configuration from the given env (read at call time, never at import time). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const modeRaw = (str(env, 'MODE') ?? 'paper').toLowerCase();
  if (modeRaw !== 'paper' && modeRaw !== 'dry-run' && modeRaw !== 'live') {
    throw new ConfigError(`MODE must be one of paper | dry-run | live, got "${modeRaw}"`);
  }
  const sourceRaw = (str(env, 'OPPORTUNITY_SOURCE') ?? 'simulated').toLowerCase();
  const sources: SourceId[] = ['simulated', 'kamino', 'marginfi', 'save', 'aave-v3'];
  if (!sources.includes(sourceRaw as SourceId)) {
    throw new ConfigError(`OPPORTUNITY_SOURCE must be one of ${sources.join(' | ')}, got "${sourceRaw}"`);
  }
  const anthropicApiKey = str(env, 'ANTHROPIC_API_KEY');
  return {
    mode: modeRaw,
    liveConfirmed: env.LIVE_TRADING_CONFIRM === LIVE_CONFIRM_PHRASE,
    source: sourceRaw as SourceId,
    simSeed: num(env, 'SIM_SEED', 42),
    simPositionsPerCycle: num(env, 'SIM_POSITIONS_PER_CYCLE', 12, { min: 0, max: 1000 }),
    intervalMs: num(env, 'LIQUIDATION_INTERVAL_MS', 60_000, { min: 1000 }),
    startingCapitalUsd: num(env, 'STARTING_CAPITAL_USD', 1000, { min: 0 }),
    minNetProfitUsd: num(env, 'MIN_LIQUIDATION_PROFIT_USD', 10, { min: 0 }),
    maxLiquidationSizeUsd: num(env, 'MAX_LIQUIDATION_SIZE_USD', 200, { min: 0 }),
    maxGasShare: num(env, 'MAX_GAS_SHARE', 0.3, { min: 0, max: 1 }),
    maxRiskScore: num(env, 'MAX_RISK_SCORE', 60, { min: 0, max: 100 }),
    maxExecutionsPerCycle: num(env, 'MAX_EXECUTIONS_PER_CYCLE', 3, { min: 0 }),
    collateralSlippageBps: num(env, 'COLLATERAL_SLIPPAGE_BPS', 30, { min: 0, max: 10_000 }),
    useFlashLoan: env.USE_FLASH_LOAN === 'true',
    flashLoanFeeBps: num(env, 'FLASH_LOAN_FEE_BPS', 5, { min: 0, max: 10_000 }),
    paperBaseWinProbability: num(env, 'PAPER_BASE_WIN_PROBABILITY', 0.4, { min: 0, max: 1 }),
    competitionRefUsd: num(env, 'COMPETITION_REF_USD', 50, { min: 0.01 }),
    competitionSizeRefUsd: num(env, 'COMPETITION_SIZE_REF_USD', 20_000, { min: 1 }),
    paperTxFailureProbability: num(env, 'PAPER_TX_FAILURE_PROBABILITY', 0.1, { min: 0, max: 1 }),
    paperRevertGasFraction: num(env, 'PAPER_REVERT_GAS_FRACTION', 0.3, { min: 0, max: 1 }),
    paperMaxAdverseSlippageBps: num(env, 'PAPER_MAX_ADVERSE_SLIPPAGE_BPS', 150, { min: 0, max: 10_000 }),
    paperMaxGasSpikeMultiplier: num(env, 'PAPER_MAX_GAS_SPIKE_MULTIPLIER', 2, { min: 1 }),
    paperPriceMoveHorizonSec: num(env, 'PAPER_PRICE_MOVE_HORIZON_SEC', 900, { min: 0 }),
    paperAdverseSelectionFraction: num(env, 'PAPER_ADVERSE_SELECTION_FRACTION', 0.55, { min: 0 }),
    paperTailLossProbability: num(env, 'PAPER_TAIL_LOSS_PROBABILITY', 0.05, { min: 0, max: 1 }),
    paperTailLossMin: num(env, 'PAPER_TAIL_LOSS_MIN', 0.05, { min: 0, max: 1 }),
    paperTailLossMax: num(env, 'PAPER_TAIL_LOSS_MAX', 0.3, { min: 0, max: 1 }),
    anthropicApiKey,
    claudeGateEnabled: Boolean(anthropicApiKey) && env.CLAUDE_GATE !== 'off',
    telegramBotToken: str(env, 'TELEGRAM_BOT_TOKEN'),
    telegramChatId: str(env, 'TELEGRAM_CHAT_ID'),
  };
}

/**
 * Refuses configurations that cannot run safely. Live mode is refused outright
 * because no live executor or real opportunity source is implemented.
 */
export function assertRunnable(config: Config): void {
  if (config.mode === 'live') {
    const confirm = config.liveConfirmed
      ? ''
      : ` (and LIVE_TRADING_CONFIRM=${LIVE_CONFIRM_PHRASE} is not set)`;
    throw new ConfigError(
      `MODE=live is not supported: no live executor and no real opportunity source are implemented${confirm}. ` +
        'Use MODE=paper (simulated fills) or MODE=dry-run (decisions only).',
    );
  }
  if (config.source !== 'simulated') {
    throw new ConfigError(
      `OPPORTUNITY_SOURCE=${config.source} is a stub and not implemented yet. Only "simulated" is available.`,
    );
  }
}
