import path from 'node:path';
import { readJsonSafe, stateDir, writeJsonAtomic } from './mm-contract.js';
import type { RngState } from './rng.js';
import type { Agent, DeathCause, Origin } from './types.js';
import type { Genome } from './genome.js';
import type { MarketSourceId } from './market.js';
import { SPECIES } from './species/registry.js';

export type Ledger = {
  initialCapitalUsd: number;
  /** Net capital added (+) or removed (−) to follow the orchestrator budget. */
  adjustmentsUsd: number;
  feesUsd: number;
  upkeepUsd: number;
  /** Includes write-offs of positions that lost their market. */
  realizedLossUsd: number;
  realizedGainUsd: number;
  llmUsd: number;
};

/** Running statistics over closed trades of all agents (Welford). */
export type TradeStats = { count: number; wins: number; mean: number; m2: number; netPnlUsd: number };

export type EquityPoint = { cycle: number; ts: string; equityUsd: number; pnlUsd: number; treasuryUsd: number; population: number };

export type LlmState = {
  totalUsd: number;
  day: string;
  dayUsd: number;
  calls: number;
  refusals: number;
  failures: number;
  designedSpawned: number;
  lastCallCycle: number;
  lastNote?: string;
};

export type CycleCounters = {
  births: number;
  deaths: number;
  entries: number;
  exits: number;
  writeOffs: number;
  marketOk: boolean;
  marketError?: string;
  paused: boolean;
  pauseReason?: string;
  budgetUsd?: number;
  adjustmentUsd: number;
};

export type ArenaState = {
  schema: 'mm.arena-population/v1';
  createdAt: string;
  updatedAt: string;
  cycle: number;
  seed: string;
  rng: RngState;
  nextAgentId: number;
  nextPositionId: number;
  market: MarketSourceId;
  treasuryUsd: number;
  ledger: Ledger;
  agents: Agent[];
  trades: TradeStats;
  births: Record<Origin, number> & { total: number };
  deathsTotal: number;
  lastCycle: CycleCounters;
  maxGeneration: number;
  generationMilestones: number[];
  equityCurve: EquityPoint[];
  perf: { peakUsd: number; maxDrawdown: number };
  llm: LlmState;
};

export type DeadAgent = {
  id: string;
  species: string;
  origin: Origin;
  parentId: string | null;
  generation: number;
  bornCycle: number;
  diedCycle: number;
  bornAt: string;
  diedAt: string;
  cause: DeathCause;
  birthCapitalUsd: number;
  peakBalanceUsd: number;
  /** Cash returned to the treasury after liquidation. */
  returnedUsd: number;
  finalReturn: number;
  trades: number;
  wins: number;
  children: number;
  genome: Genome;
};

export type Graveyard = {
  schema: 'mm.arena-graveyard/v1';
  recent: DeadAgent[];
  aggregate: {
    total: number;
    byCause: Record<string, number>;
    byOrigin: Record<string, number>;
    sumLifespanCycles: number;
    maxLifespanCycles: number;
    sumFinalReturn: number;
    returnedUsd: number;
  };
};

export const arenaPaths = {
  dir: () => path.join(stateDir(), 'arena'),
  population: () => path.join(stateDir(), 'arena', 'population.json'),
  graveyard: () => path.join(stateDir(), 'arena', 'graveyard.json'),
  summary: () => path.join(stateDir(), 'arena', 'summary.json'),
  syntheticMarket: () => path.join(stateDir(), 'arena', 'synthetic-market.json'),
};

export function emptyGraveyard(): Graveyard {
  return {
    schema: 'mm.arena-graveyard/v1',
    recent: [],
    aggregate: { total: 0, byCause: {}, byOrigin: {}, sumLifespanCycles: 0, maxLifespanCycles: 0, sumFinalReturn: 0, returnedUsd: 0 },
  };
}

export function emptyCounters(): CycleCounters {
  return { births: 0, deaths: 0, entries: 0, exits: 0, writeOffs: 0, marketOk: true, paused: false, adjustmentUsd: 0 };
}

/** Load persisted state; genomes are re-validated so a hand-edited file cannot break bounds. */
export async function loadState(): Promise<{ state?: ArenaState; graveyard: Graveyard }> {
  const state = await readJsonSafe<ArenaState | null>(arenaPaths.population(), null);
  const graveyard = await readJsonSafe<Graveyard | null>(arenaPaths.graveyard(), null);
  const validGraveyard = graveyard?.schema === 'mm.arena-graveyard/v1' ? graveyard : emptyGraveyard();
  if (!state || state.schema !== 'mm.arena-population/v1') return { graveyard: validGraveyard };
  const unknown = state.agents.find((a) => SPECIES[a.species] === undefined);
  if (unknown) throw new Error(`population.json contains unknown species "${unknown.species}"`);
  for (const a of state.agents) {
    const species = SPECIES[a.species]!;
    a.genome = species.validate(a.genome, a.genome).genome;
  }
  return { state, graveyard: validGraveyard };
}

export async function saveState(state: ArenaState, graveyard: Graveyard): Promise<void> {
  await writeJsonAtomic(arenaPaths.population(), state);
  await writeJsonAtomic(arenaPaths.graveyard(), graveyard);
}
