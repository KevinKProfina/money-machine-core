import path from 'node:path';
import { readJsonSafe, stateDir, writeJsonAtomic } from './mm-contract.js';
import { emptyLedger, type Ledger } from './reinvestment.js';

export type HistoryEntry = {
  ts: string;
  totalCapitalUsd: number;
  equityUsd: number;
  drawdown: number;
  realProfitDeltaUsd: number;
  simulatedProfitDeltaUsd: number;
  reinvestedUsd: number;
  anyLive: boolean;
  allocatedUsd: number;
  killSwitch: boolean;
};

/** Orchestrator-private persisted state ($MM_STATE_DIR/orchestrator/state.json). */
export type OrchestratorState = {
  schema: 'mm.orchestrator-state/v1';
  updatedAt: string | null;
  /** Ledger of real profit (live strategies, non-simulated revenue). */
  real: Ledger;
  /** Ledger of simulated profit (paper/dry-run strategies, simulated revenue). */
  simulated: Ledger;
  /**
   * Equity high-water marks; 0 = unset (next cycle re-anchors). `combined` is used while everything
   * is simulated, `real` once any strategy runs live.
   */
  highWaterMarkUsd: { combined: number; real: number };
  maxDrawdownSeen: number;
  /** Last observed realizedPnlUsd per strategy (baseline for deltas). */
  lastRealizedPnlByStrategy: Record<string, number>;
  /** Last observed totalUsd per counted (non-trading) revenue stream. */
  lastRevenueByStream: Record<string, number>;
  killSwitch: { tripped: boolean; reason: string | null; at: string | null };
  history: HistoryEntry[];
};

export const HISTORY_LIMIT = 500;

export function orchestratorStatePath(): string {
  return path.join(stateDir(), 'orchestrator', 'state.json');
}

export function initialState(): OrchestratorState {
  return {
    schema: 'mm.orchestrator-state/v1',
    updatedAt: null,
    real: emptyLedger(),
    simulated: emptyLedger(),
    highWaterMarkUsd: { combined: 0, real: 0 },
    maxDrawdownSeen: 0,
    lastRealizedPnlByStrategy: {},
    lastRevenueByStream: {},
    killSwitch: { tripped: false, reason: null, at: null },
    history: [],
  };
}

export async function loadState(): Promise<OrchestratorState> {
  const raw = await readJsonSafe<Partial<OrchestratorState> | null>(orchestratorStatePath(), null);
  if (!raw || raw.schema !== 'mm.orchestrator-state/v1') return initialState();
  const init = initialState();
  return {
    ...init,
    ...raw,
    real: { ...init.real, ...raw.real },
    simulated: { ...init.simulated, ...raw.simulated },
    highWaterMarkUsd: { ...init.highWaterMarkUsd, ...raw.highWaterMarkUsd },
    killSwitch: { ...init.killSwitch, ...raw.killSwitch },
  };
}

export async function saveState(state: OrchestratorState): Promise<void> {
  await writeJsonAtomic(orchestratorStatePath(), state);
}
