import type { RiskProfile } from './mm-contract.js';

export const RISK_PROFILES: readonly RiskProfile[] = ['conservative', 'moderate', 'aggressive'];

export class ConfigError extends Error {}

export type OrchestratorConfig = {
  /** Base capital (USD) before reinvested profits. */
  baseCapitalUsd: number;
  riskProfile: RiskProfile;
  /** Portfolio drawdown (fraction) from the equity high-water mark that trips the kill switch. */
  maxPortfolioDrawdown: number;
  /** Max share of total capital per strategy. */
  maxStrategyExposure: number;
  /** Strategies with health below this (0..100) are paused. */
  minHealthScore: number;
  /** Reports whose lastUpdated is older than this are treated as stale -> paused. */
  staleReportMs: number;
  /** Fraction of total capital always kept unallocated. */
  reservePct: number;
  /** Max change per strategy per cycle, as a fraction of total capital. */
  maxRebalanceStepPct: number;
  /** Fraction of positive realized profit added to total capital. */
  reinvestmentPercent: number;
  /** Strategy drawdown at which its exposure starts being reduced. */
  strategyDrawdownReduce: number;
  /** Strategy drawdown at which it is paused. */
  strategyDrawdownPause: number;
  pollIntervalMs: number;
};

type Env = Record<string, string | undefined>;

export function parseRiskProfile(value: string | undefined): RiskProfile {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return 'moderate';
  if ((RISK_PROFILES as readonly string[]).includes(v)) return v as RiskProfile;
  throw new ConfigError(`RISK_PROFILE must be one of ${RISK_PROFILES.join('|')}, got "${value}"`);
}

function readNumber(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be a number in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

/**
 * Fractions: accepts 0..1, or 1 < v <= 100 interpreted as a percentage (e.g. "10" = 0.10).
 */
function readFraction(env: Env, key: string, fallback: number, min = 0, max = 1): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  let n = Number(raw);
  if (Number.isFinite(n) && n > 1 && n <= 100) n /= 100;
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be a fraction in [${min}, ${max}] (or a percentage), got "${raw}"`);
  }
  return n;
}

export function readConfig(env: Env = process.env): OrchestratorConfig {
  const config: OrchestratorConfig = {
    baseCapitalUsd: readNumber(env, 'TOTAL_CAPITAL', 1000, 0, 1e12),
    riskProfile: parseRiskProfile(env.RISK_PROFILE),
    maxPortfolioDrawdown: readFraction(env, 'MAX_PORTFOLIO_DRAWDOWN', 0.25, 0.01, 1),
    maxStrategyExposure: readFraction(env, 'MAX_STRATEGY_EXPOSURE', 0.5, 0.01, 1),
    minHealthScore: readNumber(env, 'MIN_HEALTH_SCORE', 50, 0, 100),
    staleReportMs: readNumber(env, 'STALE_REPORT_MS', 6 * 3_600_000, 1_000, 30 * 86_400_000),
    reservePct: readFraction(env, 'RESERVE_PCT', 0.1, 0, 0.95),
    maxRebalanceStepPct: readFraction(env, 'MAX_REBALANCE_STEP_PCT', 0.1, 0.001, 1),
    reinvestmentPercent: readFraction(env, 'REINVESTMENT_PERCENT', 0.5, 0, 1),
    strategyDrawdownReduce: readFraction(env, 'STRATEGY_DRAWDOWN_REDUCE', 0.15, 0, 1),
    strategyDrawdownPause: readFraction(env, 'STRATEGY_DRAWDOWN_PAUSE', 0.35, 0.01, 1),
    pollIntervalMs: readNumber(env, 'POLL_INTERVAL_MS', 300_000, 1_000, 7 * 86_400_000),
  };
  if (config.strategyDrawdownReduce >= config.strategyDrawdownPause) {
    throw new ConfigError('STRATEGY_DRAWDOWN_REDUCE must be lower than STRATEGY_DRAWDOWN_PAUSE');
  }
  return config;
}
