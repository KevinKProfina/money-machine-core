import { PROFILE_SETTINGS, syntheticMaxShare, type AllocatorConfig } from './config.js';
import type { RiskProfile, StrategyReport } from './mm-contract.js';

/** Score assigned to a strategy we know nothing about. Low-sample scores shrink toward it. */
export const NEUTRAL_SCORE = 50;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export type ScoreComponents = { return: number; winRate: number; sharpe: number; drawdown: number };

export type StrategyScore = {
  name: string;
  /** Raw performance score, 0..100, before sample-size shrinkage. */
  rawScore: number;
  /** n / (n + priorTrades), 0..1. */
  confidence: number;
  /** Score after shrinking toward NEUTRAL_SCORE by confidence, 0..100. Used by the risk gate. */
  adjustedScore: number;
  /** adjustedScore x SYNTHETIC_DATA_WEIGHT for synthetic-data strategies; the allocation weight. */
  allocationWeight: number;
  /** Report notes contain `synthetic-market-data`. */
  syntheticData: boolean;
  components: ScoreComponents;
  /** True when totalTrades < minTradesForConfidence. */
  lowData: boolean;
  riskGateAllowed: boolean;
  reasons: string[];
};

export const SYNTHETIC_DATA_NOTE = 'synthetic-market-data';

export function isSyntheticData(r: StrategyReport): boolean {
  return Array.isArray(r.notes) && r.notes.some((n) => typeof n === 'string' && n.includes(SYNTHETIC_DATA_NOTE));
}

const METRIC_KEYS = ['totalReturn', 'winRate', 'sharpeRatio', 'maxDrawdown', 'totalTrades'] as const;

export function hasValidMetrics(r: StrategyReport): boolean {
  return METRIC_KEYS.every((k) => typeof r[k] === 'number' && Number.isFinite(r[k])) && r.totalTrades >= 0;
}

/** Each component mapped to 0..1 (higher is better). */
export function scoreComponents(r: StrategyReport): ScoreComponents {
  return {
    // +20 % return -> ~0.88, 0 % -> 0.5, -20 % -> ~0.12
    return: 0.5 + 0.5 * Math.tanh(r.totalReturn / 0.2),
    winRate: clamp(r.winRate, 0, 1),
    // Sharpe 1.5 -> ~0.88, 0 -> 0.5
    sharpe: 0.5 + 0.5 * Math.tanh(r.sharpeRatio / 1.5),
    // 0 % drawdown -> 1, 50 %+ -> 0
    drawdown: 1 - clamp(r.maxDrawdown / 0.5, 0, 1),
  };
}

export function rawScore(c: ScoreComponents, profile: RiskProfile): number {
  const w = PROFILE_SETTINGS[profile].weights;
  return 100 * (w.return * c.return + w.winRate * c.winRate + w.sharpe * c.sharpe + w.drawdown * c.drawdown);
}

/** Bayesian-style shrinkage: few trades -> score stays near the neutral prior. */
export function shrinkToPrior(raw: number, totalTrades: number, priorTrades: number): { confidence: number; adjusted: number } {
  const n = Math.max(0, totalTrades);
  const confidence = n + priorTrades === 0 ? 1 : n / (n + priorTrades);
  return { confidence, adjusted: NEUTRAL_SCORE + confidence * (raw - NEUTRAL_SCORE) };
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function scoreStrategy(r: StrategyReport, config: AllocatorConfig): StrategyScore {
  const profile = PROFILE_SETTINGS[config.riskProfile];
  const reasons: string[] = [];

  if (!hasValidMetrics(r)) {
    return {
      name: r.name,
      rawScore: 0,
      confidence: 0,
      adjustedScore: 0,
      allocationWeight: 0,
      syntheticData: isSyntheticData(r),
      components: { return: 0, winRate: 0, sharpe: 0, drawdown: 0 },
      lowData: true,
      riskGateAllowed: false,
      reasons: ['rejected: report has missing or non-finite metrics'],
    };
  }

  const components = scoreComponents(r);
  const raw = rawScore(components, config.riskProfile);
  const { confidence, adjusted } = shrinkToPrior(raw, r.totalTrades, config.priorTrades);
  const lowData = r.totalTrades < config.minTradesForConfidence;
  reasons.push(
    `raw ${raw.toFixed(1)} (return ${pct(r.totalReturn)}, win ${pct(r.winRate)}, sharpe ${r.sharpeRatio.toFixed(2)}, dd ${pct(r.maxDrawdown)})`,
    `${r.totalTrades} trades -> confidence ${confidence.toFixed(2)}, adjusted ${adjusted.toFixed(1)}`,
  );
  if (lowData) reasons.push(`low data (< ${config.minTradesForConfidence} trades)`);

  // ---- risk gate ----
  const rejections: string[] = [];
  if (r.status === 'failed') rejections.push('strategy status is failed');
  if (r.maxDrawdown > profile.maxDrawdown) {
    rejections.push(`max drawdown ${pct(r.maxDrawdown)} > ${pct(profile.maxDrawdown)} limit (${config.riskProfile})`);
  }
  if (r.totalReturn < profile.minTotalReturn) {
    rejections.push(`total return ${pct(r.totalReturn)} < ${pct(profile.minTotalReturn)} floor (${config.riskProfile})`);
  }
  // The score threshold is only meaningful with enough data; low-data strategies are only
  // exempt when an exploration budget exists to fund them separately.
  const scoreGateApplies = !lowData || config.explorationShare === 0;
  if (scoreGateApplies && adjusted < profile.minScore) {
    rejections.push(`adjusted score ${adjusted.toFixed(1)} < ${profile.minScore} minimum (${config.riskProfile})`);
  }
  if (r.status === 'paused') reasons.push('strategy reports paused (orchestrator decides)');

  for (const rej of rejections) reasons.push(`rejected: ${rej}`);

  // Synthetic market data says nothing about real performance: discount the allocation weight
  // so such strategies cannot out-compete strategies on real data (the cap is applied in allocate()).
  const syntheticData = isSyntheticData(r);
  const allocationWeight = syntheticData ? adjusted * config.syntheticDataWeight : adjusted;
  if (syntheticData) {
    reasons.push(
      `synthetic market data: score x${config.syntheticDataWeight} -> ${allocationWeight.toFixed(1)}, capped at ${(syntheticMaxShare(config) * 100).toFixed(0)}% of capital`,
    );
  }

  return {
    name: r.name,
    rawScore: raw,
    confidence,
    adjustedScore: adjusted,
    allocationWeight,
    syntheticData,
    components,
    lowData,
    riskGateAllowed: rejections.length === 0,
    reasons,
  };
}
