import { Arena, createGenesisState } from './arena.js';
import type { ArenaConfig } from './config.js';
import { genomeId, type Genome } from './genome.js';
import { ReplayMarket, type ReplaySeries } from './replay-market.js';
import { traderSpecies } from './species/trader.js';
import { agentBalance, agentReturn, type Agent } from './types.js';

/**
 * Historical backtests on a ReplayMarket using the unchanged arena engine
 * (`Arena` with `lifecycle: false` for fixed genomes, full lifecycle for `--evolve`),
 * so decisions, paper fills, write-offs and the ledger are exactly the arena's code.
 */
export type Window = { fromTs: number; toTs: number };
export type Split = { fold: number; train: Window; test: Window };

export type BacktestMetrics = {
  /** Final equity / starting capital − 1, after fees, slippage, price impact and a final paper liquidation. */
  return: number;
  trades: number;
  wins: number;
  winRate: number;
  /** Max peak-to-trough drawdown of the step equity curve (0..1). */
  maxDrawdown: number;
  /** Per-trade Sharpe-like ratio (mean / stdev of trade returns), 0 if < 2 trades. Not annualised. */
  sharpe: number;
  /** Average fraction of equity held in positions per step. */
  exposure: number;
  /** Fraction of steps with at least one open position. */
  timeInMarket: number;
  steps: number;
  /** Trade-return statistics (for merging windows). */
  tradeMean: number;
  tradeM2: number;
};

export type StepRecord = { T: number; balanceUsd: number; cashUsd: number; positions: Array<{ mint: string; quantity: number; entryPriceUsd: number }> };

/**
 * Walk-forward splits with an expanding train window:
 * the last (1 − trainFrac) of the range is cut into `folds` consecutive test windows;
 * fold i trains on [fromTs, testStart_i) and tests on [testStart_i, testEnd_i).
 * Train and test never overlap, and every test window lies strictly after its train window.
 */
export function walkForwardSplits(fromTs: number, toTs: number, stepSec: number, opts: { folds?: number; trainFrac?: number } = {}): Split[] {
  const folds = opts.folds ?? 1;
  const trainFrac = opts.trainFrac ?? 0.7;
  if (!Number.isInteger(folds) || folds < 1) throw new Error('folds must be a positive integer');
  if (!(trainFrac > 0 && trainFrac < 1)) throw new Error('trainFrac must be in (0, 1)');
  const n = Math.floor((toTs - fromTs) / stepSec);
  const testSteps = Math.floor((n * (1 - trainFrac)) / folds);
  const firstTest = n - folds * testSteps;
  if (testSteps < 2 || firstTest < 2) throw new Error(`not enough history for ${folds} fold(s): ${n} steps`);
  const splits: Split[] = [];
  for (let i = 0; i < folds; i++) {
    const testStart = fromTs + (firstTest + i * testSteps) * stepSec;
    splits.push({ fold: i, train: { fromTs, toTs: testStart }, test: { fromTs: testStart, toTs: testStart + testSteps * stepSec } });
  }
  return splits;
}

/** Arena config for replays: market `replay`, no LLM, everything else (fees, slippage, min trade, …) unchanged. */
export function replayConfig(cfg: ArenaConfig, overrides: Partial<ArenaConfig> = {}): ArenaConfig {
  return { ...cfg, market: 'replay', llm: { ...cfg.llm, apiKey: undefined }, ...overrides };
}

const noopEmit = async () => undefined;

function metricsFrom(capital: number, curve: number[], exposures: number[], agent: Agent, arena: Arena): BacktestMetrics {
  let peak = capital;
  let maxDd = 0;
  for (const e of curve) {
    peak = Math.max(peak, e);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - e) / peak);
  }
  const t = arena.state.trades;
  const sd = t.count >= 2 ? Math.sqrt(t.m2 / (t.count - 1)) : 0;
  const final = curve.at(-1) ?? capital;
  return {
    return: capital > 0 ? final / capital - 1 : 0,
    trades: agent.stats.trades,
    wins: agent.stats.wins,
    winRate: agent.stats.trades ? agent.stats.wins / agent.stats.trades : 0,
    maxDrawdown: Math.min(1, maxDd),
    sharpe: sd > 0 ? t.mean / sd : 0,
    exposure: exposures.length ? exposures.reduce((a, b) => a + b, 0) / exposures.length : 0,
    timeInMarket: exposures.length ? exposures.filter((x) => x > 0).length / exposures.length : 0,
    steps: exposures.length,
    tradeMean: t.mean,
    tradeM2: t.m2,
  };
}

