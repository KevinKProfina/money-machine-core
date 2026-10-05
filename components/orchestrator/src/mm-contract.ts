// Money Machine shared contract v1.
// This file is the single source of truth. Every component repo keeps a verbatim
// copy at src/mm-contract.ts — do not edit the copies; edit here and re-sync
// with `npm run sync-contract` in money-machine-core.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const CONTRACT_VERSION = 1;

export type RunMode = 'dry-run' | 'paper' | 'live';
export type StrategyStatus = 'active' | 'paused' | 'failed';
export type RiskProfile = 'conservative' | 'moderate' | 'aggressive';

/** Written by every capital-consuming strategy to strategies/<name>.json */
export type StrategyReport = {
  schema: 'mm.strategy-report/v1';
  name: string;
  kind: 'trading' | 'liquidation' | 'arbitrage' | 'other';
  mode: RunMode;
  status: StrategyStatus;
  /** Capital currently assigned to the strategy (USD). */
  capitalUsd: number;
  /** Capital currently deployed in open positions (USD). */
  deployedUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  /** (realized + unrealized) / starting capital, as a fraction (0.12 = +12 %). */
  totalReturn: number;
  /** Fraction of closed trades with positive PnL, 0..1. */
  winRate: number;
  /** Average PnL per closed trade as a fraction of trade size. */
  avgProfit: number;
  /** Max peak-to-trough equity drawdown, fraction 0..1. */
  maxDrawdown: number;
  /** Per-trade Sharpe-like ratio (mean / stdev of trade returns), 0 if < 2 trades. */
  sharpeRatio: number;
  totalTrades: number;
  openPositions: number;
  lastUpdated: string;
  notes?: string[];
};

/** Written by capital-allocator to allocation-proposal.json */
export type AllocationProposal = {
  schema: 'mm.allocation-proposal/v1';
  timestamp: string;
  totalCapitalUsd: number;
  riskProfile: RiskProfile;
  allocations: Record<string, number>;
  scores: Record<string, { score: number; riskGateAllowed: boolean; reasons: string[] }>;
};

/** Written by orchestrator to allocations.json — the binding budget for every strategy. */
export type FinalAllocations = {
  schema: 'mm.allocations/v1';
  timestamp: string;
  totalCapitalUsd: number;
  reserveUsd: number;
  allocations: Record<string, number>;
  paused: string[];
  killSwitch: boolean;
  reasons: Record<string, string>;
};

/** Written by orchestrator to portfolio.json */
export type PortfolioState = {
  schema: 'mm.portfolio/v1';
  timestamp: string;
  totalCapitalUsd: number;
  allocatedUsd: number;
  reserveUsd: number;
  totalPnlUsd: number;
  portfolioReturn: number;
  maxDrawdown: number;
  riskScore: number;
  activeStrategies: string[];
  pausedStrategies: string[];
  reinvestedUsd: number;
};

export type RevenueStreamKind = 'trading' | 'liquidation' | 'ai-services' | 'affiliate' | 'digital-products' | 'saas' | 'other';

/** Written by revenue-engine to revenue.json */
export type RevenueReport = {
  schema: 'mm.revenue/v1';
  timestamp: string;
  totalUsd: number;
  last7dUsd: number;
  last30dUsd: number;
  streams: Record<string, { kind: RevenueStreamKind; totalUsd: number; last7dUsd: number; last30dUsd: number; simulated: boolean }>;
  /** Herfindahl index of stream shares, 0..1 (lower = more diversified). */
  concentration: number;
};

/** Written by agent-marketplace to marketplace.json */
export type MarketplaceReport = {
  schema: 'mm.marketplace/v1';
  timestamp: string;
  agents: number;
  services: number;
  jobsCompleted: number;
  jobsFailed: number;
  grossVolumeUsd: number;
  platformRevenueUsd: number;
  /** Platform revenue events, append-only, used by revenue-engine. */
  revenueEvents: Array<{ id: string; timestamp: string; amountUsd: number; serviceId: string }>;
};

export type MMEvent = {
  ts: string;
  source: string;
  level: 'info' | 'warn' | 'error';
  type: string;
  message: string;
  data?: unknown;
};

// ---------- helpers ----------

export function stateDir(): string {
  return path.resolve(process.env.MM_STATE_DIR ?? '.mm-state');
}

export const statePaths = {
  strategiesDir: () => path.join(stateDir(), 'strategies'),
  strategy: (name: string) => path.join(stateDir(), 'strategies', `${name}.json`),
  proposal: () => path.join(stateDir(), 'allocation-proposal.json'),
  allocations: () => path.join(stateDir(), 'allocations.json'),
  portfolio: () => path.join(stateDir(), 'portfolio.json'),
  revenue: () => path.join(stateDir(), 'revenue.json'),
  marketplace: () => path.join(stateDir(), 'marketplace.json'),
  events: () => path.join(stateDir(), 'events.jsonl'),
  kill: () => path.join(stateDir(), 'KILL'),
};

/** Atomic JSON write (tmp file + rename) so readers never see half-written files. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}

/** Returns fallback when the file is missing or unparseable. Never creates files. */
export async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export async function readStrategyReports(): Promise<StrategyReport[]> {
  let files: string[] = [];
  try {
    files = await fsp.readdir(statePaths.strategiesDir());
  } catch {
    return [];
  }
  const reports: StrategyReport[] = [];
  for (const file of files.filter((f) => f.endsWith('.json')).sort()) {
    const report = await readJsonSafe<StrategyReport | null>(path.join(statePaths.strategiesDir(), file), null);
    if (report?.schema === 'mm.strategy-report/v1') reports.push(report);
  }
  return reports;
}

/** Global kill switch: the KILL file exists in the state dir, or MM_KILL=1. */
export function isKillSwitchActive(): boolean {
  return process.env.MM_KILL === '1' || fs.existsSync(statePaths.kill());
}

/** Budget the orchestrator granted to a strategy; undefined if no allocations exist yet. */
export async function readStrategyBudget(name: string): Promise<{ budgetUsd: number; paused: boolean } | undefined> {
  const alloc = await readJsonSafe<FinalAllocations | null>(statePaths.allocations(), null);
  if (!alloc || alloc.schema !== 'mm.allocations/v1') return undefined;
  return {
    budgetUsd: alloc.killSwitch ? 0 : alloc.allocations[name] ?? 0,
    paused: alloc.killSwitch || alloc.paused.includes(name),
  };
}

export async function emitEvent(event: Omit<MMEvent, 'ts'>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  try {
    await fsp.mkdir(stateDir(), { recursive: true });
    await fsp.appendFile(statePaths.events(), line, 'utf8');
  } catch {
    // event log is best-effort
  }
}
