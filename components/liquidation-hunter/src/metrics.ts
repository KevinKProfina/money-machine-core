import type { RunMode, StrategyReport, StrategyStatus } from './mm-contract.js';
import { STRATEGY_NAME } from './config.js';
import { maxDrawdown, mean, sharpeRatio } from './math.js';
import type { ExecutionRecord } from './types.js';

export type ReportInput = {
  executions: ExecutionRecord[];
  mode: RunMode;
  status: StrategyStatus;
  capitalUsd: number;
  startingCapitalUsd: number;
  notes: string[];
  now?: Date;
};

export type ExecutionStats = {
  attempted: number;
  successful: number;
  profitable: number;
  realizedPnlUsd: number;
  returns: number[];
  equityCurve: number[];
};

/** Stats over attempted executions only. Skipped opportunities are never counted. */
export function executionStats(executions: ExecutionRecord[], startingCapitalUsd: number): ExecutionStats {
  const ordered = [...executions].sort((a, b) => a.ts.localeCompare(b.ts));
  const equityCurve = [startingCapitalUsd];
  let pnl = 0;
  for (const ex of ordered) {
    pnl += ex.realizedPnlUsd;
    equityCurve.push(startingCapitalUsd + pnl);
  }
  return {
    attempted: ordered.length,
    successful: ordered.filter((e) => e.status === 'success').length,
    profitable: ordered.filter((e) => e.realizedPnlUsd > 0).length,
    realizedPnlUsd: pnl,
    returns: ordered.filter((e) => e.repayUsd > 0).map((e) => e.realizedPnlUsd / e.repayUsd),
    equityCurve,
  };
}

export function buildReport(input: ReportInput): StrategyReport {
  const s = executionStats(input.executions, input.startingCapitalUsd);
  const ref = input.startingCapitalUsd > 0 ? input.startingCapitalUsd : 0;
  return {
    schema: 'mm.strategy-report/v1',
    name: STRATEGY_NAME,
    kind: 'liquidation',
    mode: input.mode,
    status: input.status,
    capitalUsd: round(input.capitalUsd),
    // Liquidations are atomic (repay + seize + sell in one cycle): nothing stays open.
    deployedUsd: 0,
    realizedPnlUsd: round(s.realizedPnlUsd),
    unrealizedPnlUsd: 0,
    totalReturn: ref > 0 ? s.realizedPnlUsd / ref : 0,
    // Contract: fraction of closed trades with positive PnL. A failed attempt pays
    // gas (negative PnL) and a filled one can still lose to slippage/gas.
    winRate: s.attempted > 0 ? s.profitable / s.attempted : 0,
    avgProfit: mean(s.returns),
    maxDrawdown: maxDrawdown(s.equityCurve),
    sharpeRatio: sharpeRatio(s.returns),
    totalTrades: s.attempted,
    openPositions: 0,
    lastUpdated: (input.now ?? new Date()).toISOString(),
    notes: [
      ...input.notes,
      `attempted=${s.attempted} filled=${s.successful} profitable=${s.profitable} (fillRate=${
        s.attempted > 0 ? ((s.successful / s.attempted) * 100).toFixed(1) : '0.0'
      } %)`,
    ],
  };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
