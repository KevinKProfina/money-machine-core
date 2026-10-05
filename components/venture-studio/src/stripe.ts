import { fetchJson, type FetchLike } from './http.js';

export type Listing = { productId: string; priceId: string; paymentLinkId: string; paymentLinkUrl: string };
export type SalesCount = { count: number; revenueCents: number };

export type ListingInput = {
  ventureId: string;
  name: string;
  description: string;
  unitAmountCents: number;
  currency: string;
  downloadUrl: string;
  /** Message shown on the Stripe checkout submit button area. */
  submitMessage?: string;
  /** Ids already created on an earlier (partially failed) attempt. */
  existing?: { productId?: string; priceId?: string };
  onProgress?: (partial: { productId?: string; priceId?: string }) => void;
};

export interface SalesChannel {
  readonly id: 'stripe' | 'none';
  /** Sales are not real money (Stripe test mode / simulator). */
  readonly simulated: boolean;
  createListing(input: ListingInput): Promise<Listing>;
  countSales(paymentLinkId: string): Promise<SalesCount>;
  deactivate(paymentLinkId: string): Promise<void>;
}

/** Form-encode nested params the way Stripe expects (a[b][c]=v). */
export function formEncode(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) sp.append(k, String(v));
  return sp.toString();
}

export class StripeChannel implements SalesChannel {
  readonly id = 'stripe' as const;
  readonly simulated: boolean;
  private readonly fetchImpl?: FetchLike;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    opts: { fetchImpl?: FetchLike; baseUrl?: string; backoffMs?: number } = {},
  ) {
    this.simulated = /^(sk|rk)_test_/.test(apiKey);
    this.fetchImpl = opts.fetchImpl;
    this.baseUrl = opts.baseUrl ?? 'https://api.stripe.com';
    this.backoffMs = opts.backoffMs ?? 500;
  }
  private readonly backoffMs: number;

  private headers(idempotencyKey?: string): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' };
    if (idempotencyKey) h['Idempotency-Key'] = idempotencyKey;
    return h;
  }

  private post<T>(pathName: string, params: Record<string, string | number | boolean | undefined>, idempotencyKey?: string): Promise<T> {
    return fetchJson<T>(`${this.baseUrl}${pathName}`, {
      fetchImpl: this.fetchImpl,
      backoffMs: this.backoffMs,
      init: { method: 'POST', headers: this.headers(idempotencyKey), body: formEncode(params) },
    });
  }

  private get<T>(pathName: string, query: Record<string, string | number | undefined>): Promise<T> {
    const qs = formEncode(query);
    return fetchJson<T>(`${this.baseUrl}${pathName}?${qs}`, { fetchImpl: this.fetchImpl, backoffMs: this.backoffMs, init: { method: 'GET', headers: this.headers() } });
  }

  async createListing(input: ListingInput): Promise<Listing> {
    const key = (step: string) => `mm-studio-${input.ventureId}-${step}-${input.unitAmountCents}-${input.currency}`;
    let productId = input.existing?.productId;
    if (!productId) {
      const product = await this.post<{ id: string }>(
        '/v1/products',
        { name: input.name.slice(0, 250), description: input.description.slice(0, 500) || undefined, 'metadata[venture_id]': input.ventureId, 'metadata[source]': 'mm-venture-studio' },
        key('product'),
      );
      productId = product.id;
      input.onProgress?.({ productId });
    }
    let priceId = input.existing?.priceId;
    if (!priceId) {
      const price = await this.post<{ id: string }>('/v1/prices', { product: productId, unit_amount: input.unitAmountCents, currency: input.currency }, key('price'));
      priceId = price.id;
      input.onProgress?.({ productId, priceId });
    }
    const link = await this.post<{ id: string; url: string }>(
      '/v1/payment_links',
      {
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': 1,
        'after_completion[type]': 'redirect',
        'after_completion[redirect][url]': input.downloadUrl,
        'metadata[venture_id]': input.ventureId,
        'custom_text[submit][message]': input.submitMessage?.slice(0, 1200),
      },
      key('link'),
    );
    return { productId, priceId, paymentLinkId: link.id, paymentLinkUrl: link.url };
  }

  async countSales(paymentLinkId: string): Promise<SalesCount> {
    let count = 0;
    let revenueCents = 0;
    let startingAfter: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = await this.get<{ data: Array<{ id: string; amount_total?: number | null; payment_status?: string }>; has_more: boolean }>('/v1/checkout/sessions', {
        payment_link: paymentLinkId,
        status: 'complete',
        limit: 100,
        starting_after: startingAfter,
      });
      for (const s of res.data) {
        if (s.payment_status !== undefined && s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') continue;
        count++;
        revenueCents += s.amount_total ?? 0;
      }
      if (!res.has_more || res.data.length === 0) break;
      startingAfter = res.data[res.data.length - 1]!.id;
    }
    return { count, revenueCents };
  }

  async deactivate(paymentLinkId: string): Promise<void> {
    await this.post(`/v1/payment_links/${encodeURIComponent(paymentLinkId)}`, { active: false });
  }
}

/** No payment provider configured: pages say "coming soon", nothing can be sold. */
export class NoChannel implements SalesChannel {
  readonly id = 'none' as const;
  readonly simulated = false;
  async createListing(): Promise<Listing> {
    throw new Error('no sales channel configured (set STRIPE_API_KEY)');
  }
  async countSales(): Promise<SalesCount> {
    return { count: 0, revenueCents: 0 };
  }
  async deactivate(): Promise<void> {
    // nothing to deactivate
  }
}
