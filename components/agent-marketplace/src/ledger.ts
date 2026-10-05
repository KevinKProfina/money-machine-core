import { randomUUID } from 'node:crypto';
import type { Job, LedgerEntry, LedgerEntryType, MarketState, Micros, RevenueSplit } from './types.ts';
import { usdToMicros } from './types.ts';

export const EXTERNAL = 'external';
export const ESCROW = 'escrow';
export const PLATFORM = 'platform';
export const agentAccount = (agentId: string) => `agent:${agentId}`;

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: 'insufficient_funds' | 'invalid_amount' | 'invalid_state',
  ) {
    super(message);
  }
}

export function balanceOf(state: MarketState, account: string): Micros {
  return state.balances[account] ?? 0;
}

/** Move `amount` micro-USD between accounts, appending one ledger entry. Only `external` may go negative. */
export function transfer(
  state: MarketState,
  type: LedgerEntryType,
  from: string,
  to: string,
  amount: Micros,
  opts: { jobId?: string; memo?: string; now?: string } = {},
): LedgerEntry | undefined {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new LedgerError(`invalid amount ${amount}`, 'invalid_amount');
  if (amount === 0) return undefined; // nothing to record
  if (from === to) throw new LedgerError('transfer to same account', 'invalid_state');
  if (from !== EXTERNAL && balanceOf(state, from) < amount) {
    throw new LedgerError(`insufficient funds in ${from}`, 'insufficient_funds');
  }
  const entry: LedgerEntry = {
    id: randomUUID(),
    ts: opts.now ?? new Date().toISOString(),
    type,
    from,
    to,
    amount,
    ...(opts.jobId ? { jobId: opts.jobId } : {}),
    ...(opts.memo ? { memo: opts.memo } : {}),
  };
  state.balances[from] = balanceOf(state, from) - amount;
  state.balances[to] = balanceOf(state, to) + amount;
  state.ledger.push(entry);
  return entry;
}

/** Internal credit (no real payment rail): moves funds from the `external` account to an agent. */
export function deposit(state: MarketState, agentId: string, amount: Micros, memo?: string): LedgerEntry {
  if (amount <= 0) throw new LedgerError('deposit must be positive', 'invalid_amount');
  return transfer(state, 'deposit', EXTERNAL, agentAccount(agentId), amount, { memo })!;
}

export function holdEscrow(state: MarketState, job: Job): void {
  transfer(state, 'escrow_hold', agentAccount(job.requesterAgentId), ESCROW, usdToMicros(job.priceUsd), { jobId: job.id });
}

export type Settlement = {
  priceMicros: Micros;
  feeMicros: Micros;
  providerMicros: Micros;
  splits: Array<{ agentId: string; micros: Micros }>;
};

/**
 * Pure split math. Platform fee is taken first from the gross price; extra recipients
 * receive their percentage of the remaining net; the provider keeps the remainder
 * (including rounding dust), so the parts always sum exactly to the price.
 */
export function computeSettlement(priceMicros: Micros, feePct: number, splits: RevenueSplit[]): Settlement {
  if (!Number.isSafeInteger(priceMicros) || priceMicros < 0) throw new LedgerError('invalid price', 'invalid_amount');
  if (!(feePct >= 0 && feePct <= 100)) throw new LedgerError('invalid fee pct', 'invalid_amount');
  validateSplits(splits);
  const feeMicros = Math.floor((priceMicros * Math.round(feePct * 100)) / 10_000);
  const net = priceMicros - feeMicros;
  const parts = splits.map((s) => ({ agentId: s.agentId, micros: Math.floor((net * Math.round(s.pct * 100)) / 10_000) }));
  const providerMicros = net - parts.reduce((a, p) => a + p.micros, 0);
  return { priceMicros, feeMicros, providerMicros, splits: parts };
}

export const MAX_SPLITS = 5;

export function validateSplits(splits: RevenueSplit[]): void {
  if (splits.length > MAX_SPLITS) throw new LedgerError(`at most ${MAX_SPLITS} revenue splits`, 'invalid_amount');
  let total = 0;
  const seen = new Set<string>();
  for (const s of splits) {
    if (!(s.pct > 0 && s.pct <= 100)) throw new LedgerError('split pct must be in (0, 100]', 'invalid_amount');
    if (seen.has(s.agentId)) throw new LedgerError('duplicate split recipient', 'invalid_amount');
    seen.add(s.agentId);
    total += s.pct;
  }
  if (total > 100 + 1e-9) throw new LedgerError('revenue splits sum to more than 100 %', 'invalid_amount');
}

/** Release escrow for a successful job: fee to platform, shares to split recipients, rest to provider. */
export function settleSuccess(
  state: MarketState,
  job: Job,
  feePct: number,
  splits: RevenueSplit[],
  now?: string,
): Settlement {
  const s = computeSettlement(usdToMicros(job.priceUsd), feePct, splits);
  if (balanceOf(state, ESCROW) < s.priceMicros) throw new LedgerError('escrow underfunded', 'invalid_state');
  transfer(state, 'platform_fee', ESCROW, PLATFORM, s.feeMicros, { jobId: job.id, now });
  for (const part of s.splits) {
    transfer(state, 'split', ESCROW, agentAccount(part.agentId), part.micros, { jobId: job.id, now });
  }
  transfer(state, 'release', ESCROW, agentAccount(job.providerAgentId), s.providerMicros, { jobId: job.id, now });
  return s;
}

export function refund(state: MarketState, job: Job, now?: string): void {
  transfer(state, 'refund', ESCROW, agentAccount(job.requesterAgentId), usdToMicros(job.priceUsd), { jobId: job.id, now });
}

/**
 * Ledger invariants:
 *  1. Replaying every entry from zero reproduces the stored balances (double-entry consistency).
 *  2. All balances sum to zero (money is conserved; `external` holds minus total deposits).
 *  3. No account other than `external` is negative.
 *  4. Escrow equals the sum of prices of jobs still holding funds (queued/running).
 * Returns a list of violations (empty = OK).
 */
export function checkInvariants(state: MarketState): string[] {
  const problems: string[] = [];
  const replay: Record<string, number> = {};
  for (const e of state.ledger) {
    replay[e.from] = (replay[e.from] ?? 0) - e.amount;
    replay[e.to] = (replay[e.to] ?? 0) + e.amount;
  }
  const keys = new Set([...Object.keys(replay), ...Object.keys(state.balances)]);
  let sum = 0;
  for (const k of keys) {
    const stored = state.balances[k] ?? 0;
    if ((replay[k] ?? 0) !== stored) problems.push(`balance mismatch for ${k}: stored ${stored}, replay ${replay[k] ?? 0}`);
    if (k !== EXTERNAL && stored < 0) problems.push(`negative balance for ${k}`);
    sum += stored;
  }
  if (sum !== 0) problems.push(`balances do not sum to zero (${sum})`);
  const held = Object.values(state.jobs)
    .filter((j) => j.status === 'queued' || j.status === 'running')
    .reduce((a, j) => a + usdToMicros(j.priceUsd), 0);
  if (held !== balanceOf(state, ESCROW)) problems.push(`escrow ${balanceOf(state, ESCROW)} != held ${held}`);
  return problems;
}
