import type { EmitFn } from './arena.js';
import type { BacktestMetrics, GenomeBacktest } from './backtest.js';
import { STRATEGY_NAME, type PromotionCriteria } from './config.js';
import { genomeId, type Genome } from './genome.js';
import { readJsonSafe, writeJsonAtomic } from './mm-contract.js';
import type { MarketSourceId } from './market.js';
import { arenaPaths, type ArenaState } from './state.js';
import { SYNTHETIC_NOTE } from './synthetic-market.js';
import { agentReturn } from './types.js';

/**
 * Promotion pipeline: picks the arena genome the real solana-trading-agent may use
 * (when it runs with STRATEGY_SOURCE=arena). Promotion only changes *strategy
 * parameters*; it can never change the trader's mode (paper/live).
 *
 * A candidate is eligible only if ALL hold:
 * - the live arena runs on real market data (`dexscreener`): never from
 *   `synthetic-market-data` (and never from a replay population),
 * - the agent was born after the current market source took over,
 * - it lived ≥ minCycles, closed ≥ minTrades paper trades, arena drawdown ≤ maxDrawdown,
 * - a fresh GeckoTerminal backtest of the same genome (same genome id) exists, with
 *   the same step length as the arena cycle, whose OUT-OF-SAMPLE result (after
 *   fees/slippage/impact) has return > minOosReturn, ≥ minOosTrades trades and
 *   drawdown ≤ maxOosDrawdown.
 *
 * score = oosReturn − 0.5·oosMaxDrawdown + 0.25·clamp(arenaReturn, −1, 1) − 0.25·arenaMaxDrawdown
 *
 * The best eligible candidate is promoted when nothing is promoted yet or it beats
 * the promoted strategy's (current) score by `margin`. A promoted genome is demoted
 * (→ the trader falls back to its static strategy) when a fresh backtest of it fails
 * the out-of-sample criteria.
 */
export type OosEvidence = { return: number; trades: number; maxDrawdown: number; sharpe: number };

export type CandidateEvidence = {
  liveArenaCycles: number;
  arenaTrades: number;
  arenaReturn: number;
  arenaMaxDrawdown: number;
  backtestOos: OosEvidence | null;
};

export type PromotionCandidate = {
  genomeId: string;
  agentId?: string;
  genome: Genome;
  evidence: CandidateEvidence;
  score: number;
  eligible: boolean;
  reasons: string[];
};

export type Promoted = {
  genomeId: string;
  genome: Genome;
  promotedAt: string;
  reason: string;
  score: number;
  evidence: CandidateEvidence;
  /** Length of one arena cycle in minutes (cycle-based genes → hours in the trader). */
  cycleMinutes: number;
};

export type PromotionHistoryEntry = { genomeId: string; promotedAt: string; reason: string; score: number; endedAt?: string; endReason?: string };

export type PromotionsFile = {
  schema: 'mm.arena-promotions/v1';
  timestamp: string;
  arenaCycle: number;
  arenaMarket: MarketSourceId;
  cycleMinutes: number;
  criteria: PromotionCriteria;
  notes: string[];
  candidates: PromotionCandidate[];
  promoted?: Promoted;
  history: PromotionHistoryEntry[];
};

export type BacktestResultEntry = GenomeBacktest & {
  runAt: string;
  dataSource: string;
  stepMinutes: number;
};

export type BacktestResults = { schema: 'mm.arena-backtest-results/v1'; updatedAt: string; results: Record<string, BacktestResultEntry> };

export const MAX_CANDIDATES_LISTED = 25;
const MAX_HISTORY = 100;
const MAX_RESULTS = 500;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function oosEvidence(m: BacktestMetrics | null | undefined): OosEvidence | null {
  if (!m) return null;
  return { return: m.return, trades: m.trades, maxDrawdown: m.maxDrawdown, sharpe: m.sharpe };
}

export function scoreEvidence(e: CandidateEvidence): number {
  const oos = e.backtestOos;
  const oosPart = oos ? oos.return - 0.5 * oos.maxDrawdown : -1;
  return oosPart + 0.25 * clamp(e.arenaReturn, -1, 1) - 0.25 * e.arenaMaxDrawdown;
}

/** Backtest evidence usable for promotion, or the reason it is not. */
export function usableBacktest(
  entry: BacktestResultEntry | undefined,
  criteria: PromotionCriteria,
  cycleMinutes: number,
  now: Date,
): { ok: true; oos: OosEvidence } | { ok: false; reason: string } {
  if (!entry) return { ok: false, reason: 'no backtest of this genome' };
  if (entry.dataSource !== 'geckoterminal') return { ok: false, reason: `backtest data source ${entry.dataSource} is not real history` };
  const age = (now.getTime() - Date.parse(entry.runAt)) / 3_600_000;
  if (!(age <= criteria.maxBacktestAgeHours)) return { ok: false, reason: `backtest is ${Number.isFinite(age) ? age.toFixed(0) : '?'}h old (> ${criteria.maxBacktestAgeHours}h)` };
  if (Math.abs(entry.stepMinutes - cycleMinutes) > 1e-9) return { ok: false, reason: `backtest step ${entry.stepMinutes} min ≠ arena cycle ${cycleMinutes} min` };
  const oos = oosEvidence(entry.outOfSample);
  if (!oos) return { ok: false, reason: 'backtest has no out-of-sample window' };
  return { ok: true, oos };
}

