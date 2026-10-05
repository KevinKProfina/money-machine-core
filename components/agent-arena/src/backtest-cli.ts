import dotenv from 'dotenv';
import path from 'node:path';
import { parseArgs } from 'node:util';
import fs from 'node:fs/promises';
import { backtestGenome, evolveOnWindow, walkForwardSplits, type BacktestMetrics, type GenomeBacktest, type Split } from './backtest.js';
import { readConfig, STRATEGY_NAME } from './config.js';
import { pct } from './format.js';
import type { Genome } from './genome.js';
import { GeckoTerminalClient, TIMEFRAME_SECONDS, VALID_AGGREGATES, type Timeframe } from './geckoterminal.js';
import { loadDataset } from './history.js';
import type { FetchLike } from './http.js';
import { emitEvent, readJsonSafe, writeJsonAtomic, type MMEvent } from './mm-contract.js';
import { mergeBacktestResults, updatePromotions, type BacktestResultEntry, type PromotionsFile } from './promotion.js';
import type { ArenaSummary } from './report.js';
import type { PretrainedFile } from './runner.js';
import { arenaPaths, loadState } from './state.js';
import { traderSpecies } from './species/trader.js';
import { Rng } from './rng.js';

/**
 * npm run backtest -- --pools 20 --days 7 --timeframe minute --aggregate 5
 *                     [--genomes leaderboard|population|file.json] [--seed 1]
 *                     [--evolve [--epochs 2] [--top 5]] [--folds 1] [--train-frac 0.7]
 *                     [--capital 100] [--offline]
 *
 * Historical data: GeckoTerminal (public API, throttled, cached under
 * $MM_STATE_DIR/arena/history). Results: arena/backtests/latest.json (this run),
 * arena/backtests/results.json (latest result per genome id, read by the promotion
 * pipeline), arena/pretrained.json (--evolve), then promotions.json is re-evaluated.
 */
export type BacktestReport = {
  schema: 'mm.arena-backtest/v1';
  timestamp: string;
  dataSource: 'geckoterminal';
  mode: 'paper';
  params: {
    pools: number;
    days: number;
    timeframe: Timeframe;
    aggregate: number;
    stepMinutes: number;
    folds: number;
    trainFrac: number;
    capitalUsd: number;
    feeBps: number;
    slippageBps: number;
    genomes: string;
    evolve: boolean;
    seed: string;
  };
  window: { fromTs: number; toTs: number };
  splits: Split[];
  pools: Array<{ address: string; symbol: string; candles: number }>;
  results: GenomeBacktest[];
  notes: string[];
};

export type BacktestDeps = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  /** Wall clock (unix seconds). */
  nowSec?: () => number;
  log?: (msg: string) => void;
  /** GeckoTerminal client overrides (tests: no throttle delay). */
  client?: GeckoTerminalClient;
  emit?: (event: Omit<MMEvent, 'ts'>) => Promise<void>;
};

function intArg(name: string, raw: string | undefined, min: number, max: number): number {
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`--${name} must be an integer in [${min}, ${max}]`);
  return v;
}

