import type { RiskProfile } from './mm-contract.js';

export const RISK_PROFILES: readonly RiskProfile[] = ['conservative', 'moderate', 'aggressive'];

export class ConfigError extends Error {}

/** Per-profile scoring weights and risk-gate limits. */
export type ProfileSettings = {
  /** Default per-strategy cap as a share of total capital (overridable via MAX_STRATEGY_SHARE). */
  maxStrategyShare: number;
  /** Reject strategies whose max drawdown exceeds this fraction. */
  maxDrawdown: number;
  /** Reject strategies (with enough trades) whose total return is below this fraction. */
  minTotalReturn: number;
  /** Reject strategies (with enough trades) whose adjusted score is below this (0..100). */
  minScore: number;
  /** Component weights, sum = 1. */
  weights: { return: number; winRate: number; sharpe: number; drawdown: number };
};

export const PROFILE_SETTINGS: Record<RiskProfile, ProfileSettings> = {
  conservative: {
    maxStrategyShare: 0.35,
    maxDrawdown: 0.2,
    minTotalReturn: -0.1,
    minScore: 52,
    weights: { return: 0.2, winRate: 0.2, sharpe: 0.25, drawdown: 0.35 },
  },
  moderate: {
    maxStrategyShare: 0.5,
    maxDrawdown: 0.3,
    minTotalReturn: -0.2,
    minScore: 45,
    weights: { return: 0.3, winRate: 0.2, sharpe: 0.25, drawdown: 0.25 },
  },
  aggressive: {
    maxStrategyShare: 0.7,
    maxDrawdown: 0.45,
    minTotalReturn: -0.35,
    minScore: 40,
    weights: { return: 0.4, winRate: 0.15, sharpe: 0.25, drawdown: 0.2 },
  },
};

export type AllocatorConfig = {
  totalCapitalUsd: number;
  riskProfile: RiskProfile;
  /** Minimum USD for every strategy that passes the risk gate. */
  minStrategyCapitalUsd: number;
  /** Per-strategy cap as a fraction of total capital. */
  maxStrategyShare: number;
  /** Fraction of total capital reserved for strategies with too little data (0 = disabled). */
  explorationShare: number;
  /** Strategies with fewer closed trades than this are "low data". */
  minTradesForConfidence: number;
  /** Strength of the neutral prior, in pseudo-trades (confidence = n / (n + priorTrades)). */
  priorTrades: number;
  /** Score multiplier for strategies whose report notes contain `synthetic-market-data`. */
  syntheticDataWeight: number;
  intervalMs: number;
};

/** Cap for synthetic-market-data strategies when EXPLORATION_SHARE is 0. */
export const DEFAULT_SYNTHETIC_MAX_SHARE = 0.1;

/** Synthetic-data strategies are capped at the exploration share (or 10 % when exploration is off). */
export function syntheticMaxShare(c: Pick<AllocatorConfig, 'explorationShare'>): number {
  return c.explorationShare > 0 ? c.explorationShare : DEFAULT_SYNTHETIC_MAX_SHARE;
}

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

export function readConfig(env: Env = process.env): AllocatorConfig {
  const riskProfile = parseRiskProfile(env.RISK_PROFILE);
  const profile = PROFILE_SETTINGS[riskProfile];
  const config: AllocatorConfig = {
    totalCapitalUsd: readNumber(env, 'TOTAL_CAPITAL', 1000, 0, 1e12),
    riskProfile,
    minStrategyCapitalUsd: readNumber(env, 'MIN_STRATEGY_CAPITAL', 10, 0, 1e12),
    maxStrategyShare: readNumber(env, 'MAX_STRATEGY_SHARE', profile.maxStrategyShare, 0.01, 1),
    explorationShare: readNumber(env, 'EXPLORATION_SHARE', 0, 0, 0.5),
    minTradesForConfidence: readNumber(env, 'MIN_TRADES_FOR_CONFIDENCE', 10, 0, 1e6),
    priorTrades: readNumber(env, 'PRIOR_TRADES', 20, 0, 1e6),
    syntheticDataWeight: readNumber(env, 'SYNTHETIC_DATA_WEIGHT', 0.25, 0, 1),
    intervalMs: readNumber(env, 'ALLOCATION_INTERVAL_MS', 3_600_000, 1_000, 7 * 86_400_000),
  };
  return config;
}
