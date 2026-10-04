import type { ArenaConfig } from './config.js';
import { STRATEGY_NAME } from './config.js';
import type { Genome } from './genome.js';
import type { MarketSnapshot, MarketSource } from './market.js';
import { failedSnapshot } from './market.js';
import type { MMEvent } from './mm-contract.js';
import { runMutator, type GenomeStat, type LlmClient } from './mutator.js';
import { PoolFlow, paperBuy, paperSell } from './paper.js';
import { Rng } from './rng.js';
import { getSpecies } from './species/registry.js';
import { emptyCounters, emptyGraveyard, type ArenaState, type DeadAgent, type Graveyard } from './state.js';
import { agentBalance, agentReturn, type Agent, type DeathCause, type Origin, type Position } from './types.js';

export type EmitFn = (event: Omit<MMEvent, 'ts'>) => Promise<void>;

export type ArenaControl = {
  /** Kill switch or orchestrator pause: no entries, no births; exits still run. */
  paused: boolean;
  pauseReason?: string;
  /** Orchestrator budget; undefined when allocations.json does not exist yet. */
  budgetUsd?: number;
};

export type ArenaDeps = {
  market: MarketSource;
  now: () => Date;
  emit: EmitFn;
  log?: (msg: string) => void;
  llm?: LlmClient;
};

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

