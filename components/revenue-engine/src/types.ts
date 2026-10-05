import type { RevenueReport, RevenueStreamKind } from './mm-contract.js';

export const STREAM_KINDS: readonly RevenueStreamKind[] = [
  'trading',
  'liquidation',
  'ai-services',
  'affiliate',
  'digital-products',
  'saas',
  'other',
] as const;

export function isStreamKind(value: unknown): value is RevenueStreamKind {
  return typeof value === 'string' && (STREAM_KINDS as readonly string[]).includes(value);
}

/** One revenue (or cost/refund, when negative) entry. Deduplicated by `id`. */
export type RevenueEvent = {
  id: string;
  /** Stream name, e.g. "solana-trader", "stripe", "affiliate". Aggregation key. */
  stream: string;
  kind: RevenueStreamKind;
  /** USD; negative for refunds, fees, losses. */
  amountUsd: number;
  /** ISO-8601 timestamp of when the revenue happened. */
  timestamp: string;
  /** Adapter that produced the event (trading, ai-services, inbox, stripe, gumroad). */
  source: string;
  /** true when the money did not really move (paper trading, test-mode keys, unverified). */
  simulated: boolean;
  meta?: Record<string, unknown>;
};

export interface RevenueSource {
  name: string;
  /** Default kind of the events this adapter produces (individual events may differ). */
  kind: RevenueStreamKind;
  /** Collect events since `since`. Throw on failure; the engine degrades gracefully. */
  collect(since: Date): Promise<RevenueEvent[]>;
  /** Called only after the collected events were persisted (advance cursors, move files). */
  commit?(): Promise<void>;
}

export type SourceRunStatus = { name: string; ok: boolean; collected: number; newEvents: number; error?: string };

/** revenue.json = contract RevenueReport plus engine-specific extension fields. */
export type ExtendedRevenueReport = RevenueReport & {
  /** Sum of events not labeled simulated. */
  realTotalUsd: number;
  /** Sum of events labeled simulated (paper trading, Stripe test mode, unverified marketplace revenue). */
  simulatedTotalUsd: number;
  eventCount: number;
  /** Number of streams with positive all-time total (the basis of `concentration`). */
  positiveStreams: number;
  recommendations: string[];
  sources?: SourceRunStatus[];
  notes: string[];
};

export type Logger = {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
};

export const consoleLogger: Logger = {
  info: (m) => console.log(`[revenue-engine] ${m}`),
  warn: (m) => console.warn(`[revenue-engine] WARN ${m}`),
  error: (m) => console.error(`[revenue-engine] ERROR ${m}`),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Normalizes ISO strings, unix seconds or unix milliseconds to ISO; undefined if invalid. */
export function toIsoTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let ms: number;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const n = Number(value);
    ms = n < 1e11 ? n * 1000 : n;
  } else if (typeof value === 'string') {
    ms = Date.parse(value);
  } else {
    return undefined;
  }
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
