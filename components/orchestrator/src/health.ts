import type { OrchestratorConfig } from './config.js';
import type { StrategyReport } from './mm-contract.js';

/**
 * Governance view of a strategy. This is deliberately NOT a performance score
 * (that is capital-allocator's job): it answers "is it safe to keep funding this?".
 */
export type HealthAssessment = {
  name: string;
  health: number;
  paused: boolean;
  /** Multiplier 0..1 applied to the strategy's target because of its drawdown. */
  exposureFactor: number;
  stale: boolean;
  reasons: string[];
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** 0..100: penalises drawdown, losses, poor win rate (with enough trades) and stale data. */
export function computeHealthScore(r: StrategyReport, ageMs: number, staleReportMs: number): number {
  let h = 100;
  h -= 150 * clamp(r.maxDrawdown, 0, 1); // 20 % dd -> -30
  if (r.totalReturn < 0) h -= Math.min(40, 200 * -r.totalReturn); // -10 % -> -20
  if (r.totalTrades >= 10 && r.winRate < 0.4) h -= 15;
  if (r.totalTrades >= 10 && r.sharpeRatio < 0) h -= 10;
  if (ageMs > staleReportMs / 2) h -= 10; // getting old
  if (r.status === 'failed') h = 0;
  return clamp(h, 0, 100);
}

export function assessStrategy(r: StrategyReport, config: OrchestratorConfig, now: Date): HealthAssessment {
  const reasons: string[] = [];
  const metricsOk = ['totalReturn', 'winRate', 'sharpeRatio', 'maxDrawdown', 'totalTrades'].every((k) =>
    finite((r as Record<string, unknown>)[k]),
  );
  const updated = Date.parse(r.lastUpdated);
  const ageMs = Number.isFinite(updated) ? now.getTime() - updated : Number.POSITIVE_INFINITY;
  const stale = ageMs > config.staleReportMs;

  if (!metricsOk) {
    return { name: r.name, health: 0, paused: true, exposureFactor: 0, stale, reasons: ['paused: invalid metrics in report'] };
  }

  const health = computeHealthScore(r, ageMs, config.staleReportMs);
  let paused = false;
  if (r.status === 'failed') {
    paused = true;
    reasons.push('paused: strategy status failed');
  }
  if (stale) {
    paused = true;
    reasons.push(
      Number.isFinite(ageMs)
        ? `paused: report stale (${Math.round(ageMs / 60_000)} min old > ${Math.round(config.staleReportMs / 60_000)} min)`
        : 'paused: report has no valid lastUpdated',
    );
  }
  if (health < config.minHealthScore) {
    paused = true;
    reasons.push(`paused: health ${health.toFixed(0)} < ${config.minHealthScore}`);
  }
  if (r.maxDrawdown >= config.strategyDrawdownPause) {
    paused = true;
    reasons.push(`paused: drawdown ${pct(r.maxDrawdown)} >= ${pct(config.strategyDrawdownPause)}`);
  }

  let exposureFactor = 1;
  if (!paused && r.maxDrawdown > config.strategyDrawdownReduce) {
    exposureFactor = clamp(
      1 - (r.maxDrawdown - config.strategyDrawdownReduce) / (config.strategyDrawdownPause - config.strategyDrawdownReduce),
      0,
      1,
    );
    reasons.push(`exposure x${exposureFactor.toFixed(2)} (drawdown ${pct(r.maxDrawdown)})`);
  }
  if (paused) exposureFactor = 0;
  if (!paused) reasons.push(`healthy (${health.toFixed(0)})`);
  return { name: r.name, health, paused, exposureFactor, stale, reasons };
}