const GENERATION_MILESTONES = [2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
const DEFAULT_SPECIES = 'trader';

export function createGenesisState(cfg: ArenaConfig, now: Date, seed: string): ArenaState {
  const rng = new Rng(seed);
  return {
    schema: 'mm.arena-population/v1',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    cycle: 0,
    seed,
    rng: rng.state,
    nextAgentId: 1,
    nextPositionId: 1,
    market: cfg.market,
    treasuryUsd: cfg.startingCapitalUsd,
    ledger: {
      initialCapitalUsd: cfg.startingCapitalUsd,
      adjustmentsUsd: 0,
      feesUsd: 0,
      upkeepUsd: 0,
      realizedLossUsd: 0,
      realizedGainUsd: 0,
      llmUsd: 0,
    },
    agents: [],
    trades: { count: 0, wins: 0, mean: 0, m2: 0, netPnlUsd: 0 },
    births: { total: 0, genesis: 0, spawn: 0, birth: 0, designed: 0 },
    deathsTotal: 0,
    lastCycle: emptyCounters(),
    maxGeneration: 0,
    generationMilestones: [],
    equityCurve: [],
    perf: { peakUsd: cfg.startingCapitalUsd, maxDrawdown: 0 },
    llm: { totalUsd: 0, day: '', dayUsd: 0, calls: 0, refusals: 0, failures: 0, designedSpawned: 0, lastCallCycle: 0 },
  };
}

/** Money conservation terms. lhs must equal rhs (initial capital + budget adjustments). */
export function conservation(state: ArenaState): { lhs: number; rhs: number; diff: number } {
  const L = state.ledger;
  let lhs = state.treasuryUsd + L.feesUsd + L.upkeepUsd + L.realizedLossUsd + L.llmUsd - L.realizedGainUsd;
  for (const a of state.agents) {
    lhs += a.cashUsd;
    for (const p of a.positions) lhs += p.costBasisUsd;
  }
  const rhs = L.initialCapitalUsd + L.adjustmentsUsd;
  return { lhs, rhs, diff: lhs - rhs };
}

export function arenaEquity(state: ArenaState): number {
  let eq = state.treasuryUsd;
  for (const a of state.agents) {
    eq += a.cashUsd;
    for (const p of a.positions) eq += p.quantity * p.lastPriceUsd;
  }
  return eq;
}

export type CycleResult = { cycle: number; snapshot: MarketSnapshot; equityUsd: number; populationStart: number };

export class Arena {
  readonly rng: Rng;
  private flow = new PoolFlow();
  private snapshot: MarketSnapshot;
  private levied = new Set<string>();

  constructor(
    readonly cfg: ArenaConfig,
    readonly state: ArenaState,
    readonly graveyard: Graveyard = emptyGraveyard(),
    private readonly deps: ArenaDeps,
  ) {
    this.rng = new Rng(state.rng);
    this.snapshot = failedSnapshot(cfg.market, 'no snapshot yet', deps.now());
  }

  private log(msg: string) {
    this.deps.log?.(msg);
  }

  private nowIso(): string {
    return this.deps.now().toISOString();
  }

  get costs() {
    return { feeBps: this.cfg.feeBps, slippageBps: this.cfg.slippageBps };
  }

  // ---------------------------------------------------------------- lifecycle

  private newAgent(origin: Origin, genome: Genome, capitalUsd: number, parent?: Agent, species = DEFAULT_SPECIES): Agent {
    const s = this.state;
    const agent: Agent = {
      id: `a${s.nextAgentId++}`,
      species,
      genome,
      origin,
      parentId: parent?.id ?? null,
      generation: parent ? parent.generation + 1 : 0,
      bornCycle: s.cycle,
      bornAt: this.nowIso(),
      birthCapitalUsd: capitalUsd,
      cashUsd: capitalUsd,
      debtUsd: 0,
      givenUsd: 0,
      peakBalanceUsd: capitalUsd,
      positions: [],
      cooldownUntil: 0,
      children: 0,
      stats: { trades: 0, wins: 0, realizedPnlUsd: 0, upkeepPaidUsd: 0, feesPaidUsd: 0 },
    };
    s.agents.push(agent);
    s.births[origin]++;
    s.births.total++;
    s.lastCycle.births++;
    if (agent.generation > s.maxGeneration) s.maxGeneration = agent.generation;
    return agent;
  }

  /** Spawn an agent paid from the treasury. Returns undefined if the treasury cannot pay or the cap is reached. */
  spawnFromTreasury(origin: 'genesis' | 'spawn' | 'designed', genome?: Genome): Agent | undefined {
    const s = this.state;
    if (s.agents.length >= this.cfg.maxPopulation) return undefined;
    if (s.treasuryUsd + 1e-12 < this.cfg.seedUsd) return undefined;
    const species = getSpecies(DEFAULT_SPECIES);
    s.treasuryUsd -= this.cfg.seedUsd;
    return this.newAgent(origin, genome ?? species.randomGenome(this.rng), this.cfg.seedUsd);
  }

  /** Initial population: min population (or what the treasury can afford). */
  genesis(): void {
    for (let i = 0; i < this.cfg.minPopulation; i++) if (!this.spawnFromTreasury('genesis')) break;
  }

  private settleDebt(agent: Agent) {
    if (agent.debtUsd <= 0 || agent.cashUsd <= 0) return;
    const pay = Math.min(agent.cashUsd, agent.debtUsd);
    agent.cashUsd -= pay;
    agent.debtUsd -= pay;
    agent.stats.upkeepPaidUsd += pay;
    this.state.ledger.upkeepUsd += pay;
  }

  private chargeUpkeep(agent: Agent) {
    agent.debtUsd += this.cfg.upkeepUsd;
    this.settleDebt(agent);
  }

  private markToMarket() {
    const { cycle } = this.state;
    for (const a of this.state.agents) {
      for (const p of a.positions) {
        const t = this.snapshot.tokens.get(p.mint);
        if (!t || !(t.priceUsd > 0)) continue;
        p.lastPriceUsd = t.priceUsd;
        p.peakPriceUsd = Math.max(p.peakPriceUsd, t.priceUsd);
        p.lastLiquidityUsd = t.liquidityUsd;
        p.lastPricedCycle = cycle;
      }
    }
  }

  /** Follow the orchestrator budget: equity target = budget; the treasury absorbs the difference. */
  private followBudget(budgetUsd: number) {
    const s = this.state;
    const delta = budgetUsd - arenaEquity(s);
    if (Math.abs(delta) < 0.01) return;
    if (delta > 0) {
      s.treasuryUsd += delta;
      s.ledger.adjustmentsUsd += delta;
      s.lastCycle.adjustmentUsd += delta;
      return;
    }
    let need = -delta;
    const fromTreasury = Math.min(s.treasuryUsd, need);
    s.treasuryUsd -= fromTreasury;
    s.ledger.adjustmentsUsd -= fromTreasury;
    s.lastCycle.adjustmentUsd -= fromTreasury;
    need -= fromTreasury;
    if (need <= 1e-9) return;
    // Treasury empty: levy agents' free cash proportionally (open positions are not force-sold).
    const totalCash = s.agents.reduce((sum, a) => sum + a.cashUsd, 0);
    if (totalCash <= 0) return;
    const f = Math.min(1, need / totalCash);
    for (const a of s.agents) {
      const levy = a.cashUsd * f;
      if (levy <= 0) continue;
      a.cashUsd -= levy;
      s.ledger.adjustmentsUsd -= levy;
      s.lastCycle.adjustmentUsd -= levy;
      this.levied.add(a.id);
    }
    if (f >= 1) this.log(`[budget] budget $${budgetUsd.toFixed(2)} is below open position value; positions are kept until exit`);
  }

  // ---------------------------------------------------------------- trading

  private closePosition(agent: Agent, p: Position, reason: string): boolean {
    const L = this.state.ledger;
    const priced = p.lastPricedCycle === this.state.cycle;
    if (priced) {
      const fill = paperSell(p.quantity, p.lastPriceUsd, p.lastLiquidityUsd, this.costs, this.flow.sellFlow(p.mint));
      this.flow.addSell(p.mint, p.quantity * p.lastPriceUsd);
      L.feesUsd += fill.feeUsd;
      const ledgerPnl = fill.grossUsd - p.costBasisUsd;
      if (ledgerPnl >= 0) L.realizedGainUsd += ledgerPnl;
      else L.realizedLossUsd += -ledgerPnl;
      agent.cashUsd += fill.proceedsUsd;
      agent.stats.feesPaidUsd += fill.feeUsd;
      this.recordTrade(agent, fill.proceedsUsd - p.sizeUsd, p.sizeUsd);
    } else {
      // No market for this token: write the position off at zero (never invent a price).
      L.realizedLossUsd += p.costBasisUsd;
      this.recordTrade(agent, -p.sizeUsd, p.sizeUsd);
      this.state.lastCycle.writeOffs++;
    }
    agent.positions = agent.positions.filter((x) => x !== p);
    this.settleDebt(agent);
    const cooldown = agent.genome.cooldownCycles ?? 0;
    agent.cooldownUntil = this.state.cycle + 1 + cooldown;
    this.state.lastCycle.exits++;
    this.log(`[trade] ${agent.id} closed ${p.symbol} (${reason}${priced ? '' : ', written off: no price'})`);
    return priced;
  }

  private recordTrade(agent: Agent, netPnlUsd: number, sizeUsd: number) {
    const ret = sizeUsd > 0 ? netPnlUsd / sizeUsd : 0;
    const t = this.state.trades;
    t.count++;
    if (netPnlUsd > 0) t.wins++;
    const d = ret - t.mean;
    t.mean += d / t.count;
    t.m2 += d * (ret - t.mean);
    t.netPnlUsd += netPnlUsd;
    agent.stats.trades++;
    if (netPnlUsd > 0) agent.stats.wins++;
    agent.stats.realizedPnlUsd += netPnlUsd;
  }

  private openPosition(agent: Agent, mint: string, requestedUsd: number): boolean {
    const t = this.snapshot.tokens.get(mint);
    if (!t || !(t.priceUsd > 0)) return false;
    if (agent.positions.some((p) => p.mint === mint)) return false;
    const reserve = this.cfg.upkeepUsd * 10;
    const sizeUsd = Math.min(requestedUsd, agent.cashUsd - reserve);
    if (!(sizeUsd >= this.cfg.minTradeUsd) || sizeUsd <= 0) return false;
    const fill = paperBuy(t.priceUsd, t.liquidityUsd, sizeUsd, this.costs, this.flow.buyFlow(mint));
    this.flow.addBuy(mint, sizeUsd);
    agent.cashUsd -= sizeUsd;
    this.state.ledger.feesUsd += fill.feeUsd;
    agent.stats.feesPaidUsd += fill.feeUsd;
    agent.positions.push({
      id: `p${this.state.nextPositionId++}`,
      mint,
      symbol: t.symbol,
      quantity: fill.quantity,
      sizeUsd,
      costBasisUsd: sizeUsd - fill.feeUsd,
      entryPriceUsd: fill.fillPriceUsd,
      lastPriceUsd: t.priceUsd,
      peakPriceUsd: t.priceUsd,
      lastLiquidityUsd: t.liquidityUsd,
      openedCycle: this.state.cycle,
      lastPricedCycle: this.state.cycle,
    });
    this.state.lastCycle.entries++;
    return true;
  }

  private actAll(allowEntries: boolean) {
    const order = this.rng.shuffle([...this.state.agents]);
    for (const agent of order) {
      const species = getSpecies(agent.species);
      const intents = species.act(agent, {
        cycle: this.state.cycle,
        snapshot: this.snapshot,
        allowEntries,
        balanceUsd: agentBalance(agent),
        minTradeUsd: this.cfg.minTradeUsd,
      });
      for (const intent of intents) {
        if (intent.kind !== 'sell') continue;
        const p = agent.positions.find((x) => x.id === intent.positionId);
        if (p && p.lastPricedCycle === this.state.cycle) this.closePosition(agent, p, intent.reason);
      }
      if (!allowEntries) continue;
      for (const intent of intents) if (intent.kind === 'buy') this.openPosition(agent, intent.mint, intent.sizeUsd);
    }
  }

  private writeOffStale() {
    const { cycle } = this.state;
    for (const a of this.state.agents) {
      for (const p of [...a.positions]) {
        if (cycle - p.lastPricedCycle >= this.cfg.staleWriteOffCycles) this.closePosition(a, p, 'stale');
      }
    }
  }

  // ---------------------------------------------------------------- death & birth

  private bury(agent: Agent, cause: DeathCause) {
    const s = this.state;
    const finalBalance = agentBalance(agent);
    for (const p of [...agent.positions]) this.closePosition(agent, p, 'death');
    const returned = Math.max(0, agent.cashUsd);
    s.treasuryUsd += returned;
    agent.cashUsd = 0;
    agent.debtUsd = 0; // unpaid upkeep is forgiven (it was never booked)
    s.agents = s.agents.filter((a) => a !== agent);
    s.deathsTotal++;
    s.lastCycle.deaths++;

    const dead: DeadAgent = {
      id: agent.id,
      species: agent.species,
      origin: agent.origin,
      parentId: agent.parentId,
      generation: agent.generation,
      bornCycle: agent.bornCycle,
      diedCycle: s.cycle,
      bornAt: agent.bornAt,
      diedAt: this.nowIso(),
      cause,
      birthCapitalUsd: agent.birthCapitalUsd,
      peakBalanceUsd: agent.peakBalanceUsd,
      returnedUsd: returned,
      finalReturn: agent.birthCapitalUsd > 0 ? (finalBalance + agent.givenUsd - agent.birthCapitalUsd) / agent.birthCapitalUsd : 0,
      trades: agent.stats.trades,
      wins: agent.stats.wins,
      children: agent.children,
      genome: agent.genome,
    };
    const g = this.graveyard;
    g.recent.push(dead);
    if (g.recent.length > this.cfg.graveyardMax) g.recent.splice(0, g.recent.length - this.cfg.graveyardMax);
    const agg = g.aggregate;
    const life = s.cycle - agent.bornCycle;
    agg.total++;
    agg.byCause[cause] = (agg.byCause[cause] ?? 0) + 1;
    agg.byOrigin[agent.origin] = (agg.byOrigin[agent.origin] ?? 0) + 1;
    agg.sumLifespanCycles += life;
    agg.maxLifespanCycles = Math.max(agg.maxLifespanCycles, life);
    agg.sumFinalReturn += dead.finalReturn;
    agg.returnedUsd += returned;
  }

  private deaths() {
    for (const agent of [...this.state.agents]) {
      const balance = agentBalance(agent);
      if (balance >= this.cfg.deathUsd) continue;
      // Without a market snapshot we cannot liquidate fairly: defer deaths of agents holding positions.
      if (!this.snapshot.ok && agent.positions.length > 0) continue;
      this.bury(agent, this.levied.has(agent.id) ? 'budget-levy' : 'bankrupt');
    }
  }

  private reproduce() {
    const s = this.state;
    const cfg = this.cfg;
    const reserve = cfg.upkeepUsd * 10;
    const eligible = s.agents
      .filter((a) => s.cycle - a.bornCycle >= cfg.reproMinAge && agentBalance(a) >= cfg.reproMultiple * a.birthCapitalUsd)
      .sort((a, b) => agentReturn(b) - agentReturn(a) || (a.id < b.id ? -1 : 1));
    for (const parent of eligible) {
      if (s.agents.length >= cfg.maxPopulation) break;
      const amount = Math.min(cfg.reproShare * agentBalance(parent), parent.cashUsd - reserve);
      if (!(amount >= Math.max(cfg.deathUsd * 2, cfg.minTradeUsd))) continue; // capital tied up in positions
      const species = getSpecies(parent.species);
      let genome = parent.genome;
      if (species.crossover && eligible.length > 1 && this.rng.chance(cfg.crossoverRate)) {
        const mates = eligible.filter((a) => a !== parent && a.species === parent.species);
        if (mates.length > 0) genome = species.crossover(genome, this.rng.pick(mates).genome, this.rng);
      }
      genome = species.mutate(genome, this.rng, cfg.mutationRate);
      parent.cashUsd -= amount;
      parent.givenUsd += amount;
      parent.children++;
      this.newAgent('birth', genome, amount, parent, parent.species);
    }
  }

  private respawn() {
    let spawned = 0;
    while (this.state.agents.length < this.cfg.minPopulation && spawned < this.cfg.maxSpawnsPerCycle) {
      if (!this.spawnFromTreasury('spawn')) break;
      spawned++;
    }
    // Exploration: a few random immigrants per cycle while the treasury is above its reserve.
    for (let i = 0; i < this.cfg.immigrantsPerCycle; i++) {
      const reserve = this.cfg.treasuryReservePct * arenaEquity(this.state);
      if (this.state.treasuryUsd - this.cfg.seedUsd < reserve) break;
      if (!this.spawnFromTreasury('spawn')) break;
    }
  }

  // ---------------------------------------------------------------- LLM mutator

  genomeStats(): { top: GenomeStat[]; bottom: GenomeStat[] } {
    const s = this.state;
    const living: GenomeStat[] = s.agents
      .filter((a) => a.species === DEFAULT_SPECIES)
      .map((a) => ({
        genome: a.genome,
        returnPct: agentReturn(a),
        trades: a.stats.trades,
        winRate: a.stats.trades ? a.stats.wins / a.stats.trades : 0,
        ageCycles: s.cycle - a.bornCycle,
        alive: true,
      }));
    const dead: GenomeStat[] = this.graveyard.recent
      .filter((d) => d.species === DEFAULT_SPECIES)
      .map((d) => ({ genome: d.genome, returnPct: d.finalReturn, trades: d.trades, winRate: d.trades ? d.wins / d.trades : 0, ageCycles: d.diedCycle - d.bornCycle, alive: false }));
    const top = [...living].sort((a, b) => b.returnPct - a.returnPct).slice(0, 5);
    const bottom = [...dead, ...living].sort((a, b) => a.returnPct - b.returnPct).slice(0, 5);
    return { top, bottom };
  }

  private async llmStep(): Promise<void> {
    const s = this.state;
    const client = this.deps.llm;
    if (!client || !this.cfg.llm.apiKey || s.cycle % this.cfg.llm.every !== 0) return;
    const species = getSpecies(DEFAULT_SPECIES);
    const { top, bottom } = this.genomeStats();
    const outcome = await runMutator({
      client,
      cfg: this.cfg.llm,
      species,
      top,
      bottom,
      rng: this.rng,
      llm: s.llm,
      now: this.deps.now(),
      maxAffordableUsd: s.treasuryUsd,
    });
    s.llm.lastNote = `${outcome.status}: ${outcome.note}`;
    if (outcome.status === 'budget') {
      this.log(`[llm] skipped: ${outcome.note}`);
      return;
    }
    s.llm.calls++;
    s.llm.lastCallCycle = s.cycle;
    if (outcome.status === 'refused') s.llm.refusals++;
    if (outcome.status === 'error' || outcome.status === 'empty') s.llm.failures++;
    if (outcome.costUsd > 0) {
      s.treasuryUsd -= outcome.costUsd;
      s.ledger.llmUsd += outcome.costUsd;
      s.llm.totalUsd += outcome.costUsd;
      s.llm.dayUsd += outcome.costUsd;
    }
    this.log(`[llm] ${outcome.status}: ${outcome.note} (cost $${outcome.costUsd.toFixed(4)})`);
    if (outcome.status !== 'ok') return;
    const spawned: string[] = [];
    for (const genome of outcome.genomes) {
      const a = this.spawnFromTreasury('designed', genome);
      if (!a) break;
      spawned.push(a.id);
    }
    s.llm.designedSpawned += spawned.length;
    if (spawned.length > 0) {
      await this.deps.emit({
        source: STRATEGY_NAME,
        level: 'info',
        type: 'arena.llm-batch-spawned',
        message: `Claude designed ${spawned.length} trader genomes; spawned from treasury (cost $${outcome.costUsd.toFixed(4)})`,
        data: { cycle: s.cycle, agents: spawned, costUsd: outcome.costUsd },
      });
    }
  }

  // ---------------------------------------------------------------- cycle

  checkInvariant(): void {
    const { lhs, rhs, diff } = conservation(this.state);
    const tol = 1e-6 * Math.max(1, Math.abs(rhs));
    const negative = this.state.treasuryUsd < -1e-9 || this.state.agents.some((a) => a.cashUsd < -1e-9);
    if (Math.abs(diff) > tol || negative) {
      throw new InvariantError(
        `money conservation violated at cycle ${this.state.cycle}: lhs=${lhs} rhs=${rhs} diff=${diff}` + (negative ? ' (negative cash)' : ''),
      );
    }
  }

  async runCycle(control: ArenaControl): Promise<CycleResult> {
    const s = this.state;
    s.cycle++;
    s.lastCycle = emptyCounters();
    s.lastCycle.paused = control.paused;
    if (control.pauseReason) s.lastCycle.pauseReason = control.pauseReason;
    if (control.budgetUsd !== undefined) s.lastCycle.budgetUsd = control.budgetUsd;
    this.flow = new PoolFlow();
    this.levied = new Set();
    const populationStart = s.agents.length;
    const generationBefore = s.maxGeneration;

    const held = [...new Set(s.agents.flatMap((a) => a.positions.map((p) => p.mint)))];
    try {
      this.snapshot = await this.deps.market.snapshot(held);
    } catch (error) {
      this.snapshot = failedSnapshot(this.deps.market.id, (error as Error).message, this.deps.now());
    }
    s.lastCycle.marketOk = this.snapshot.ok;
    if (this.snapshot.error) s.lastCycle.marketError = this.snapshot.error;
    if (!this.snapshot.ok) this.log(`[market] ${this.snapshot.error ?? 'fetch failed'}: no new entries this cycle`);

    this.markToMarket();
    // While paused/killed the budget is not followed (no forced levies); only exits run.
    if (control.budgetUsd !== undefined && !control.paused) this.followBudget(control.budgetUsd);

    for (const a of s.agents) this.chargeUpkeep(a);
    this.actAll(!control.paused && this.snapshot.ok);
    this.writeOffStale();
    this.deaths();
    if (!control.paused) {
      this.reproduce();
      await this.llmStep();
      this.respawn();
    }
    for (const a of s.agents) a.peakBalanceUsd = Math.max(a.peakBalanceUsd, agentBalance(a));

    // equity curve + drawdown (on equity net of budget flows, so deposits/withdrawals are not "drawdowns")
    const equityUsd = arenaEquity(s);
    const pnlUsd = equityUsd - (s.ledger.initialCapitalUsd + s.ledger.adjustmentsUsd);
    const perfEquity = s.ledger.initialCapitalUsd + pnlUsd;
    s.perf.peakUsd = Math.max(s.perf.peakUsd, perfEquity);
    if (s.perf.peakUsd > 0) s.perf.maxDrawdown = Math.max(s.perf.maxDrawdown, Math.min(1, Math.max(0, (s.perf.peakUsd - perfEquity) / s.perf.peakUsd)));
    s.equityCurve.push({ cycle: s.cycle, ts: this.nowIso(), equityUsd, pnlUsd, treasuryUsd: s.treasuryUsd, population: s.agents.length });
    if (s.equityCurve.length > this.cfg.equityCurveMax) s.equityCurve.splice(0, s.equityCurve.length - this.cfg.equityCurveMax);
    s.rng = this.rng.state;
    s.updatedAt = this.nowIso();

    try {
      this.checkInvariant();
    } catch (error) {
      await this.deps.emit({ source: STRATEGY_NAME, level: 'error', type: 'arena.invariant-violated', message: (error as Error).message });
      throw error;
    }

    // notable events
    for (const m of GENERATION_MILESTONES) {
      if (s.maxGeneration >= m && generationBefore < m && !s.generationMilestones.includes(m)) {
        s.generationMilestones.push(m);
        const who = s.agents.find((a) => a.generation >= m);
        await this.deps.emit({
          source: STRATEGY_NAME,
          level: 'info',
          type: 'arena.generation-milestone',
          message: `first agent reached generation ${m}${who ? ` (${who.id})` : ''}`,
          data: { cycle: s.cycle, generation: m, agentId: who?.id },
        });
      }
    }
    if (populationStart >= 4 && s.lastCycle.deaths / populationStart > 0.5) {
      await this.deps.emit({
        source: STRATEGY_NAME,
        level: 'warn',
        type: 'arena.mass-extinction',
        message: `${s.lastCycle.deaths} of ${populationStart} agents died in cycle ${s.cycle}`,
        data: { cycle: s.cycle, deaths: s.lastCycle.deaths, populationStart },
      });
    }
    return { cycle: s.cycle, snapshot: this.snapshot, equityUsd, populationStart };
  }
}

