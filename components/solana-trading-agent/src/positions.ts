import path from 'node:path';
import { readJsonSafe, stateDir, writeJsonAtomic, type RunMode } from './mm-contract.js';
import { STRATEGY_NAME } from './config.js';
import type { ExitReason } from './exit.js';
import type { ExitRules } from './config.js';

export type Position = {
  id: string;
  mint: string;
  symbol: string;
  pairAddress?: string;
  status: 'open' | 'closed';
  mode: RunMode;
  /** true for paper fills — no real transaction happened. */
  simulated: boolean;
  openedAt: string;
  /** Effective entry price per token (cost basis incl. fees / quantity). */
  entryPriceUsd: number;
  /** USD spent to open the position, including fees. */
  sizeUsd: number;
  quantity: number;
  /** Raw on-chain token amount (live only), as a string to keep full precision. */
  quantityRaw?: string;
  highestPriceUsd: number;
  lastPriceUsd: number;
  lastPriceAt: string;
  entryTx?: string;
  closedAt?: string;
  exitPriceUsd?: number;
  proceedsUsd?: number;
  realizedPnlUsd?: number;
  /** realizedPnlUsd / sizeUsd */
  returnPct?: number;
  exitReason?: ExitReason;
  exitTx?: string;
  /** Strategy that opened the position: 'static' or an arena genome id (absent on positions from older versions). */
  strategyId?: string;
  /**
   * Exit rules frozen at entry for positions opened by a promoted arena strategy, so a
   * later strategy switch never changes them retroactively. Absent = the current static
   * env exits apply (today's behaviour).
   */
  exitRules?: ExitRules;
};

export type EquityPoint = { ts: string; equityUsd: number };

export type TraderState = {
  schema: 'solana-trader.state/v1';
  positions: Position[];
  equityCurve: EquityPoint[];
  /** Running max drawdown, survives equity curve truncation. */
  maxDrawdown: number;
  /** Strategy id used in the last cycle (to detect and log switches). */
  strategyId?: string;
  updatedAt?: string;
};

export const MAX_EQUITY_POINTS = 5_000;

export function emptyState(): TraderState {
  return { schema: 'solana-trader.state/v1', positions: [], equityCurve: [], maxDrawdown: 0 };
}

/** Paper and live positions are kept in separate files so they can never be mixed up. */
export function positionsPath(mode: RunMode): string {
  const file = mode === 'live' ? 'positions.live.json' : 'positions.json';
  return path.join(stateDir(), STRATEGY_NAME, file);
}

export async function loadState(mode: RunMode): Promise<TraderState> {
  const state = await readJsonSafe<TraderState | null>(positionsPath(mode), null);
  if (!state || state.schema !== 'solana-trader.state/v1' || !Array.isArray(state.positions)) return emptyState();
  return { ...emptyState(), ...state };
}

export async function saveState(mode: RunMode, state: TraderState): Promise<void> {
  if (state.equityCurve.length > MAX_EQUITY_POINTS) state.equityCurve = state.equityCurve.slice(-MAX_EQUITY_POINTS);
  await writeJsonAtomic(positionsPath(mode), { ...state, updatedAt: new Date().toISOString() });
}

export const openPositions = (state: TraderState) => state.positions.filter((p) => p.status === 'open');
export const closedPositions = (state: TraderState) => state.positions.filter((p) => p.status === 'closed');
/** Capital currently tied up in open positions, at cost. */
export const deployedUsd = (state: TraderState) => openPositions(state).reduce((sum, p) => sum + p.sizeUsd, 0);

/** Record a price observation on an open position. */
export function markPrice(position: Position, priceUsd: number, at: Date): void {
  position.lastPriceUsd = priceUsd;
  position.lastPriceAt = at.toISOString();
  position.highestPriceUsd = Math.max(position.highestPriceUsd, priceUsd);
}

export function closePosition(
  position: Position,
  fill: { priceUsd: number; proceedsUsd: number; tx?: string },
  reason: ExitReason,
  at: Date,
): void {
  position.status = 'closed';
  position.closedAt = at.toISOString();
  position.exitPriceUsd = fill.priceUsd;
  position.proceedsUsd = fill.proceedsUsd;
  position.realizedPnlUsd = fill.proceedsUsd - position.sizeUsd;
  position.returnPct = position.sizeUsd > 0 ? position.realizedPnlUsd / position.sizeUsd : 0;
  position.exitReason = reason;
  position.exitTx = fill.tx;
}
