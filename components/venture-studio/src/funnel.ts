import type { DiagnosisThresholds } from './config.js';
import type { CheckoutCounts } from './stripe.js';

/**
 * Funnel math and diagnosis — pure functions, no I/O.
 *
 *   visits (landing pageviews) → buy clicks → checkouts started (Stripe sessions) → sales (paid)
 */

export type EventCounts = { pageview: number; buy_click: number; download: number };

/** Daily aggregate written by components/analytics-collector (`mm.analytics-day/v1`). */
export type DayAggregate = {
  schema: 'mm.analytics-day/v1';
  site: string;
  day: string;
  updatedAt: string;
  uniqueVisitors: number;
  events: EventCounts;
  paths: Record<string, EventCounts & { uniqueVisitors: number }>;
  referrers: Record<string, number>;
  botsFiltered: number;
};

export type TrafficCounts = { visits: number; uniqueVisitors: number; buyClicks: number; downloads: number; days: number };

export type Diagnosis = 'no-traffic' | 'no-interest' | 'checkout-friction' | 'converting' | 'unknown';

export type TrafficSourceId = 'files' | 'http' | 'none';

export type Funnel = {
  /** First UTC day counted (venture became purchasable / was published). */
  since: string;
  trafficSource: TrafficSourceId;
  /** Landing-page views (`pageview` on /<slug>/); null when no analytics data is available. */
  visits: number | null;
  /** Sum of daily approximate unique visitors (a returning visitor counts once per day). */
  uniqueVisitors: number | null;
  buyClicks: number | null;
  downloads: number | null;
  checkoutsStarted: number;
  checkoutsOpen: number;
  checkoutsExpired: number;
  checkoutsCompleted: number;
  sales: number;
  /** buyClicks / visits */
  clickRate: number | null;
  /** completed / started checkouts */
  checkoutCompletionRate: number | null;
  /** sales / visits */
  conversionRate: number | null;
};

export const utcDay = (d: Date | number): string => new Date(d).toISOString().slice(0, 10);

const rate = (num: number | null, den: number | null): number | null => (num === null || den === null || den <= 0 ? null : Math.round((num / den) * 10_000) / 10_000);

const isPathOf = (p: string, slug: string) => p === `/${slug}/` || p === `/${slug}` || p.startsWith(`/${slug}/`);

/** Traffic of one venture (all paths under /<slug>/) from `fromDay` (inclusive) on. */
export function ventureTraffic(days: DayAggregate[], slug: string, fromDay: string): TrafficCounts {
  const t: TrafficCounts = { visits: 0, uniqueVisitors: 0, buyClicks: 0, downloads: 0, days: 0 };
  for (const d of days) {
    if (d.day < fromDay) continue;
    t.days++;
    for (const [p, c] of Object.entries(d.paths ?? {})) {
      if (!isPathOf(p, slug)) continue;
      t.visits += c.pageview ?? 0;
      t.buyClicks += c.buy_click ?? 0;
      t.downloads += c.download ?? 0;
      t.uniqueVisitors += c.uniqueVisitors ?? 0;
    }
  }
  return t;
}

export type SiteTotals = { visits: number; uniqueVisitors: number; buyClicks: number; downloads: number; botsFiltered: number; days: number };

/** Site-wide totals from `fromDay` (inclusive) on, plus the top referrer hosts. */
export function siteTraffic(days: DayAggregate[], fromDay: string, topN = 10): SiteTotals & { topReferrers: Array<{ host: string; visits: number }> } {
  const t: SiteTotals = { visits: 0, uniqueVisitors: 0, buyClicks: 0, downloads: 0, botsFiltered: 0, days: 0 };
  const refs = new Map<string, number>();
  for (const d of days) {
    if (d.day < fromDay) continue;
    t.days++;
    t.visits += d.events?.pageview ?? 0;
    t.buyClicks += d.events?.buy_click ?? 0;
    t.downloads += d.events?.download ?? 0;
    t.uniqueVisitors += d.uniqueVisitors ?? 0;
    t.botsFiltered += d.botsFiltered ?? 0;
    for (const [h, n] of Object.entries(d.referrers ?? {})) refs.set(h, (refs.get(h) ?? 0) + n);
  }
  const topReferrers = [...refs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([host, visits]) => ({ host, visits }));
  return { ...t, topReferrers };
}