function oosFailures(oos: OosEvidence, c: PromotionCriteria): string[] {
  const r: string[] = [];
  if (!(oos.return > c.minOosReturn)) r.push(`out-of-sample return ${(oos.return * 100).toFixed(2)}% ≤ ${(c.minOosReturn * 100).toFixed(2)}%`);
  if (oos.trades < c.minOosTrades) r.push(`out-of-sample trades ${oos.trades} < ${c.minOosTrades}`);
  if (oos.maxDrawdown > c.maxOosDrawdown) r.push(`out-of-sample drawdown ${(oos.maxDrawdown * 100).toFixed(1)}% > ${(c.maxOosDrawdown * 100).toFixed(1)}%`);
  return r;
}

export type PromotionInput = {
  state: Pick<ArenaState, 'agents' | 'cycle' | 'market' | 'marketSinceCycle'>;
  backtests?: BacktestResults | null;
  previous?: PromotionsFile | null;
  criteria: PromotionCriteria;
  cycleMinutes: number;
  now: Date;
};

export type PromotionChange = { type: 'promoted'; promoted: Promoted; replaced?: string } | { type: 'demoted'; genomeId: string; reason: string };

export function evaluatePromotions(input: PromotionInput): { file: PromotionsFile; change?: PromotionChange } {
  const { state, criteria: c, cycleMinutes, now } = input;
  const results = input.backtests?.schema === 'mm.arena-backtest-results/v1' ? input.backtests.results : {};
  const prev = input.previous?.schema === 'mm.arena-promotions/v1' ? input.previous : null;
  const notes: string[] = [];
  const marketBlock =
    state.market === 'synthetic'
      ? `arena market is synthetic (${SYNTHETIC_NOTE}): nothing is ever promoted from it`
      : state.market !== 'dexscreener'
        ? `arena market ${state.market} is not live market data: no promotion`
        : undefined;
  if (marketBlock) notes.push(marketBlock);
  const since = state.marketSinceCycle ?? 0;

  // one candidate per genome id (the longest-lived agent carries the evidence)
  const byId = new Map<string, PromotionCandidate>();
  for (const a of state.agents) {
    if (a.species !== 'trader') continue;
    const id = genomeId(a.genome);
    const age = state.cycle - a.bornCycle;
    const existing = byId.get(id);
    if (existing && existing.evidence.liveArenaCycles >= age) continue;
    const reasons: string[] = [];
    if (marketBlock) reasons.push(marketBlock);
    if (a.bornCycle < since) reasons.push(`born before the current market source (cycle ${since})`);
    if (age < c.minCycles) reasons.push(`arena age ${age} < ${c.minCycles} cycles`);
    if (a.stats.trades < c.minTrades) reasons.push(`arena trades ${a.stats.trades} < ${c.minTrades}`);
    const dd = a.maxDrawdown ?? (a.peakBalanceUsd > 0 ? Math.max(0, 1 - (a.cashUsd - a.debtUsd) / a.peakBalanceUsd) : 0);
    if (dd > c.maxDrawdown) reasons.push(`arena drawdown ${(dd * 100).toFixed(1)}% > ${(c.maxDrawdown * 100).toFixed(1)}%`);
    const bt = usableBacktest(results[id], c, cycleMinutes, now);
    const oos = bt.ok ? bt.oos : null;
    if (!bt.ok) reasons.push(bt.reason);
    else reasons.push(...oosFailures(bt.oos, c));
    const evidence: CandidateEvidence = { liveArenaCycles: age, arenaTrades: a.stats.trades, arenaReturn: agentReturn(a), arenaMaxDrawdown: dd, backtestOos: oos };
    byId.set(id, { genomeId: id, agentId: a.id, genome: a.genome, evidence, score: scoreEvidence(evidence), eligible: reasons.length === 0, reasons });
  }
  // backtested genomes without a living agent: listed for visibility, never eligible
  for (const [id, entry] of Object.entries(results)) {
    if (byId.has(id)) continue;
    const bt = usableBacktest(entry, c, cycleMinutes, now);
    const evidence: CandidateEvidence = { liveArenaCycles: 0, arenaTrades: 0, arenaReturn: 0, arenaMaxDrawdown: 0, backtestOos: bt.ok ? bt.oos : null };
    byId.set(id, { genomeId: id, genome: entry.genome, evidence, score: scoreEvidence(evidence), eligible: false, reasons: ['no living agent with this genome in the live arena'] });
  }

  const all = [...byId.values()].sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || (a.genomeId < b.genomeId ? -1 : 1));
  const history = [...(prev?.history ?? [])];
  let promoted = prev?.promoted;
  let change: PromotionChange | undefined;

  // demotion: fresh backtest evidence says the promoted genome no longer holds up out of sample
  let currentScore = promoted?.score ?? Number.NEGATIVE_INFINITY;
  if (promoted) {
    const bt = usableBacktest(results[promoted.genomeId], c, cycleMinutes, now);
    const fails = bt.ok ? oosFailures(bt.oos, c) : [];
    const current = byId.get(promoted.genomeId);
    if (fails.length > 0) {
      const reason = `demoted: ${fails.join('; ')}`;
      const h = history.findLast((x) => x.genomeId === promoted!.genomeId && !x.endedAt);
      if (h) Object.assign(h, { endedAt: now.toISOString(), endReason: reason });
      change = { type: 'demoted', genomeId: promoted.genomeId, reason };
      promoted = undefined;
      currentScore = Number.NEGATIVE_INFINITY;
    } else if (current?.eligible) {
      currentScore = current.score;
      promoted = { ...promoted, score: current.score, evidence: current.evidence };
    }
  }

  const best = marketBlock ? undefined : all.find((x) => x.eligible);
  if (best && best.genomeId !== promoted?.genomeId && (!promoted || best.score > currentScore + c.margin)) {
    const reason = promoted
      ? `score ${best.score.toFixed(4)} beats promoted ${promoted.genomeId} (${currentScore.toFixed(4)}) by > ${c.margin}`
      : `first eligible candidate (score ${best.score.toFixed(4)})`;
    const replaced = promoted?.genomeId;
    if (replaced) {
      const h = history.findLast((x) => x.genomeId === replaced && !x.endedAt);
      if (h) Object.assign(h, { endedAt: now.toISOString(), endReason: `replaced by ${best.genomeId}` });
    }
    promoted = { genomeId: best.genomeId, genome: best.genome, promotedAt: now.toISOString(), reason, score: best.score, evidence: best.evidence, cycleMinutes };
    history.push({ genomeId: best.genomeId, promotedAt: promoted.promotedAt, reason, score: best.score });
    change = { type: 'promoted', promoted, ...(replaced ? { replaced } : {}) };
  }
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  const file: PromotionsFile = {
    schema: 'mm.arena-promotions/v1',
    timestamp: now.toISOString(),
    arenaCycle: state.cycle,
    arenaMarket: state.market,
    cycleMinutes,
    criteria: c,
    notes: [
      ...notes,
      'promotion selects strategy parameters only; it never enables live trading (the trader keeps MODE + LIVE_TRADING_CONFIRM)',
      'evidence is paper/backtest only; out-of-sample gains are not a guarantee of future results',
    ],
    candidates: all.slice(0, MAX_CANDIDATES_LISTED),
    ...(promoted ? { promoted } : {}),
    history,
  };
  return { file, change };
}