export type EvalOptions = {
  cfg: ArenaConfig;
  stepSec: number;
  capitalUsd: number;
  onStep?: (rec: StepRecord) => void;
};

/**
 * Evaluate one fixed genome on [window.fromTs, window.toTs): a single agent, no
 * upkeep/death/reproduction, open positions are paper-sold at the end.
 */
export async function evaluateGenome(genome: Genome, series: ReplaySeries[], window: Window, opts: EvalOptions): Promise<BacktestMetrics> {
  const market = new ReplayMarket(series, { stepSec: opts.stepSec, fromTs: window.fromTs, toTs: window.toTs });
  const cfg = replayConfig(opts.cfg, {
    startingCapitalUsd: opts.capitalUsd,
    seedUsd: opts.capitalUsd,
    deathUsd: 0,
    minPopulation: 0,
    maxPopulation: 1,
    immigrantsPerCycle: 0,
    upkeepUsd: 0,
  });
  const state = createGenesisState(cfg, new Date(window.fromTs * 1000), 'backtest');
  const arena = new Arena(cfg, state, undefined, { market, now: () => market.now(), emit: noopEmit, lifecycle: false });
  const valid = traderSpecies.validate(genome, genome).genome;
  const agent = arena.spawnFromTreasury('designed', valid);
  if (!agent) throw new Error('could not create backtest agent');
  const curve: number[] = [];
  const exposures: number[] = [];
  while (!market.done) {
    await arena.runCycle({ paused: false });
    const balance = agentBalance(agent);
    const deployed = agent.positions.reduce((s, p) => s + p.quantity * p.lastPriceUsd, 0);
    curve.push(balance);
    exposures.push(balance > 0 ? Math.min(1, deployed / balance) : 0);
    opts.onStep?.({
      T: market.now().getTime() / 1000,
      balanceUsd: balance,
      cashUsd: agent.cashUsd,
      positions: agent.positions.map((p) => ({ mint: p.mint, quantity: p.quantity, entryPriceUsd: p.entryPriceUsd })),
    });
  }
  arena.liquidateAll('end-of-data');
  curve.push(agentBalance(agent));
  return metricsFrom(opts.capitalUsd, curve, exposures, agent, arena);
}

/** Combine consecutive windows: returns compound, trades add, drawdown = worst window, Sharpe from merged trade stats. */
export function combineMetrics(parts: BacktestMetrics[]): BacktestMetrics | null {
  if (parts.length === 0) return null;
  let growth = 1;
  let trades = 0;
  let wins = 0;
  let mean = 0;
  let m2 = 0;
  let steps = 0;
  let expo = 0;
  let tim = 0;
  let maxDd = 0;
  for (const p of parts) {
    growth *= 1 + p.return;
    if (p.trades > 0) {
      const n = trades + p.trades;
      const d = p.tradeMean - mean;
      mean += (d * p.trades) / n;
      m2 += p.tradeM2 + (d * d * trades * p.trades) / n;
      trades = n;
    }
    wins += p.wins;
    steps += p.steps;
    expo += p.exposure * p.steps;
    tim += p.timeInMarket * p.steps;
    maxDd = Math.max(maxDd, p.maxDrawdown);
  }
  const sd = trades >= 2 ? Math.sqrt(m2 / (trades - 1)) : 0;
  return {
    return: growth - 1,
    trades,
    wins,
    winRate: trades ? wins / trades : 0,
    maxDrawdown: maxDd,
    sharpe: sd > 0 ? mean / sd : 0,
    exposure: steps ? expo / steps : 0,
    timeInMarket: steps ? tim / steps : 0,
    steps,
    tradeMean: mean,
    tradeM2: m2,
  };
}

