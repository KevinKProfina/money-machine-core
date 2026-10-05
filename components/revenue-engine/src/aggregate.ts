import type { RevenueStreamKind } from './mm-contract.js';
import { type ExtendedRevenueReport, type RevenueEvent, STREAM_KINDS, roundUsd } from './types.js';

const DAY_MS = 24 * 3600 * 1000;
export const DOMINANT_SHARE_THRESHOLD = 0.6;

/** Herfindahl–Hirschman index of the positive values' shares (0..1). 0 when nothing is positive. */
export function herfindahl(values: number[]): number {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  const sum = positive.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;
  return positive.reduce((acc, v) => acc + (v / sum) ** 2, 0);
}

type StreamAgg = ExtendedRevenueReport['streams'][string] & { latestTs: string };

export function aggregate(events: RevenueEvent[], now: Date = new Date()): ExtendedRevenueReport {
  const nowMs = now.getTime();
  const from7 = nowMs - 7 * DAY_MS;
  const from30 = nowMs - 30 * DAY_MS;
  const streams: Record<string, StreamAgg> = {};
  let totalUsd = 0;
  let last7dUsd = 0;
  let last30dUsd = 0;
  let realTotalUsd = 0;
  let simulatedTotalUsd = 0;

  for (const e of events) {
    const ts = Date.parse(e.timestamp);
    const s = (streams[e.stream] ??= { kind: e.kind, totalUsd: 0, last7dUsd: 0, last30dUsd: 0, simulated: false, latestTs: e.timestamp });
    if (e.timestamp >= s.latestTs) {
      s.kind = e.kind;
      s.latestTs = e.timestamp;
    }
    // A stream is labeled simulated if ANY of its events is simulated (conservative).
    s.simulated ||= e.simulated;
    s.totalUsd += e.amountUsd;
    totalUsd += e.amountUsd;
    if (e.simulated) simulatedTotalUsd += e.amountUsd;
    else realTotalUsd += e.amountUsd;
    if (ts > from30 && ts <= nowMs) {
      s.last30dUsd += e.amountUsd;
      last30dUsd += e.amountUsd;
      if (ts > from7) {
        s.last7dUsd += e.amountUsd;
        last7dUsd += e.amountUsd;
      }
    }
  }

  const outStreams: ExtendedRevenueReport['streams'] = {};
  for (const name of Object.keys(streams).sort()) {
    const { latestTs: _latest, ...s } = streams[name];
    outStreams[name] = {
      ...s,
      totalUsd: roundUsd(s.totalUsd),
      last7dUsd: roundUsd(s.last7dUsd),
      last30dUsd: roundUsd(s.last30dUsd),
    };
  }
  const totals = Object.values(outStreams).map((s) => s.totalUsd);
  const concentration = roundUsd(herfindahl(totals));

  const report: ExtendedRevenueReport = {
    schema: 'mm.revenue/v1',
    timestamp: now.toISOString(),
    totalUsd: roundUsd(totalUsd),
    last7dUsd: roundUsd(last7dUsd),
    last30dUsd: roundUsd(last30dUsd),
    streams: outStreams,
    concentration,
    realTotalUsd: roundUsd(realTotalUsd),
    simulatedTotalUsd: roundUsd(simulatedTotalUsd),
    eventCount: events.length,
    positiveStreams: totals.filter((t) => t > 0).length,
    recommendations: [],
    notes: [
      'Totals include simulated events (paper trading, test-mode payments, unverified marketplace revenue); see realTotalUsd / simulatedTotalUsd and per-stream `simulated`.',
      'concentration = Herfindahl index of positive all-time stream totals (0 when there is no positive revenue).',
    ],
  };
  report.recommendations = recommend(report);
  return report;
}

/** Kinds that need little or no trading capital — preferred when suggesting diversification. */
const LOW_CAPITAL_KINDS: RevenueStreamKind[] = ['digital-products', 'affiliate', 'saas', 'ai-services'];

/** Deterministic, rule-based diversification hints. Advice, not a forecast. */
export function recommend(report: ExtendedRevenueReport): string[] {
  const recs: string[] = [];
  const entries = Object.entries(report.streams);
  const positive = entries.filter(([, s]) => s.totalUsd > 0);
  const positiveSum = positive.reduce((a, [, s]) => a + s.totalUsd, 0);

  if (positive.length === 0) {
    recs.push('No positive revenue recorded yet. Record real income via the inbox or `npm run add`, or connect Stripe/Gumroad.');
    return recs;
  }

  // Kind totals (positive only) to find under-represented kinds.
  const kindTotals = new Map<RevenueStreamKind, number>();
  for (const k of STREAM_KINDS) kindTotals.set(k, 0);
  for (const [, s] of positive) kindTotals.set(s.kind, (kindTotals.get(s.kind) ?? 0) + s.totalUsd);

  const [topName, top] = positive.reduce((a, b) => (b[1].totalUsd > a[1].totalUsd ? b : a));
  const topShare = top.totalUsd / positiveSum;
  if (topShare > DOMINANT_SHARE_THRESHOLD) {
    const candidates = [...LOW_CAPITAL_KINDS, 'trading' as const, 'liquidation' as const]
      .filter((k) => k !== top.kind)
      .sort((a, b) => (kindTotals.get(a) ?? 0) - (kindTotals.get(b) ?? 0))
      .slice(0, 3);
    recs.push(
      `Stream "${topName}" (${top.kind}) is ${(topShare * 100).toFixed(0)}% of positive revenue (> ${DOMINANT_SHARE_THRESHOLD * 100}%). ` +
        `Consider growing: ${candidates.join(', ')}.`,
    );
  }
  if (report.concentration >= 0.5) {
    recs.push(`Revenue is highly concentrated (HHI ${report.concentration.toFixed(2)}); a single failure would remove most income.`);
  } else if (report.concentration >= 0.25) {
    recs.push(`Revenue is moderately concentrated (HHI ${report.concentration.toFixed(2)}).`);
  } else {
    recs.push(`Revenue is reasonably diversified (HHI ${report.concentration.toFixed(2)}).`);
  }
  const tradingShare = ((kindTotals.get('trading') ?? 0) + (kindTotals.get('liquidation') ?? 0)) / positiveSum;
  if (tradingShare > DOMINANT_SHARE_THRESHOLD) {
    recs.push(`Trading/liquidation is ${(tradingShare * 100).toFixed(0)}% of revenue; market-dependent income is volatile — non-trading streams reduce correlation.`);
  }
  for (const [name, s] of entries) {
    if (s.last30dUsd < 0) recs.push(`Stream "${name}" is net negative over the last 30 days (${s.last30dUsd.toFixed(2)} USD); review it.`);
  }
  const grossPositive = report.realTotalUsd + report.simulatedTotalUsd;
  if (report.simulatedTotalUsd > 0 && grossPositive > 0 && report.simulatedTotalUsd / grossPositive > 0.5) {
    recs.push('Most recorded revenue is simulated (paper/test); it is not real income.');
  }
  return recs;
}
