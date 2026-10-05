import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FetchLike } from './http.js';
import type { StrategyReport } from './mm-contract.js';
import type { RevenueEvent } from './types.js';

export async function useTempStateDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'revenue-engine-test-'));
  process.env.MM_STATE_DIR = dir;
  return dir;
}

export function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), 'utf8'));
}

export function ev(partial: Partial<RevenueEvent> & { id: string }): RevenueEvent {
  return {
    stream: 's',
    kind: 'other',
    amountUsd: 1,
    timestamp: '2026-10-01T00:00:00.000Z',
    source: 'test',
    simulated: false,
    ...partial,
  };
}

export function strategyReport(partial: Partial<StrategyReport> & { name: string }): StrategyReport {
  return {
    schema: 'mm.strategy-report/v1',
    kind: 'trading',
    mode: 'paper',
    status: 'active',
    capitalUsd: 1000,
    deployedUsd: 0,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    totalReturn: 0,
    winRate: 0,
    avgProfit: 0,
    maxDrawdown: 0,
    sharpeRatio: 0,
    totalTrades: 0,
    openPositions: 0,
    lastUpdated: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

/** Fixture fetch: routes by URL predicate, records every requested URL. */
export function fixtureFetch(routes: Array<{ match: (url: string) => boolean; status?: number; body: unknown }>) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const route = routes.find((r) => r.match(url));
    const status = route ? route.status ?? 200 : 404;
    const body = route ? route.body : { error: 'no fixture' };
    return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { fetchImpl, calls };
}
