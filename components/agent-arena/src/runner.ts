import crypto from 'node:crypto';
import { Arena, createGenesisState, type ArenaControl, type CycleResult, type EmitFn } from './arena.js';
import { STRATEGY_NAME, type ArenaConfig } from './config.js';
import { DexScreenerSource } from './dexscreener.js';
import type { FetchLike } from './http.js';
import type { MarketSource } from './market.js';
import { emitEvent, isKillSwitchActive, readJsonSafe, readStrategyBudget, statePaths, writeJsonAtomic, type StrategyReport } from './mm-contract.js';
import { createAnthropicClient, type LlmClient } from './mutator.js';
import { buildStrategyReport, buildSummary, type ArenaSummary } from './report.js';
import { arenaPaths, loadState, saveState } from './state.js';
import { updatePromotions, type PromotionsFile } from './promotion.js';
import { genomeId, type Genome } from './genome.js';
import { traderSpecies } from './species/trader.js';
import { SyntheticMarket, type SyntheticMarketState } from './synthetic-market.js';

export type RunnerOptions = {
  cfg: ArenaConfig;
  now?: () => Date;
  fetchImpl?: FetchLike;
  /** Inject an LLM client (tests). undefined → real client when ANTHROPIC_API_KEY is set; null → disabled. */
  llm?: LlmClient | null;
  market?: MarketSource;
  emit?: EmitFn;
  log?: (msg: string) => void;
};

export async function readControl(): Promise<ArenaControl> {
  const kill = isKillSwitchActive();
  const budget = await readStrategyBudget(STRATEGY_NAME);
  const paused = kill || (budget?.paused ?? false);
  const control: ArenaControl = { paused };
  if (kill) control.pauseReason = 'kill switch active';
  else if (budget?.paused) control.pauseReason = 'paused by orchestrator';
  if (budget) control.budgetUsd = budget.budgetUsd;
  return control;
}

export class ArenaRunner {
  private constructor(
    readonly cfg: ArenaConfig,
    readonly arena: Arena,
    private readonly market: MarketSource,
    private readonly now: () => Date,
    private readonly emit: EmitFn,
  ) {}

  get state() {
    return this.arena.state;
  }

  static async open(opts: RunnerOptions): Promise<ArenaRunner> {
    const { cfg } = opts;
    const now = opts.now ?? (() => new Date());
    const log = opts.log ?? ((m: string) => console.log(m));
    const loaded = await loadState();
    let state = loaded.state;
    const fresh = !state;
    if (!state) state = createGenesisState(cfg, now(), cfg.seed ?? crypto.randomBytes(6).toString('hex'));
    if (state.market !== cfg.market) {
      log(`[arena] market source changed ${state.market} → ${cfg.market}; positions without a price are written off after ${cfg.staleWriteOffCycles} cycles`);
      state.market = cfg.market;
      state.marketSinceCycle = state.cycle;
    }

    let market = opts.market;
    if (!market) {
      if (cfg.market === 'synthetic') {
        const restored = await readJsonSafe<SyntheticMarketState | null>(arenaPaths.syntheticMarket(), null);
        market = new SyntheticMarket({ seed: state.seed, tokens: cfg.syntheticTokens, now }, fresh ? undefined : (restored ?? undefined));
      } else {
        market = new DexScreenerSource({ fetchImpl: opts.fetchImpl, log });
      }
    }

    let llm: LlmClient | undefined;
    if (opts.llm === null) llm = undefined;
    else if (opts.llm) llm = opts.llm;
    else if (cfg.llm.apiKey) llm = createAnthropicClient(cfg.llm.apiKey);

    const arena = new Arena(cfg, state, loaded.state ? loaded.graveyard : undefined, {
      market,
      now,
      emit: opts.emit ?? emitEvent,
      log: opts.log,
      llm,
    });
    if (fresh) arena.genesis();
    const emit = opts.emit ?? emitEvent;
    if (cfg.adoptPretrained && cfg.market === 'dexscreener') await adoptPretrained(arena, log);
    return new ArenaRunner(cfg, arena, market, now, emit);
  }

  async cycle(control?: ArenaControl): Promise<CycleResult> {
    return this.arena.runCycle(control ?? (await readControl()));
  }

  /** Persist population + graveyard (+ synthetic market) and write the StrategyReport and summary. */
  async persist(): Promise<{ report: StrategyReport; summary: ArenaSummary; promotions: PromotionsFile }> {
    const now = this.now();
    await saveState(this.arena.state, this.arena.graveyard);
    if (this.market instanceof SyntheticMarket) await writeJsonAtomic(arenaPaths.syntheticMarket(), this.market.exportState());
    const report = buildStrategyReport(this.arena.state, this.cfg, now);
    const summary = buildSummary(this.arena.state, this.arena.graveyard, this.cfg, now);
    await writeJsonAtomic(statePaths.strategy(STRATEGY_NAME), report);
    await writeJsonAtomic(arenaPaths.summary(), summary);
    const { file: promotions } = await updatePromotions(this.arena.state, this.cfg.promotion, this.cfg.intervalMs / 60_000, now, this.emit);
    return { report, summary, promotions };
  }
}

export type PretrainedFile = {
  schema: 'mm.arena-pretrained/v1';
  createdAt: string;
  dataSource: string;
  genomes: Array<{ genomeId: string; genome: Genome; oosReturn: number | null }>;
};

/**
 * Spawn genomes pre-trained on real history (`backtest --evolve`) into the live
 * population once each, as `designed` agents paid from the treasury. Only genomes
 * with a positive out-of-sample backtest return are adopted.
 */
export async function adoptPretrained(arena: Arena, log: (msg: string) => void): Promise<string[]> {
  const file = await readJsonSafe<PretrainedFile | null>(arenaPaths.pretrained(), null);
  if (!file || file.schema !== 'mm.arena-pretrained/v1' || !Array.isArray(file.genomes) || file.dataSource !== 'geckoterminal') return [];
  const s = arena.state;
  const adopted = new Set(s.pretrainedAdopted ?? []);
  const spawned: string[] = [];
  for (const g of file.genomes) {
    if (!(typeof g.oosReturn === 'number' && g.oosReturn > 0)) continue;
    const genome = traderSpecies.validate(g.genome, g.genome).genome;
    const id = genomeId(genome);
    if (adopted.has(id)) continue;
    const agent = arena.spawnFromTreasury('designed', genome);
    if (!agent) break;
    adopted.add(id);
    spawned.push(agent.id);
  }
  s.pretrainedAdopted = [...adopted];
  if (spawned.length) log(`[arena] adopted ${spawned.length} pre-trained genome(s) from ${arenaPaths.pretrained()}: ${spawned.join(', ')}`);
  return spawned;
}