export async function readBacktestResults(): Promise<BacktestResults | null> {
  const r = await readJsonSafe<BacktestResults | null>(arenaPaths.backtestResults(), null);
  return r?.schema === 'mm.arena-backtest-results/v1' && r.results && typeof r.results === 'object' ? r : null;
}

/** Merge new backtest results (latest per genome id wins; capped). */
export async function mergeBacktestResults(entries: BacktestResultEntry[], now: Date): Promise<BacktestResults> {
  const current = (await readBacktestResults()) ?? { schema: 'mm.arena-backtest-results/v1' as const, updatedAt: now.toISOString(), results: {} };
  for (const e of entries) current.results[e.genomeId] = e;
  const ids = Object.keys(current.results).sort((a, b) => Date.parse(current.results[b]!.runAt) - Date.parse(current.results[a]!.runAt));
  for (const id of ids.slice(MAX_RESULTS)) delete current.results[id];
  current.updatedAt = now.toISOString();
  await writeJsonAtomic(arenaPaths.backtestResults(), current);
  return current;
}

/** Evaluate + write promotions.json and emit an event on promotion/demotion. */
export async function updatePromotions(
  state: PromotionInput['state'],
  criteria: PromotionCriteria,
  cycleMinutes: number,
  now: Date,
  emit: EmitFn,
): Promise<{ file: PromotionsFile; change?: PromotionChange }> {
  const previous = await readJsonSafe<PromotionsFile | null>(arenaPaths.promotions(), null);
  const backtests = await readBacktestResults();
  const out = evaluatePromotions({ state, backtests, previous, criteria, cycleMinutes, now });
  await writeJsonAtomic(arenaPaths.promotions(), out.file);
  if (out.change?.type === 'promoted') {
    const p = out.change.promoted;
    await emit({
      source: STRATEGY_NAME,
      level: 'info',
      type: 'arena.strategy-promoted',
      message: `genome ${p.genomeId} promoted for solana-trader (STRATEGY_SOURCE=arena): ${p.reason}`,
      data: { genomeId: p.genomeId, replaced: out.change.replaced, score: p.score, evidence: p.evidence },
    });
  } else if (out.change?.type === 'demoted') {
    await emit({
      source: STRATEGY_NAME,
      level: 'warn',
      type: 'arena.strategy-demoted',
      message: `genome ${out.change.genomeId} demoted: ${out.change.reason}`,
      data: { genomeId: out.change.genomeId },
    });
  }
  return out;
}
