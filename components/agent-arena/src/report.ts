import { STRATEGY_NAME, type ArenaConfig } from './config.js';
import { arenaEquity } from './arena.js';
import type { StrategyReport } from './mm-contract.js';
import { SYNTHETIC_NOTE } from './synthetic-market.js';
import type { ArenaState, Graveyard } from './state.js';
import { agentBalance, agentReturn } from './types.js';
import type { Genome } from './genome.js';

const round = (x: number, digits = 6) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
const usd = (x: number) => `$${x.toFixed(2)}`;

export type ArenaMetrics = {
  equityUsd: number;
  deployedUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  contributedUsd: number;
  totalReturn: number;
  winRate: number;
  avgProfit: number;
  sharpeRatio: number;
  totalTrades: number;
  openPositions: number;
  maxDrawdown: number;
};

/**
 * Arena-wide metrics. unrealized = Σ(marked value − cash spent) over open positions;
 * realized = total PnL − unrealized, so it includes closed trades, fees, upkeep and
 * LLM cost. Budget flows (adjustments) are excluded from PnL.
 */
export function computeMetrics(state: ArenaState): ArenaMetrics {
  const equityUsd = arenaEquity(state);
  let deployed = 0;
  let unrealized = 0;
  let open = 0;
  for (const a of state.agents) {
    for (const p of a.positions) {
      const v = p.quantity * p.lastPriceUsd;
      deployed += v;
      unrealized += v - p.sizeUsd;
      open++;
    }
  }
  const contributed = state.ledger.initialCapitalUsd + state.ledger.adjustmentsUsd;
  const pnl = equityUsd - contributed;
  const t = state.trades;
  const sd = t.count >= 2 ? Math.sqrt(t.m2 / (t.count - 1)) : 0;
  return {
    equityUsd,
    deployedUsd: deployed,
    realizedPnlUsd: pnl - unrealized,
    unrealizedPnlUsd: unrealized,
    contributedUsd: contributed,
    totalReturn: contributed > 0 ? pnl / contributed : 0,
    winRate: t.count ? t.wins / t.count : 0,
    avgProfit: t.count ? t.mean : 0,
    sharpeRatio: sd > 0 ? t.mean / sd : 0,
    totalTrades: t.count,
    openPositions: open,
    maxDrawdown: state.perf.maxDrawdown,
  };
}

export function buildNotes(state: ArenaState, cfg: ArenaConfig): string[] {
  const c = state.lastCycle;
  const notes = [
    'PAPER ONLY: every fill is simulated (fees + slippage + liquidity price impact); agent-arena has no real-money execution path',
    `market source: ${state.market}`,
    `population ${state.agents.length} (min ${cfg.minPopulation}, max ${cfg.maxPopulation}), max generation ${state.maxGeneration}`,
    `births total ${state.births.total} (last cycle ${c.births}), deaths total ${state.deathsTotal} (last cycle ${c.deaths})`,
    `treasury ${usd(state.treasuryUsd)}; cumulative upkeep ${usd(state.ledger.upkeepUsd)}, fees ${usd(state.ledger.feesUsd)}, LLM ${usd(state.ledger.llmUsd)}`,
    'realizedPnlUsd includes closed trades, fees, agent upkeep and LLM cost',
  ];
  if (state.market === 'synthetic') notes.push(SYNTHETIC_NOTE);
  if (!c.marketOk) notes.push(`market fetch failed (${c.marketError ?? 'unknown'}): no new entries this cycle`);
  if (c.paused) notes.push(`paused (${c.pauseReason ?? 'paused'}): no new entries and no births; exits still run`);
  if (c.budgetUsd === undefined) notes.push(`no allocations.json yet; using ARENA_STARTING_CAPITAL_USD ${usd(cfg.startingCapitalUsd)}`);
  else notes.push(`orchestrator budget ${usd(c.budgetUsd)}${c.adjustmentUsd ? ` (adjusted ${c.adjustmentUsd > 0 ? '+' : ''}${usd(c.adjustmentUsd)} this cycle)` : ''}`);
  return notes;
}

export function buildStrategyReport(state: ArenaState, cfg: ArenaConfig, now: Date): StrategyReport {
  const m = computeMetrics(state);
  return {
    schema: 'mm.strategy-report/v1',
    name: STRATEGY_NAME,
    kind: 'trading',
    mode: 'paper',
    status: state.lastCycle.paused ? 'paused' : 'active',
    capitalUsd: round(m.equityUsd, 2),
    deployedUsd: round(Math.min(m.deployedUsd, m.equityUsd), 2),
    realizedPnlUsd: round(m.realizedPnlUsd, 2),
    unrealizedPnlUsd: round(m.unrealizedPnlUsd, 2),
    totalReturn: round(m.totalReturn),
    winRate: round(m.winRate),
    avgProfit: round(m.avgProfit),
    maxDrawdown: round(m.maxDrawdown),
    sharpeRatio: round(m.sharpeRatio, 4),
    totalTrades: m.totalTrades,
    openPositions: m.openPositions,
    lastUpdated: now.toISOString(),
    notes: buildNotes(state, cfg),
  };
}

export type LeaderboardRow = {
  id: string;
  species: string;
  origin: string;
  generation: number;
  balanceUsd: number;
  return: number;
  ageCycles: number;
  trades: number;
  winRate: number;
  children: number;
  openPositions: number;
  genome: Genome;
};

