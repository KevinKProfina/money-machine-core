import { type MarketplaceReport, readJsonSafe, statePaths } from '../mm-contract.js';
import { type RevenueEvent, type RevenueSource, toIsoTimestamp } from '../types.js';

/**
 * Maps agent-marketplace platform revenue events. The marketplace report carries no
 * proof of settlement, so events are labeled simulated unless MARKETPLACE_REVENUE_SIMULATED=false
 * (or an individual event carries `simulated: false`).
 */
export function mapMarketplaceEvents(report: MarketplaceReport | null, defaultSimulated: boolean): RevenueEvent[] {
  if (!report || report.schema !== 'mm.marketplace/v1' || !Array.isArray(report.revenueEvents)) return [];
  const out: RevenueEvent[] = [];
  const seen = new Set<string>();
  for (const e of report.revenueEvents) {
    if (!e || typeof e.id !== 'string' || !Number.isFinite(e.amountUsd)) continue;
    const ts = toIsoTimestamp(e.timestamp);
    if (!ts || seen.has(e.id)) continue;
    seen.add(e.id);
    const flag = (e as { simulated?: unknown }).simulated;
    out.push({
      id: `marketplace:${e.id}`,
      stream: 'agent-marketplace',
      kind: 'ai-services',
      amountUsd: e.amountUsd,
      timestamp: ts,
      source: 'ai-services',
      simulated: typeof flag === 'boolean' ? flag : defaultSimulated,
      meta: { serviceId: e.serviceId },
    });
  }
  return out;
}

export class AiServicesSource implements RevenueSource {
  readonly name = 'ai-services';
  readonly kind = 'ai-services' as const;
  constructor(private readonly defaultSimulated = process.env.MARKETPLACE_REVENUE_SIMULATED !== 'false') {}

  async collect(): Promise<RevenueEvent[]> {
    const report = await readJsonSafe<MarketplaceReport | null>(statePaths.marketplace(), null);
    return mapMarketplaceEvents(report, this.defaultSimulated);
  }
}