export function computeFunnel(traffic: TrafficCounts | undefined, checkouts: CheckoutCounts, source: TrafficSourceId, since: string): Funnel {
  const t = traffic && source !== 'none' ? traffic : undefined;
  const visits = t ? t.visits : null;
  return {
    since,
    trafficSource: t ? source : 'none',
    visits,
    uniqueVisitors: t ? t.uniqueVisitors : null,
    buyClicks: t ? t.buyClicks : null,
    downloads: t ? t.downloads : null,
    checkoutsStarted: checkouts.started,
    checkoutsOpen: checkouts.open,
    checkoutsExpired: checkouts.expired,
    checkoutsCompleted: checkouts.complete,
    sales: checkouts.paid,
    clickRate: rate(t ? t.buyClicks : null, visits),
    checkoutCompletionRate: rate(checkouts.complete, checkouts.started),
    conversionRate: rate(checkouts.paid, visits),
  };
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

/**
 * Where does the funnel break?
 *  - no-traffic:        fewer than `minVisits` landing visits and no sale → nobody finds the page
 *  - converting:        at least one sale (unless checkouts leak badly → checkout-friction)
 *  - no-interest:       enough visits, but click rate < `minClickRate` (takes precedence over a
 *                       few abandoned checkouts), or too few clicks to speak of friction
 *  - checkout-friction: ≥ `minFrictionClicks` buy clicks / started checkouts, but no sale or a
 *                       completion rate below `minCheckoutCompletion`
 *  - unknown:           no traffic data (collector not configured/unreachable) and no Stripe signal
 */
export function diagnose(f: Funnel, t: DiagnosisThresholds): { diagnosis: Diagnosis; reason: string } {
  const hasTraffic = f.visits !== null;
  const clicks = Math.max(f.buyClicks ?? 0, f.checkoutsStarted);
  const leaky = f.checkoutsStarted >= t.minFrictionClicks && (f.checkoutCompletionRate ?? 0) < t.minCheckoutCompletion;
  if (f.sales > 0) {
    if (leaky) return { diagnosis: 'checkout-friction', reason: `${f.sales} sale(s), but only ${f.checkoutsCompleted}/${f.checkoutsStarted} checkouts completed (${pct(f.checkoutCompletionRate)} < ${pct(t.minCheckoutCompletion)})` };
    return { diagnosis: 'converting', reason: `${f.sales} sale(s)${hasTraffic ? ` from ${f.visits} visits (${pct(f.conversionRate)})` : ''}` };
  }
  if (hasTraffic && f.visits! < t.minVisits && clicks < t.minFrictionClicks) {
    return { diagnosis: 'no-traffic', reason: `${f.visits} visits < ${t.minVisits}: traffic problem, not necessarily a product problem` };
  }
  // enough visitors, but the click rate is below the bar → the offer is the problem, not the checkout
  if (hasTraffic && (f.clickRate ?? 0) < t.minClickRate && f.checkoutsStarted < t.minFrictionClicks * 2) {
    return { diagnosis: 'no-interest', reason: `${f.visits} visits but only ${f.buyClicks} buy click(s) (${pct(f.clickRate)} < ${pct(t.minClickRate)}): angle, audience or price does not resonate` };
  }
  if (clicks >= t.minFrictionClicks) {
    return { diagnosis: 'checkout-friction', reason: `${f.buyClicks ?? 'n/a'} buy clicks, ${f.checkoutsStarted} checkouts started, 0 completed (${f.checkoutsExpired} expired, ${f.checkoutsOpen} open)` };
  }
  if (!hasTraffic) return { diagnosis: 'unknown', reason: 'no traffic data (analytics collector not configured or unreachable)' };
  return { diagnosis: 'no-interest', reason: `${f.visits} visits but only ${f.buyClicks} buy click(s) (${pct(f.clickRate)}${(f.clickRate ?? 0) < t.minClickRate ? ` < ${pct(t.minClickRate)}` : ''}): angle, audience or price does not resonate` };
}

/** One-line funnel for logs, summaries and the ideation history. */
export function funnelLine(f: Funnel): string {
  const traffic = f.visits === null ? 'visits n/a' : `visits ${f.visits} (≈${f.uniqueVisitors} unique), buy clicks ${f.buyClicks} (${pct(f.clickRate)})`;
  return `${traffic}, checkouts ${f.checkoutsCompleted}/${f.checkoutsStarted} completed, sales ${f.sales}${f.conversionRate !== null ? ` (${pct(f.conversionRate)} of visits)` : ''}`;
}