export type ArenaSummary = {
  schema: 'mm.arena-summary/v1';
  timestamp: string;
  cycle: number;
  mode: 'paper';
  marketSource: string;
  marketOk: boolean;
  notes: string[];
  population: number;
  births: { total: number; lastCycle: number; byOrigin: Record<string, number> };
  deaths: { total: number; lastCycle: number };
  maxGeneration: number;
  treasuryUsd: number;
  equityUsd: number;
  pnlUsd: number;
  metrics: ArenaMetrics;
  equityCurve: ArenaState['equityCurve'];
  leaderboard: LeaderboardRow[];
  species: Record<string, { population: number; avgBalanceUsd: number; avgReturn: number; maxGeneration: number; avgGeneration: number; trades: number; winRate: number }>;
  causesOfDeath: Record<string, number>;
  graveyard: { total: number; avgLifespanCycles: number; maxLifespanCycles: number; avgFinalReturn: number };
  llm: { enabled: boolean; totalUsd: number; todayUsd: number; dailyBudgetUsd: number; calls: number; refusals: number; failures: number; designedSpawned: number; lastNote?: string };
};

export function leaderboard(state: ArenaState, n = 10): LeaderboardRow[] {
  return state.agents
    .map((a) => ({ a, ret: agentReturn(a), bal: agentBalance(a) }))
    .sort((x, y) => y.ret - x.ret || y.bal - x.bal || (x.a.id < y.a.id ? -1 : 1))
    .slice(0, n)
    .map(({ a, ret, bal }) => ({
      id: a.id,
      species: a.species,
      origin: a.origin,
      generation: a.generation,
      balanceUsd: round(bal, 4),
      return: round(ret, 4),
      ageCycles: state.cycle - a.bornCycle,
      trades: a.stats.trades,
      winRate: a.stats.trades ? round(a.stats.wins / a.stats.trades, 4) : 0,
      children: a.children,
      openPositions: a.positions.length,
      genome: Object.fromEntries(Object.entries(a.genome).map(([k, v]) => [k, Number(v.toPrecision(5))])),
    }));
}

export function buildSummary(state: ArenaState, graveyard: Graveyard, cfg: ArenaConfig, now: Date): ArenaSummary {
  const m = computeMetrics(state);
  const species: ArenaSummary['species'] = {};
  const acc: Record<string, { n: number; bal: number; ret: number; maxGen: number; sumGen: number; trades: number; wins: number }> = {};
  for (const a of state.agents) {
    const s = (acc[a.species] ??= { n: 0, bal: 0, ret: 0, maxGen: 0, sumGen: 0, trades: 0, wins: 0 });
    s.n++;
    s.bal += agentBalance(a);
    s.ret += agentReturn(a);
    s.maxGen = Math.max(s.maxGen, a.generation);
    s.sumGen += a.generation;
    s.trades += a.stats.trades;
    s.wins += a.stats.wins;
  }
  for (const [id, s] of Object.entries(acc)) {
    species[id] = {
      population: s.n,
      avgBalanceUsd: round(s.bal / s.n, 4),
      avgReturn: round(s.ret / s.n, 4),
      maxGeneration: s.maxGen,
      avgGeneration: round(s.sumGen / s.n, 2),
      trades: s.trades,
      winRate: s.trades ? round(s.wins / s.trades, 4) : 0,
    };
  }
  const agg = graveyard.aggregate;
  return {
    schema: 'mm.arena-summary/v1',
    timestamp: now.toISOString(),
    cycle: state.cycle,
    mode: 'paper',
    marketSource: state.market,
    marketOk: state.lastCycle.marketOk,
    notes: buildNotes(state, cfg),
    population: state.agents.length,
    births: {
      total: state.births.total,
      lastCycle: state.lastCycle.births,
      byOrigin: { genesis: state.births.genesis, spawn: state.births.spawn, birth: state.births.birth, designed: state.births.designed },
    },
    deaths: { total: state.deathsTotal, lastCycle: state.lastCycle.deaths },
    maxGeneration: state.maxGeneration,
    treasuryUsd: round(state.treasuryUsd, 4),
    equityUsd: round(m.equityUsd, 4),
    pnlUsd: round(m.equityUsd - m.contributedUsd, 4),
    metrics: m,
    equityCurve: state.equityCurve.slice(-cfg.equityCurveMax),
    leaderboard: leaderboard(state, 10),
    species,
    causesOfDeath: { ...agg.byCause },
    graveyard: {
      total: agg.total,
      avgLifespanCycles: agg.total ? round(agg.sumLifespanCycles / agg.total, 2) : 0,
      maxLifespanCycles: agg.maxLifespanCycles,
      avgFinalReturn: agg.total ? round(agg.sumFinalReturn / agg.total, 4) : 0,
    },
    llm: {
      enabled: Boolean(cfg.llm.apiKey),
      totalUsd: round(state.llm.totalUsd, 6),
      todayUsd: round(state.llm.dayUsd, 6),
      dailyBudgetUsd: cfg.llm.dailyBudgetUsd,
      calls: state.llm.calls,
      refusals: state.llm.refusals,
      failures: state.llm.failures,
      designedSpawned: state.llm.designedSpawned,
      ...(state.llm.lastNote ? { lastNote: state.llm.lastNote } : {}),
    },
  };
}
