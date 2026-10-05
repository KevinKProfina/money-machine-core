/**
 * In-memory fake of the Stripe REST endpoints the studio uses, exposed as a fetch
 * implementation. Used by tests and `npm run simulate`; all sales are simulated.
 */
import type { FetchLike } from '../http.js';

export type RecordedRequest = { method: string; url: string; path: string; body: Record<string, string>; headers: Record<string, string> };

type Session = { id: string; payment_link: string; status: 'complete' | 'open' | 'expired'; payment_status: 'paid' | 'unpaid'; amount_total: number };

export class FakeStripe {
  readonly requests: RecordedRequest[] = [];
  readonly products = new Map<string, Record<string, string>>();
  readonly prices = new Map<string, { product: string; unit_amount: number; currency: string }>();
  readonly links = new Map<string, { price: string; active: boolean; redirect: string; body: Record<string, string> }>();
  readonly sessions: Session[] = [];
  private seq = 0;
  private idem = new Map<string, unknown>();
  /** Make the next N requests fail with this HTTP status. */
  failNext: { count: number; status: number } = { count: 0, status: 500 };

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    this.requests.push({ method, url: input, path: url.pathname, body, headers });
    if (this.failNext.count > 0) {
      this.failNext.count--;
      return new Response(JSON.stringify({ error: { message: 'fake failure' } }), { status: this.failNext.status });
    }
    const key = headers['Idempotency-Key'];
    if (key && this.idem.has(key)) return json(this.idem.get(key));
    const res = this.route(method, url, body);
    if (key && res.status === 200) this.idem.set(key, res.body);
    return json(res.body, res.status);
  };

  private id(prefix: string): string {
    return `${prefix}_${++this.seq}`;
  }

  private route(method: string, url: URL, body: Record<string, string>): { status: number; body: unknown } {
    const p = url.pathname;
    if (method === 'POST' && p === '/v1/products') {
      const id = this.id('prod');
      this.products.set(id, body);
      return { status: 200, body: { id, object: 'product' } };
    }
    if (method === 'POST' && p === '/v1/prices') {
      const id = this.id('price');
      this.prices.set(id, { product: body.product!, unit_amount: Number(body.unit_amount), currency: body.currency! });
      return { status: 200, body: { id, object: 'price' } };
    }
    if (method === 'POST' && p === '/v1/payment_links') {
      const id = this.id('plink');
      this.links.set(id, { price: body['line_items[0][price]']!, active: true, redirect: body['after_completion[redirect][url]']!, body });
      return { status: 200, body: { id, object: 'payment_link', url: `https://buy.stripe.test/${id}` } };
    }
    const m = /^\/v1\/payment_links\/([^/]+)$/.exec(p);
    if (method === 'POST' && m) {
      const link = this.links.get(decodeURIComponent(m[1]!));
      if (!link) return { status: 404, body: { error: { message: 'no such link' } } };
      if (body.active === 'false') link.active = false;
      return { status: 200, body: { id: m[1], active: link.active } };
    }
    if (method === 'GET' && p === '/v1/checkout/sessions') {
      const link = url.searchParams.get('payment_link');
      const status = url.searchParams.get('status');
      const limit = Number(url.searchParams.get('limit') ?? 10);
      const after = url.searchParams.get('starting_after');
      let all = this.sessions.filter((s) => (!link || s.payment_link === link) && (!status || s.status === status));
      if (after) all = all.slice(all.findIndex((s) => s.id === after) + 1);
      return { status: 200, body: { object: 'list', data: all.slice(0, limit), has_more: all.length > limit } };
    }
    return { status: 404, body: { error: { message: `unknown route ${method} ${p}` } } };
  }

  /** Simulate a completed checkout on a payment link. */
  sell(linkId: string, opts: { status?: Session['status']; paid?: boolean } = {}): void {
    const link = this.links.get(linkId);
    if (!link) throw new Error(`unknown link ${linkId}`);
    const price = this.prices.get(link.price)!;
    this.sessions.push({ id: this.id('cs'), payment_link: linkId, status: opts.status ?? 'complete', payment_status: opts.paid === false ? 'unpaid' : 'paid', amount_total: price.unit_amount });
  }

  /** Stripe-mutating requests (anything that creates or changes objects). */
  mutations(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== 'GET');
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
