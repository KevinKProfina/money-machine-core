import type { RevenueStreamKind } from '../mm-contract.js';
import { type FetchLike, type RetryOptions, getJsonWithRetry, retryOptionsFromEnv } from '../http.js';
import { type Logger, type RevenueEvent, type RevenueSource, consoleLogger, isStreamKind } from '../types.js';

export type StripeBalanceTransaction = {
  id: string;
  object?: string;
  amount: number;
  fee?: number;
  net?: number;
  currency: string;
  type: string;
  created: number;
  description?: string | null;
  source?: string | null;
};

const CHARGE_TYPES = new Set(['charge', 'payment']);
const REFUND_TYPES = new Set(['refund', 'payment_refund']);
const FEE_TYPES = new Set(['stripe_fee']);

/**
 * Maps Stripe balance transactions to revenue events.
 * - charge/payment → gross amount (+ a separate negative fee event when fee > 0)
 * - refund/payment_refund → negative amount (Stripe already reports it negative)
 * - stripe_fee → negative amount (billing fees, e.g. Radar)
 * - other types (payout, transfer, adjustment, …) are not revenue and are skipped
 * - non-USD transactions are skipped with a warning (no FX conversion)
 */
export function mapStripeTransactions(
  txns: StripeBalanceTransaction[],
  opts: { stream: string; kind: RevenueStreamKind; testMode: boolean; log?: Logger },
): RevenueEvent[] {
  const log = opts.log ?? consoleLogger;
  const out: RevenueEvent[] = [];
  for (const t of txns) {
    if (!t || typeof t.id !== 'string' || !Number.isFinite(t.amount) || !Number.isFinite(t.created)) continue;
    const isCharge = CHARGE_TYPES.has(t.type);
    const isRefund = REFUND_TYPES.has(t.type);
    const isFee = FEE_TYPES.has(t.type);
    if (!isCharge && !isRefund && !isFee) continue;
    if (String(t.currency).toLowerCase() !== 'usd') {
      log.warn(`stripe: skipping ${t.id} in ${String(t.currency).toUpperCase()} (only USD is supported)`);
      continue;
    }
    const timestamp = new Date(t.created * 1000).toISOString();
    const base = { stream: opts.stream, kind: opts.kind, timestamp, source: 'stripe', simulated: opts.testMode };
    const meta = { stripeType: t.type, description: t.description ?? undefined, testMode: opts.testMode || undefined };
    const amountUsd = isRefund || isFee ? -Math.abs(t.amount) / 100 : t.amount / 100;
    out.push({ ...base, id: `stripe:${t.id}`, amountUsd, meta });
    if (isCharge && typeof t.fee === 'number' && t.fee > 0) {
      out.push({ ...base, id: `stripe:${t.id}:fee`, amountUsd: -t.fee / 100, meta: { ...meta, stripeType: 'processing_fee' } });
    }
  }
  return out;
}

export type StripeOptions = {
  apiKey: string;
  stream?: string;
  kind?: RevenueStreamKind;
  fetchImpl?: FetchLike;
  retry?: RetryOptions;
  maxPages?: number;
  log?: Logger;
};

export class StripeSource implements RevenueSource {
  readonly name = 'stripe';
  readonly kind: RevenueStreamKind;
  private readonly stream: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: StripeOptions) {
    this.kind = opts.kind ?? 'saas';
    this.stream = opts.stream ?? 'stripe';
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  static fromEnv(env: NodeJS.ProcessEnv, log?: Logger, fetchImpl?: FetchLike): StripeSource | undefined {
    if (!env.STRIPE_API_KEY) return undefined;
    const kindEnv = env.STRIPE_STREAM_KIND ?? 'saas';
    if (!isStreamKind(kindEnv)) (log ?? consoleLogger).warn(`STRIPE_STREAM_KIND="${kindEnv}" is invalid; using "saas"`);
    return new StripeSource({
      apiKey: env.STRIPE_API_KEY,
      kind: isStreamKind(kindEnv) ? kindEnv : 'saas',
      stream: env.STRIPE_STREAM_NAME || 'stripe',
      fetchImpl,
      retry: retryOptionsFromEnv(env),
      log,
    });
  }

  async collect(since: Date): Promise<RevenueEvent[]> {
    const testMode = /^(sk|rk)_test_/.test(this.opts.apiKey);
    const headers = { Authorization: `Bearer ${this.opts.apiKey}` };
    const gte = Math.floor(since.getTime() / 1000);
    const txns: StripeBalanceTransaction[] = [];
    let startingAfter: string | undefined;
    const maxPages = this.opts.maxPages ?? 50;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({ limit: '100', 'created[gte]': String(gte) });
      if (startingAfter) params.set('starting_after', startingAfter);
      const body = (await getJsonWithRetry(
        this.fetchImpl,
        `https://api.stripe.com/v1/balance_transactions?${params.toString()}`,
        headers,
        this.opts.retry,
      )) as { data?: StripeBalanceTransaction[]; has_more?: boolean };
      const data = Array.isArray(body?.data) ? body.data : [];
      txns.push(...data);
      if (!body?.has_more || data.length === 0) break;
      startingAfter = data[data.length - 1].id;
    }
    return mapStripeTransactions(txns, { stream: this.stream, kind: this.kind, testMode, log: this.opts.log });
  }
}
