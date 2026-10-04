import type { Genome, GenomeSpec, ValidationResult } from './genome.js';
import type { MarketSnapshot } from './market.js';
import type { Rng } from './rng.js';

export type Origin = 'genesis' | 'spawn' | 'birth' | 'designed';
export type DeathCause = 'bankrupt' | 'budget-levy';

export type Position = {
  id: string;
  mint: string;
  symbol: string;
  quantity: number;
  /** Cash the agent spent, including the entry fee. */
  sizeUsd: number;
  /** Ledger cost basis = sizeUsd − entry fee (the fee is booked separately). */
  costBasisUsd: number;
  /** Effective fill price incl. slippage + impact (before fee). */
  entryPriceUsd: number;
  lastPriceUsd: number;
  peakPriceUsd: number;
  lastLiquidityUsd: number;
  openedCycle: number;
  lastPricedCycle: number;
};

export type AgentStats = {
  trades: number;
  wins: number;
  realizedPnlUsd: number;
  upkeepPaidUsd: number;
  feesPaidUsd: number;
};

export type Agent = {
  id: string;
  species: string;
  genome: Genome;
  origin: Origin;
  parentId: string | null;
  generation: number;
  bornCycle: number;
  bornAt: string;
  /** Capital the agent received at birth (fitness baseline, reproduction threshold). */
  birthCapitalUsd: number;
  cashUsd: number;
  /** Upkeep the agent could not pay from cash yet (settled from the next proceeds). */
  debtUsd: number;
  /** Capital handed to children so far (counts towards the agent's fitness). */
  givenUsd: number;
  peakBalanceUsd: number;
  positions: Position[];
  cooldownUntil: number;
  children: number;
  stats: AgentStats;
};

export type Intent =
  | { kind: 'sell'; positionId: string; reason: string }
  | { kind: 'buy'; mint: string; sizeUsd: number; reason: string };

export type ActContext = {
  cycle: number;
  snapshot: MarketSnapshot;
  /** false when killed/paused or the market fetch failed: exits only. */
  allowEntries: boolean;
  /** cash − debt + marked positions. */
  balanceUsd: number;
  minTradeUsd: number;
};

/**
 * A species defines a genome layout and how an agent of that species acts.
 * Species never move money themselves: they return intents, and the arena engine
 * executes them against the shared ledger, so the money-conservation invariant
 * holds for every species.
 */
export interface Species {
  readonly id: string;
  readonly description: string;
  readonly genomeSpec: GenomeSpec;
  randomGenome(rng: Rng): Genome;
  mutate(genome: Genome, rng: Rng, rate: number): Genome;
  crossover?(a: Genome, b: Genome, rng: Rng): Genome;
  /** Coerce untrusted input (persisted state, LLM output) into a valid, bounded genome. */
  validate(input: unknown, fill: Genome): ValidationResult;
  act(agent: Agent, ctx: ActContext): Intent[];
}

export function agentBalance(agent: Agent): number {
  let v = agent.cashUsd - agent.debtUsd;
  for (const p of agent.positions) v += p.quantity * p.lastPriceUsd;
  return v;
}

/** Lifetime fitness: (balance + capital given to children − birth capital) / birth capital. */
export function agentReturn(agent: Agent): number {
  return agent.birthCapitalUsd > 0 ? (agentBalance(agent) + agent.givenUsd - agent.birthCapitalUsd) / agent.birthCapitalUsd : 0;
}
