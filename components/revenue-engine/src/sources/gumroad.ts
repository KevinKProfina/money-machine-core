import { type FetchLike, type RetryOptions, getJsonWithRetry, retryOptionsFromEnv } from '../http.js';
import { type Logger, type RevenueEvent, type RevenueSource, consoleLogger, toIsoTimestamp } from '../types.js';

/** Subset of a Gumroad v2 sale object that the engine uses. Amounts are in cents. */
export type GumroadSale = {
  id: string;
  created_at: string;
  price: number;
  gumroad_fee?: number;
  currency?: string;
  product_name?: string;
  product_id?: string;
  refunded?: boolean;
  partially_refunded?: boolean;
  chargedback?: boolean;
  test?: boolean;
};

/**
 * Maps Gumroad sales to `digital-products` events:
 * - sale → +price
 * - gumroad_fee > 0 → separate negative fee event
 * - refunded / chargedback → separate negative event for the full price
 *   (partial refunds are not itemized by the sales endpoint and are only flagged in meta)
 * - non-USD sales are skipped with a warning; `test` sales are labeled simulated
 */
export function mapGumroadSales(sales: GumroadSale[], opts: { stream: string; log?: Logger }): RevenueEvent[] {
  const log = opts.log ?? consoleLogger;
  const out: RevenueEvent[] = [];
  for (const s of sales) {
    if (!s || typeof s.id !== 'string' || !Number.isFinite(s.price)) continue;
    const ts = toIsoTimestamp(s.created_at);
    if (!ts) continue;
    const currency = (s.currency ?? 'usd').toLowerCase();
    if (currency !== 'usd') {
      log.warn(`gumroad: skipping sale ${s.id} in ${currency.toUpperCase()} (only USD is supported)`);
      continue;
    }
    const base = { stream: opts.stream, kind: 'digital-products' as const, timestamp: ts, source: 'gumroad', simulated: s.test === true };
    const meta = { product: s.product_name, productId: s.product_id, partiallyRefunded: s.partially_refunded || undefined };
    out.push({ ...base, id: `gumroad:${s.id}`, amountUsd: s.price / 100, meta });
    if (typeof s.gumroad_fee === 'number' && s.gumroad_fee > 0) {
      out.push({ ...base, id: `gumroad:${s.id}:fee`, amountUsd: -s.gumroad_fee / 100, meta: { ...meta, type: 'fee' } });
    }
    if (s.refunded || s.chargedback) {
      out.push({
        ...base,
        id: `gumroad:${s.id}:refund`,
        amountUsd: -s.price / 100,
        meta: { ...meta, type: s.chargedback ? 'chargeback' : 'refund' },
      });
    }
  }
  return out;
}

export type GumroadOptions = {
  accessToken: string;
  stream?: string;
  fetchImpl?: FetchLike;
  retry?: RetryOptions;
  maxPages?: number;
  log?: Logger;
};

export class GumroadSource implements RevenueSource {
  readonly name = 'gumroad';
  readonly kind = 'digital-products' as const;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: GumroadOptions) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  static fromEnv(env: NodeJS.ProcessEnv, log?: Logger, fetchImpl?: FetchLike): GumroadSource | undefined {
    if (!env.GUMROAD_ACCESS_TOKEN) return undefined;
    return new GumroadSource({ accessToken: env.GUMROAD_ACCESS_TOKEN, stream: env.GUMROAD_STREAM_NAME || 'gumroad', retry: retryOptionsFromEnv(env), log, fetchImpl });
  }

  async collect(since: Date): Promise<RevenueEvent[]> {
    // `after` is date-granular; overlap is harmless because events are deduplicated by id.
    const after = new Date(since.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const sales: GumroadSale[] = [];
    let pageKey: string | undefined;
    const maxPages = this.opts.maxPages ?? 50;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ after, access_token: this.opts.accessToken });
      if (pageKey) params.set('page_key', pageKey);
      const body = (await getJsonWithRetry(
        this.fetchImpl,
        `https://api.gumroad.com/v2/sales?${params.toString()}`,
        {},
        this.opts.retry,
      )) as { success?: boolean; sales?: GumroadSale[]; next_page_key?: string; message?: string };
      if (body?.success === false) throw new Error(`gumroad API error: ${body.message ?? 'unknown'}`);
      const batch = Array.isArray(body?.sales) ? body.sales : [];
      sales.push(...batch);
      if (!body?.next_page_key || batch.length === 0) break;
      pageKey = body.next_page_key;
    }
    return mapGumroadSales(sales, { stream: this.opts.stream ?? 'gumroad', log: this.opts.log });
  }
}
