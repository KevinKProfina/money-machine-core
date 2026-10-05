import type { StrategyReport } from '../mm-contract.js';
import type { AllocatorConfig } from '../config.js';

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
    totalReturn: 0.1,
    winRate: 0.6,
    avgProfit: 0.02,
    maxDrawdown: 0.08,
    sharpeRatio: 1.2,
    totalTrades: 50,
    openPositions: 0,
    lastUpdated: new Date().toISOString(),
    ...overrides,
  };
}

export function makeConfig(overrides: Partial<AllocatorConfig> = {}): AllocatorConfig {
  return {
    totalCapitalUsd: 1000,
    riskProfile: 'moderate',
    minStrategyCapitalUsd: 10,
    maxStrategyShare: 0.5,
    explorationShare: 0,
    minTradesForConfidence: 10,
    priorTrades: 20,
    syntheticDataWeight: 0.25,
    intervalMs: 60_000,
    ...overrides,
  };
}
