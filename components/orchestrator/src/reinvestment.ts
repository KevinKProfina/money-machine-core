import type { RevenueReport, RevenueStreamKind, StrategyReport } from './mm-contract.js';

/**
 * Revenue-engine also reports strategy PnL as `trading` / `liquidation` streams.
 * Those are already counted via strategy realizedPnlUsd, so they are excluded here.
 */
export const STRATEGY_REVENUE_KINDS: readonly RevenueStreamKind[] = ['trading', 'liquidation'];

export type ProfitDelta = {
  tradingDeltaUsd: number;
  nonTradingDeltaUsd: number;
  /** Delta from live strategies and non-simulated revenue streams. */
  realDeltaUsd: number;
  /** Delta from paper/dry-run strategies and simulated revenue streams. */
  simulatedDeltaUsd: number;
  deltaUsd: number;
  nextRealizedByStrategy: Record<string, number>;
  nextRevenueByStream: Record<string, number>;
  /** Current cumulative totals of the counted non-trading streams. */
  countedRevenueTotalUsd: number;
  notes: string[];
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Realized profit since the last cycle, split into real and simulated.
 * - Strategies: delta of realizedPnlUsd vs. the last observed value, tracked per strategy *and mode*
 *   (key `name:mode`) so a paper→live switch never mixes simulated and real counters. On first
 *   sighting, existing losses are booked (conservative: the drawdown guard must see them) while
 *   existing profits only set the baseline. Negative deltas are losses.
 *   PnL is real only when the report's mode is 'live'.
 * - Revenue: delta of totalUsd for non-trading streams; simulated streams go to the simulated bucket.
 *   First sighting = baseline; a decrease is treated as a counter reset (ignored, baseline lowered).
 */
export function computeProfitDelta(
  reports: StrategyReport[],
  revenue: RevenueReport | null,
  lastRealized: Record<string, number>,
  lastRevenue: Record<string, number>,
): ProfitDelta {
  const notes: string[] = [];
  const nextRealized = { ...lastRealized };
  let tradingDelta = 0;
  let realDelta = 0;
  let simDelta = 0;
  for (const r of reports) {
    if (!finite(r.realizedPnlUsd)) continue;
    const key = `${r.name}:${r.mode}`;
    const prev = lastRealized[key];
    let d = 0;
    if (prev === undefined) {
      if (r.realizedPnlUsd < 0) {
        d = r.realizedPnlUsd;
        notes.push(`${key}: first sighting with realized loss $${r.realizedPnlUsd.toFixed(2)} — booked`);
      } else {
        notes.push(`${key}: baseline realized PnL $${r.realizedPnlUsd.toFixed(2)}`);
      }
    } else {
      d = r.realizedPnlUsd - prev;
    }
    tradingDelta += d;
    if (r.mode === 'live') realDelta += d;
    else simDelta += d;
    nextRealized[key] = r.realizedPnlUsd;
  }

  const nextRevenue = { ...lastRevenue };
  let nonTradingDelta = 0;
  let countedTotal = 0;
  if (revenue && revenue.schema === 'mm.revenue/v1' && revenue.streams) {
    for (const [id, s] of Object.entries(revenue.streams)) {
      if (!s || !finite(s.totalUsd)) continue;
      if (STRATEGY_REVENUE_KINDS.includes(s.kind)) continue;
      countedTotal += s.totalUsd;
      const prev = lastRevenue[id];
      if (prev === undefined) notes.push(`revenue ${id}: baseline $${s.totalUsd.toFixed(2)}`);
      else if (s.totalUsd >= prev) {
        const d = s.totalUsd - prev;
        nonTradingDelta += d;
        if (s.simulated === false) realDelta += d;
        else simDelta += d; // anything not explicitly real is treated as simulated
      } else notes.push(`revenue ${id}: total decreased (reset?) — ignored`);
      nextRevenue[id] = s.totalUsd;
    }
  }

  return {
    tradingDeltaUsd: tradingDelta,
    nonTradingDeltaUsd: nonTradingDelta,
    realDeltaUsd: realDelta,
    simulatedDeltaUsd: simDelta,
    deltaUsd: realDelta + simDelta,
    nextRealizedByStrategy: nextRealized,
    nextRevenueByStream: nextRevenue,
    countedRevenueTotalUsd: countedTotal,
    notes,
  };
}

export type Ledger = { reinvestedUsd: number; retainedProfitUsd: number; lossCarryforwardUsd: number };

/**
 * Books a realized profit delta.
 * Losses accumulate in lossCarryforward (reducing capital). Profits first repay the carryforward;
 * of the remainder, `reinvestmentPercent` is added to capital when `allowReinvest`, the rest is retained.
 */
export function applyProfitDelta(
  ledger: Ledger,
  deltaUsd: number,
  reinvestmentPercent: number,
  allowReinvest: boolean,
): Ledger & { reinvestedNowUsd: number; retainedNowUsd: number } {
  let { reinvestedUsd, retainedProfitUsd, lossCarryforwardUsd } = ledger;
  let reinvestedNowUsd = 0;
  let retainedNowUsd = 0;
  if (deltaUsd < 0) {
    lossCarryforwardUsd += -deltaUsd;
  } else if (deltaUsd > 0) {
    const repay = Math.min(lossCarryforwardUsd, deltaUsd);
    lossCarryforwardUsd -= repay;
    const net = deltaUsd - repay;
    reinvestedNowUsd = allowReinvest ? net * reinvestmentPercent : 0;
    retainedNowUsd = net - reinvestedNowUsd;
    reinvestedUsd += reinvestedNowUsd;
    retainedProfitUsd += retainedNowUsd;
  }
  return { reinvestedUsd, retainedProfitUsd, lossCarryforwardUsd, reinvestedNowUsd, retainedNowUsd };
}

export const emptyLedger = (): Ledger => ({ reinvestedUsd: 0, retainedProfitUsd: 0, lossCarryforwardUsd: 0 });

/** Net capital contribution of a ledger: reinvested profits minus unrecovered losses. */
const capitalContribution = (l: Ledger) => l.reinvestedUsd - l.lossCarryforwardUsd;
/** Net booked result of a ledger (reinvested + retained - losses). */
const bookedResult = (l: Ledger) => l.reinvestedUsd + l.retainedProfitUsd - l.lossCarryforwardUsd;

/**
 * Capital available to allocate: base + real reinvested profit - real unrecovered losses,
 * plus the simulated ledger only while no strategy runs live (simulated profit must never
 * fund live strategies).
 */
export function totalCapital(baseCapitalUsd: number, real: Ledger, simulated: Ledger, anyLive: boolean): number {
  return Math.max(0, baseCapitalUsd + capitalContribution(real) + (anyLive ? 0 : capitalContribution(simulated)));
}

/** Portfolio equity on the same basis as totalCapital (real-only once anything is live). */
export function portfolioEquity(
  baseCapitalUsd: number,
  real: Ledger,
  simulated: Ledger,
  anyLive: boolean,
  unrealizedUsd: number,
): number {
  return baseCapitalUsd + bookedResult(real) + (anyLive ? 0 : bookedResult(simulated)) + unrealizedUsd;
}
