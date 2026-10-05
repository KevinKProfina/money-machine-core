import type { OrchestratorConfig } from '../config.js';
import type { AllocationProposal, RevenueReport, StrategyReport } from '../mm-contract.js';

export const NOW = new Date('2026-06-01T12:00:00.000Z');

export function makeReport(overrides: Partial<StrategyReport> = {}): StrategyReport {
  return {
    schema: 'mm.strategy-report/v1',
    name: 'strat',
    kind: 'trading',
    mode: 'paper',
    status: 'active',
    capitalUsd: 500,
    deployedUsd: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalReturn: 0.05,
    winRate: 0.6,
    avgProfit: 0.01,
    maxDrawdown: 0.05,
    sharpeRatio: 1,
    totalTrades: 30,
    openPositions: 0,
    lastUpdated: NOW.toISOString(),
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    baseCapitalUsd: 1000,
    riskProfile: 'moderate',
    maxPortfolioDrawdown: 0.25,
    maxStrategyExposure: 0.5,
    minHealthScore: 50,
    staleReportMs: 3_600_000,
    reservePct: 0.1,
    maxRebalanceStepPct: 0.1,
    reinvestmentPercent: 0.5,
    strategyDrawdownReduce: 0.15,
    strategyDrawdownPause: 0.35,
    pollIntervalMs: 60_000,
    ...overrides,
  };
}

export function makeProposal(allocations: Record<string, number>, total = 1000, overrides: Partial<AllocationProposal> = {}): AllocationProposal {
  return {
    schema: 'mm.allocation-proposal/v1',
    timestamp: NOW.toISOString(),
    totalCapitalUsd: total,
    riskProfile: 'moderate',
    allocations,
    scores: Object.fromEntries(Object.keys(allocations).map((n) => [n, { score: 60, riskGateAllowed: true, reasons: [] }])),
    ...overrides,
  };
}

export function makeRevenue(streams: RevenueReport['streams']): RevenueReport {
  const totalUsd = Object.values(streams).reduce((s, x) => s + x.totalUsd, 0);
  return { schema: 'mm.revenue/v1', timestamp: NOW.toISOString(), totalUsd, last7dUsd: 0, last30dUsd: 0, streams, concentration: 1 };
}
