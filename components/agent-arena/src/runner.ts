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
    return new ArenaRunner(cfg, arena, market, now);
  }

  async cycle(control?: ArenaControl): Promise<CycleResult> {
    return this.arena.runCycle(control ?? (await readControl()));
  }

  /** Persist population + graveyard (+ synthetic market) and write the StrategyReport and summary. */
  async persist(): Promise<{ report: StrategyReport; summary: ArenaSummary }> {
    const now = this.now();
    await saveState(this.arena.state, this.arena.graveyard);
    if (this.market instanceof SyntheticMarket) await writeJsonAtomic(arenaPaths.syntheticMarket(), this.market.exportState());
    const report = buildStrategyReport(this.arena.state, this.cfg, now);
    const summary = buildSummary(this.arena.state, this.arena.graveyard, this.cfg, now);
    await writeJsonAtomic(statePaths.strategy(STRATEGY_NAME), report);
    await writeJsonAtomic(arenaPaths.summary(), summary);
    return { report, summary };
  }
}