async function loadGenomes(source: string, seed: string, log: (m: string) => void): Promise<Array<{ genome: Genome; origin: string }>> {
  if (source === 'leaderboard') {
    const summary = await readJsonSafe<ArenaSummary | null>(arenaPaths.summary(), null);
    const rows = summary?.schema === 'mm.arena-summary/v1' ? summary.leaderboard : [];
    if (summary?.marketSource === 'synthetic') log('[backtest] note: the leaderboard comes from a synthetic-market arena');
    return rows.map((r) => ({ genome: r.genome, origin: `leaderboard:${r.id}` }));
  }
  if (source === 'population') {
    const { state } = await loadState();
    return (state?.agents ?? []).filter((a) => a.species === 'trader').map((a) => ({ genome: a.genome, origin: `population:${a.id}` }));
  }
  if (source.startsWith('random:')) {
    const n = intArg('genomes random:<n>', source.slice(7), 1, 1000);
    const rng = new Rng(`backtest-random:${seed}`);
    return Array.from({ length: n }, (_, i) => ({ genome: traderSpecies.randomGenome(rng), origin: `random:${i}` }));
  }
  const raw = JSON.parse(await fs.readFile(source, 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : ((raw as { genomes?: unknown[] })?.genomes ?? []);
  if (!Array.isArray(list)) throw new Error(`${source}: expected an array of genomes or { genomes: [...] }`);
  return list.map((g, i) => {
    const genome = (g as { genome?: unknown })?.genome ?? g;
    const res = traderSpecies.validate(genome, {});
    if (res.missing.length > Object.keys(traderSpecies.genomeSpec).length / 2) throw new Error(`${source}[${i}]: not a trader genome (missing ${res.missing.join(', ')})`);
    return { genome: res.genome, origin: `file:${path.basename(source)}#${i}` };
  });
}

export async function runBacktest(argv: string[], deps: BacktestDeps = {}): Promise<{ report: BacktestReport; promotions: PromotionsFile; text: string }> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((m: string) => console.error(m));
  const { values } = parseArgs({
    args: argv,
    options: {
      pools: { type: 'string', default: '20' },
      days: { type: 'string', default: '7' },
      timeframe: { type: 'string', default: 'minute' },
      aggregate: { type: 'string', default: '5' },
      genomes: { type: 'string', default: 'leaderboard' },
      seed: { type: 'string', default: '1' },
      evolve: { type: 'boolean', default: false },
      epochs: { type: 'string', default: '1' },
      top: { type: 'string', default: '5' },
      folds: { type: 'string', default: '1' },
      'train-frac': { type: 'string', default: '0.7' },
      capital: { type: 'string', default: '100' },
      offline: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const timeframe = values.timeframe as Timeframe;
  if (!(timeframe in TIMEFRAME_SECONDS)) throw new Error('--timeframe must be minute | hour | day');
  const aggregate = intArg('aggregate', values.aggregate, 1, 15);
  if (!VALID_AGGREGATES[timeframe].includes(aggregate)) throw new Error(`--aggregate for ${timeframe} must be one of ${VALID_AGGREGATES[timeframe].join(', ')}`);
  const pools = intArg('pools', values.pools, 1, 200);
  const days = Number(values.days);
  if (!(days > 0 && days <= 180)) throw new Error('--days must be in (0, 180]');
  const folds = intArg('folds', values.folds, 1, 20);
  const trainFrac = Number(values['train-frac']);
  const capitalUsd = Number(values.capital);
  if (!(capitalUsd > 0)) throw new Error('--capital must be positive');
  const epochs = intArg('epochs', values.epochs, 1, 100);
  const top = intArg('top', values.top, 1, 100);
  const seed = values.seed;

  const cfg = readConfig({ ...env, ARENA_MARKET: 'dexscreener' }); // MODE=live is refused here too
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const now = new Date(nowSec() * 1000);
  const stepSec = TIMEFRAME_SECONDS[timeframe] * aggregate;
  const client = deps.client ?? new GeckoTerminalClient({ fetchImpl: deps.fetchImpl, log });

  const data = await loadDataset(values.offline ? undefined : client, { pools, days, timeframe, aggregate, offline: values.offline, nowSec: nowSec() }, log);
  if (data.histories.length === 0) {
    throw new Error('no historical candles available (GeckoTerminal unreachable and nothing cached under arena/history?)');
  }
  const series = data.histories.map((h) => ({ pool: h.pool, candles: h.candles }));
  const splits = walkForwardSplits(data.fromTs, data.toTs, stepSec, { folds, trainFrac });
  const evalOpts = { cfg, stepSec, capitalUsd };
  const results: GenomeBacktest[] = [];
  const notes: string[] = [
    'PAPER/BACKTEST ONLY: fills are simulated with the arena paper model (fee + slippage + constant-product impact)',
    'historical liquidity, market cap and buy/sell counts are proxies derived from candles + discovery-time pool data',
    'pool discovery uses currently trending/top pools: survivorship bias (pools that died before today are missing)',
    'memecoin history is noisy; out-of-sample gains are not a guarantee of future results',
  ];

  if (values.evolve) {
    const pretrained: PretrainedFile['genomes'] = [];
    for (const split of splits) {
      const evo = await evolveOnWindow(series, split.train, { cfg, stepSec, seed: `${seed}:fold${split.fold}`, epochs, top, log });
      log(`[backtest] fold ${split.fold}: evolved ${evo.cycles} cycles, population ${evo.population}, births ${evo.births}, deaths ${evo.deaths}, max generation ${evo.maxGeneration}, ${evo.top.length} top genomes`);
      for (const t of evo.top) {
        const r = await backtestGenome(t.genome, `evolved:fold${split.fold}:${t.agentId}`, series, splits, evalOpts, split.train.toTs, split.train);
        results.push(r);
        pretrained.push({ genomeId: r.genomeId, genome: r.genome, oosReturn: r.outOfSample?.return ?? null });
      }
    }
    await writeJsonAtomic(arenaPaths.pretrained(), {
      schema: 'mm.arena-pretrained/v1',
      createdAt: now.toISOString(),
      dataSource: data.dataSource,
      genomes: pretrained,
    } satisfies PretrainedFile);
    notes.push('evolved genomes: in-sample = the train window they evolved on; out-of-sample = later test windows only');
  } else {
    const genomes = await loadGenomes(values.genomes, seed, log);
    if (genomes.length === 0) throw new Error(`no genomes from --genomes ${values.genomes} (run the arena first, or pass a file / random:<n>)`);
    for (const g of genomes) results.push(await backtestGenome(g.genome, g.origin, series, splits, evalOpts));
    notes.push('external genomes (leaderboard/population/file): their "out-of-sample" window may overlap the period the live arena evolved them in');
  }

  const report: BacktestReport = {
    schema: 'mm.arena-backtest/v1',
    timestamp: now.toISOString(),
    dataSource: data.dataSource,
    mode: 'paper',
    params: { pools, days, timeframe, aggregate, stepMinutes: stepSec / 60, folds, trainFrac, capitalUsd, feeBps: cfg.feeBps, slippageBps: cfg.slippageBps, genomes: values.evolve ? 'evolve' : values.genomes, evolve: values.evolve, seed },
    window: { fromTs: data.fromTs, toTs: data.toTs },
    splits,
    pools: data.histories.map((h) => ({ address: h.pool.address, symbol: h.pool.symbol, candles: h.candles.length })),
    results,
    notes,
  };
  await writeJsonAtomic(arenaPaths.backtestLatest(), report);
  const entries: BacktestResultEntry[] = results.map((r) => ({ ...r, runAt: now.toISOString(), dataSource: data.dataSource, stepMinutes: stepSec / 60 }));
  await mergeBacktestResults(entries, now);

  // re-evaluate promotions against the live population with the new evidence
  const { state } = await loadState();
  const promoState = state ?? { agents: [], cycle: 0, market: cfg.market };
  const { file: promotions } = await updatePromotions(promoState, cfg.promotion, cfg.intervalMs / 60_000, now, deps.emit ?? emitEvent);
  return { report, promotions, text: formatReport(report, promotions) };
}

const fmt = (m: BacktestMetrics | null) =>
  m
    ? `${pct(m.return).padStart(9)} ${String(m.trades).padStart(6)} ${pct(m.winRate).padStart(7)} ${pct(m.maxDrawdown).padStart(7)} ${m.sharpe.toFixed(2).padStart(6)} ${pct(m.exposure).padStart(7)}`
    : '        —      —       —       —      —       —';

export function formatReport(r: BacktestReport, p: PromotionsFile): string {
  const head = 'genome          origin                         |   return trades     win     mdd sharpe  expos.';
  const lines = [
    `[backtest] ${r.pools.length} pools, ${r.params.days} d of ${r.params.timeframe}×${r.params.aggregate} candles (${new Date(r.window.fromTs * 1000).toISOString()} → ${new Date(r.window.toTs * 1000).toISOString()}), ${r.splits.length} fold(s), capital $${r.params.capitalUsd}, fee ${r.params.feeBps} bps + slippage ${r.params.slippageBps} bps (simulated)`,
    '',
    'IN-SAMPLE',
    head,
    ...r.results.map((x) => `${x.genomeId.padEnd(15)} ${x.origin.slice(0, 30).padEnd(30)} | ${fmt(x.inSample)}`),
    '',
    'OUT-OF-SAMPLE (walk-forward test windows; used for promotion)',
    head,
    ...r.results.map((x) => `${x.genomeId.padEnd(15)} ${x.origin.slice(0, 30).padEnd(30)} | ${fmt(x.outOfSample)}`),
    '',
    p.promoted ? `promoted for solana-trader: ${p.promoted.genomeId} (${p.promoted.reason})` : 'promoted for solana-trader: none (see arena/promotions.json for the reasons)',
    ...r.notes.map((n) => `note: ${n}`),
  ];
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'backtest-cli.ts'));
if (isMain) {
  dotenv.config({ quiet: true });
  runBacktest(process.argv.slice(2))
    .then(({ text }) => console.log(text))
    .catch(async (error: unknown) => {
      const message = (error as Error).message ?? String(error);
      console.error(`[backtest] ${message}`);
      await emitEvent({ source: STRATEGY_NAME, level: 'error', type: 'backtest.failed', message });
      process.exit(1);
    });
}
