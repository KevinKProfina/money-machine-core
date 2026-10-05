import type { EquityPoint, Position } from './positions.js';

export type Metrics = {
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  deployedUsd: number;
  totalReturn: number;
  winRate: number;
  avgProfit: number;
  maxDrawdown: number;
  sharpeRatio: number;
  totalTrades: number;
  openPositions: number;
};

const round = (x: number, digits = 6) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

/** Mark-to-market value of an open position minus its cost basis (fees on exit not included). */
export function unrealizedPnl(position: Position): number {
  return position.quantity * position.lastPriceUsd - position.sizeUsd;
}

/** Max peak-to-trough drawdown of an equity series as a fraction 0..1. */
export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    if (peak > 0) worst = Math.max(worst, (peak - value) / peak);
  }
  return worst;
}

/** mean / sample stdev of per-trade returns; 0 with fewer than 2 trades or zero variance. */
export function sharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? mean / sd : 0;
}

export function computeMetrics(positions: Position[], equityCurve: EquityPoint[], startingCapitalUsd: number): Metrics {
  const closed = positions.filter((p) => p.status === 'closed');
  const open = positions.filter((p) => p.status === 'open');
  const realized = closed.reduce((sum, p) => sum + (p.realizedPnlUsd ?? 0), 0);
  const unrealized = open.reduce((sum, p) => sum + unrealizedPnl(p), 0);
  const returns = closed.map((p) => p.returnPct ?? 0);
  const wins = returns.filter((r) => r > 0).length;
  return {
    realizedPnlUsd: round(realized, 2),
    unrealizedPnlUsd: round(unrealized, 2),
    deployedUsd: round(open.reduce((sum, p) => sum + p.sizeUsd, 0), 2),
    totalReturn: startingCapitalUsd > 0 ? round((realized + unrealized) / startingCapitalUsd) : 0,
    winRate: closed.length ? round(wins / closed.length) : 0,
    avgProfit: returns.length ? round(returns.reduce((a, b) => a + b, 0) / returns.length) : 0,
    maxDrawdown: round(maxDrawdown(equityCurve.map((p) => p.equityUsd))),
    sharpeRatio: round(sharpe(returns), 4),
    totalTrades: closed.length,
    openPositions: open.length,
  };
}