export type GenomeBacktest = {
  genomeId: string;
  genome: Genome;
  origin: string;
  /** Genomes evolved on history are only out-of-sample after this time (unix s); -Infinity → null for external genomes. */
  trainedUntilTs: number | null;
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics | null;
  oosWindows: number;
};

/**
 * In-sample = the first fold's train window (for evolved genomes: the train window
 * they evolved on). Out-of-sample = every test window that starts at or after the
 * genome's training end, compounded.
 */
export async function backtestGenome(
  genome: Genome,
  origin: string,
  series: ReplaySeries[],
  splits: Split[],
  opts: EvalOptions,
  trainedUntilTs: number | null = null,
  inSampleWindow?: Window,
): Promise<GenomeBacktest> {
  const valid = traderSpecies.validate(genome, genome).genome;
  const inSample = await evaluateGenome(valid, series, inSampleWindow ?? splits[0]!.train, opts);
  const oosParts: BacktestMetrics[] = [];
  for (const s of splits) {
    if (trainedUntilTs !== null && s.test.fromTs < trainedUntilTs) continue;
    oosParts.push(await evaluateGenome(valid, series, s.test, opts));
  }
  return { genomeId: genomeId(valid), genome: valid, origin, trainedUntilTs, inSample, outOfSample: combineMetrics(oosParts), oosWindows: oosParts.length };
}

export type EvolveOptions = {
  cfg: ArenaConfig;
  stepSec: number;
  seed: string;
  /** Passes over the train window (the population carries over). */
  epochs?: number;
  top?: number;
  log?: (msg: string) => void;
};

export type EvolveResult = { cycles: number; population: number; births: number; deaths: number; maxGeneration: number; top: Array<{ genome: Genome; agentId: string; return: number; trades: number }> };

/**
 * Full evolutionary lifecycle (upkeep, deaths, reproduction, immigrants; no LLM) on
 * the replayed train window with a virtual clock. Returns the best living genomes
 * (≥ 1 closed trade, distinct genome ids) by lifetime return.
 */
export async function evolveOnWindow(series: ReplaySeries[], window: Window, opts: EvolveOptions): Promise<EvolveResult> {
  const cfg = replayConfig(opts.cfg, { seed: opts.seed });
  const state = createGenesisState(cfg, new Date(window.fromTs * 1000), opts.seed);
  let market = new ReplayMarket(series, { stepSec: opts.stepSec, fromTs: window.fromTs, toTs: window.toTs });
  const deps = { market: market as ReplayMarket, now: () => market.now(), emit: noopEmit, log: () => undefined };
  const arena = new Arena(cfg, state, undefined, deps);
  arena.genesis();
  const epochs = opts.epochs ?? 1;
  for (let e = 0; e < epochs; e++) {
    if (e > 0) {
      market = new ReplayMarket(series, { stepSec: opts.stepSec, fromTs: window.fromTs, toTs: window.toTs });
      deps.market = market;
      // a new pass restarts the price history: positions from the last pass are closed at their last price first
      arena.liquidateAll('epoch-end');
    }
    while (!market.done) await arena.runCycle({ paused: false });
    opts.log?.(`[evolve] epoch ${e + 1}/${epochs}: cycle ${state.cycle}, population ${state.agents.length}, max generation ${state.maxGeneration}`);
  }
  arena.liquidateAll('end-of-data');
  const seen = new Set<string>();
  const top: EvolveResult['top'] = [];
  for (const a of [...state.agents].filter((x) => x.stats.trades > 0).sort((x, y) => agentReturn(y) - agentReturn(x) || (x.id < y.id ? -1 : 1))) {
    const id = genomeId(a.genome);
    if (seen.has(id)) continue;
    seen.add(id);
    top.push({ genome: a.genome, agentId: a.id, return: agentReturn(a), trades: a.stats.trades });
    if (top.length >= (opts.top ?? 5)) break;
  }
  return { cycles: state.cycle, population: state.agents.length, births: state.births.total, deaths: state.deathsTotal, maxGeneration: state.maxGeneration, top };
}
