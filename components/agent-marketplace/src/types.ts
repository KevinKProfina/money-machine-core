/** Money amounts are stored as integer micro-USD (1 USD = 1_000_000) to keep the ledger exact. */
export type Micros = number;

export const MICROS_PER_USD = 1_000_000;

export function usdToMicros(usd: number): Micros {
  return Math.round(usd * MICROS_PER_USD);
}

export function microsToUsd(m: Micros): number {
  return m / MICROS_PER_USD;
}

export type Agent = {
  id: string;
  name: string;
  ownerWallet?: string;
  apiKeyHash: string;
  createdAt: string;
  /** True for the marketplace operator's own agent (created by `npm run seed`). */
  platform?: boolean;
};

export type RevenueSplit = {
  /** Agent that receives a share of the provider's net (after platform fee). */
  agentId: string;
  /** Percentage of the net amount, 0 < pct <= 100. All splits of a service sum to <= 100. */
  pct: number;
  label?: string;
};

export type Service = {
  id: string;
  agentId: string;
  name: string;
  capability: string;
  description: string;
  priceUsd: number;
  handler: string; // 'builtin:<name>' | 'webhook:<url>'
  active: boolean;
  splits: RevenueSplit[];
  /** HMAC secret for webhook handlers (never returned by the public API). */
  webhookSecret?: string;
  createdAt: string;
};

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'refunded';

export type Job = {
  id: string;
  serviceId: string;
  requesterAgentId: string;
  providerAgentId: string;
  input: unknown;
  status: JobStatus;
  priceUsd: number;
  feeUsd?: number;
  result?: unknown;
  error?: string;
  rating?: number;
  timings: {
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
  };
};

export type LedgerEntryType = 'deposit' | 'escrow_hold' | 'release' | 'platform_fee' | 'split' | 'refund';

/** Double-entry ledger line: moves `amount` from `debit` account to `credit` account. */
export type LedgerEntry = {
  id: string;
  ts: string;
  type: LedgerEntryType;
  from: string;
  to: string;
  amount: Micros;
  jobId?: string;
  memo?: string;
};

export type ReputationStats = {
  successes: number;
  failures: number;
  ratingSum: number;
  ratingCount: number;
  /** Exponential moving average of execution latency in ms; undefined until first sample. */
  latencyEmaMs?: number;
};

export type RevenueEvent = { id: string; timestamp: string; amountUsd: number; serviceId: string };

export type MarketState = {
  schema: 'agent-marketplace.state/v1';
  agents: Record<string, Agent>;
  services: Record<string, Service>;
  jobs: Record<string, Job>;
  /** Account balances in micro-USD. Keys: `agent:<id>`, `escrow`, `platform`, `external`. */
  balances: Record<string, Micros>;
  ledger: LedgerEntry[];
  reputation: { agents: Record<string, ReputationStats>; services: Record<string, ReputationStats> };
  revenueEvents: RevenueEvent[];
};

export function emptyState(): MarketState {
  return {
    schema: 'agent-marketplace.state/v1',
    agents: {},
    services: {},
    jobs: {},
    balances: {},
    ledger: [],
    reputation: { agents: {}, services: {} },
    revenueEvents: [],
  };
}
