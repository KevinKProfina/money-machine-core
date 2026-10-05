import { readStrategyReports, type StrategyReport } from '../mm-contract.js';
import type { EngineState } from '../store.js';
import { type RevenueEvent, type RevenueSource, roundUsd, toIsoTimestamp } from '../types.js';

export type LastSeen = EngineState['tradingLastSeen'];

/**
 * Pure delta logic: realized PnL change per strategy since the last snapshot.
 * - Baseline key is `${name}:${mode}` so a paper→live switch starts a fresh baseline
 *   instead of booking a bogus jump between simulated and real numbers.
 * - A strategy seen for the first time contributes its full realized PnL.
 * - Decreases (realized losses) are recorded as negative events.
 * - Unrealized PnL is never counted as revenue.
 */
export function computeTradingDeltas(
  reports: StrategyReport[],
  lastSeen: LastSeen,
  now: Date = new Date(),
): { events: RevenueEvent[]; nextLastSeen: LastSeen } {
  const next: LastSeen = { ...lastSeen };
  const events: RevenueEvent[] = [];
  for (const r of reports) {
    if (!r || typeof r.name !== 'string' || !Number.isFinite(r.realizedPnlUsd)) continue;
    const key = `${r.name}:${r.mode}`;
    const prev = lastSeen[key]?.realizedPnlUsd ?? 0;
    const delta = roundUsd(r.realizedPnlUsd - prev);
    const ts = toIsoTimestamp(r.lastUpdated) ?? now.toISOString();
    next[key] = { realizedPnlUsd: r.realizedPnlUsd, lastUpdated: ts };
    if (Math.abs(delta) < 1e-6) continue;
    events.push({
      id: `trading:${key}:${ts}:${roundUsd(r.realizedPnlUsd)}`,
      stream: r.name,
      kind: r.kind === 'liquidation' ? 'liquidation' : 'trading',
      amountUsd: delta,
      timestamp: ts,
      source: 'trading',
      simulated: r.mode !== 'live',
      meta: {
        mode: r.mode,
        realizedPnlUsd: r.realizedPnlUsd,
        previousRealizedPnlUsd: prev,
        note: r.mode === 'live' ? 'realized PnL delta' : `realized PnL delta from ${r.mode} (simulated) trading`,
      },
    });
  }
  return { events, nextLastSeen: next };
}

export class TradingSource implements RevenueSource {
  readonly name = 'trading';
  readonly kind = 'trading' as const;
  private pending: LastSeen | undefined;

  constructor(
    private readonly state: EngineState,
    private readonly readReports: () => Promise<StrategyReport[]> = readStrategyReports,
  ) {}

  async collect(): Promise<RevenueEvent[]> {
    const reports = await this.readReports();
    const { events, nextLastSeen } = computeTradingDeltas(reports, this.state.tradingLastSeen);
    this.pending = nextLastSeen;
    return events;
  }

  async commit(): Promise<void> {
    if (this.pending) this.state.tradingLastSeen = this.pending;
    this.pending = undefined;
  }
}
