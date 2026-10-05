import { computeTargets, finalizeAllocations, floorCents, proposalProblem } from './allocation.js';
import type { OrchestratorConfig } from './config.js';
import { assessStrategy, type HealthAssessment } from './health.js';
import {
  emitEvent,
  isKillSwitchActive,
  readJsonSafe,
  readStrategyReports,
  statePaths,
  writeJsonAtomic,
  type AllocationProposal,
  type FinalAllocations,
  type MMEvent,
  type PortfolioState,
  type RevenueReport,
  type StrategyReport,
} from './mm-contract.js';
import { applyProfitDelta, computeProfitDelta, portfolioEquity, totalCapital } from './reinvestment.js';
import { HISTORY_LIMIT, loadState, saveState, type OrchestratorState } from './state.js';

export type DecisionInput = {
  config: OrchestratorConfig;
  reports: StrategyReport[];
  proposal: AllocationProposal | null;
  revenue: RevenueReport | null;
  previous: FinalAllocations | null;
  state: OrchestratorState;
  globalKill: boolean;
  now: Date;
};

/** PortfolioState plus extra (contract-compatible) fields. */
export type PortfolioStateExt = PortfolioState & {
  realProfitUsd: number;
  simulatedProfitUsd: number;
  anyLive: boolean;
  notes: string[];
};

export const SYNTHETIC_DATA_NOTE = 'synthetic-market-data';
export const isSyntheticData = (r: StrategyReport): boolean =>
  Array.isArray(r.notes) && r.notes.some((n) => typeof n === 'string' && n.includes(SYNTHETIC_DATA_NOTE));

export type Decision = {
  allocations: FinalAllocations;
  portfolio: PortfolioStateExt;
  state: OrchestratorState;
  events: Array<Omit<MMEvent, 'ts'>>;
  assessments: HealthAssessment[];
  log: string[];
};

const SOURCE = 'orchestrator';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Pure decision step: everything the orchestrator decides in one cycle, without IO. */
export function decide(input: DecisionInput): Decision {
  const { config, proposal, revenue, previous, state, globalKill, now } = input;
  const ts = now.toISOString();
  const log: string[] = [];
  const events: Decision['events'] = [];

  // Deduplicate by name (first report wins).
  const seen = new Set<string>();
  const reports = input.reports.filter((r) => {
    if (typeof r.name !== 'string' || !r.name || seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
  const names = reports.map((r) => r.name);

  // Simulated profit must never fund live strategies: once anything runs live, capital and
  // drawdown are computed on the real ledger only.
  const anyLive = reports.some((r) => r.mode === 'live');

  // ---- realized profit & reinvestment ----
  const delta = computeProfitDelta(reports, revenue, state.lastRealizedPnlByStrategy, state.lastRevenueByStream);
  const unrealized = reports
    .filter((r) => !anyLive || r.mode === 'live')
    .reduce((s, r) => s + (finite(r.unrealizedPnlUsd) ? r.unrealizedPnlUsd : 0), 0);
  // Equity does not depend on the reinvest/retain split, so compute it first for the drawdown check.
  const provReal = applyProfitDelta(state.real, delta.realDeltaUsd, config.reinvestmentPercent, false);
  const provSim = applyProfitDelta(state.simulated, delta.simulatedDeltaUsd, config.reinvestmentPercent, false);
  const equity = portfolioEquity(config.baseCapitalUsd, provReal, provSim, anyLive, unrealized);
  const hwmKey = anyLive ? 'real' : 'combined';
  const prevHwm = state.highWaterMarkUsd[hwmKey];
  // Without history the high-water mark starts at base capital, so a loss in the very first cycle
  // counts. After an operator reset (HWM_REBASE) it restarts from the current equity instead.
  const hwmStart = prevHwm === HWM_REBASE ? equity : prevHwm > 0 ? prevHwm : config.baseCapitalUsd;
  const hwm = Math.max(hwmStart, equity);
  const drawdown = hwm > 0 ? Math.max(0, (hwm - equity) / hwm) : 0;

  const killTrippedNow = !state.killSwitch.tripped && drawdown >= config.maxPortfolioDrawdown;
  const killLatched = state.killSwitch.tripped || killTrippedNow;
  const killed = killLatched || globalKill;
  const allowReinvest = !killed && drawdown < config.maxPortfolioDrawdown;
  const real = applyProfitDelta(state.real, delta.realDeltaUsd, config.reinvestmentPercent, allowReinvest);
  const simulated = applyProfitDelta(state.simulated, delta.simulatedDeltaUsd, config.reinvestmentPercent, allowReinvest && !anyLive);
  const reinvestedNow = real.reinvestedNowUsd + simulated.reinvestedNowUsd;
  const notes: string[] = [
    `real profit delta $${delta.realDeltaUsd.toFixed(2)} (reinvested $${real.reinvestedNowUsd.toFixed(2)}, cumulative reinvested $${real.reinvestedUsd.toFixed(2)})`,
    `simulated profit delta $${delta.simulatedDeltaUsd.toFixed(2)} (reinvested $${simulated.reinvestedNowUsd.toFixed(2)}, cumulative reinvested $${simulated.reinvestedUsd.toFixed(2)})`,
    anyLive
      ? 'a strategy runs live: capital counts real profit only; simulated profit is not reinvested'
      : 'no live strategy: full loop is simulated, simulated profit may be reinvested (notional capital)',
  ];
  if (!allowReinvest && delta.deltaUsd > 0) notes.push('reinvestment blocked: drawdown limit / kill switch');
  if (delta.deltaUsd !== 0) {
    log.push(
      `realized delta $${delta.deltaUsd.toFixed(2)} (strategies $${delta.tradingDeltaUsd.toFixed(2)}, non-trading revenue $${delta.nonTradingDeltaUsd.toFixed(2)})`,
    );
  }
  log.push(...notes, ...delta.notes);

  const T = totalCapital(config.baseCapitalUsd, real, simulated, anyLive);
  const assessments = reports.map((r) => {
    const a = assessStrategy(r, config, now);
    if (anyLive && isSyntheticData(r) && !a.paused) {
      a.paused = true;
      a.exposureFactor = 0;
      a.reasons.push(`paused: runs on synthetic market data while live strategies exist`);
    }
    return a;
  });
  const reasons: Record<string, string> = {};
  let allocations: Record<string, number> = {};
  let paused: string[];

  if (killed) {
    const why = globalKill
      ? 'global kill switch active (KILL file or MM_KILL=1)'
      : (state.killSwitch.reason ?? `portfolio drawdown ${pct(drawdown)} >= ${pct(config.maxPortfolioDrawdown)}`);
    for (const n of names) {
      allocations[n] = 0;
      reasons[n] = `kill switch: ${why}`;
    }
    paused = [...names];
    if (killTrippedNow) {
      events.push({
        source: SOURCE,
        level: 'error',
        type: 'kill-switch-tripped',
        message: `Portfolio drawdown ${pct(drawdown)} >= limit ${pct(config.maxPortfolioDrawdown)} — all allocations set to 0`,
        data: { drawdown, equity, highWaterMark: hwm },
      });
    } else if (globalKill && !previous?.killSwitch) {
      events.push({ source: SOURCE, level: 'warn', type: 'kill-switch-honored', message: 'Global kill switch active — all allocations set to 0' });
    }
    log.push(`KILL SWITCH: ${why}`);
  } else {
    if (proposal && proposal.riskProfile && proposal.riskProfile !== config.riskProfile) {
      log.push(`warning: proposal risk profile ${proposal.riskProfile} != orchestrator RISK_PROFILE ${config.riskProfile}`);
    }
    // Reduce total exposure as portfolio drawdown approaches the limit (linear from 50 % to 100 % of it).
    const half = config.maxPortfolioDrawdown / 2;
    const portfolioScale = drawdown <= half ? 1 : Math.max(0, (config.maxPortfolioDrawdown - drawdown) / half);
    if (portfolioScale < 1) log.push(`portfolio drawdown ${pct(drawdown)} -> exposure x${portfolioScale.toFixed(2)}`);
    const reserve = config.reservePct * T;
    const deployable = Math.max(0, (T - reserve) * portfolioScale);

    const issue = proposalProblem(proposal, now, config.staleReportMs);
    if (issue) log.push(`${issue} — falling back to equal split among healthy strategies`);
    const t = computeTargets(assessments, proposal, issue, deployable);
    const pausedSet = new Set(assessments.filter((a) => a.paused).map((a) => a.name));
    const prevUsable = previous && previous.schema === 'mm.allocations/v1' && !previous.killSwitch;
    const prevMap = previous && previous.schema === 'mm.allocations/v1'
      ? (prevUsable ? previous.allocations : {}) // after a kill, ramp back up from 0
      : null; // first cycle: no smoothing
    allocations = finalizeAllocations(t.targets, {
      previous: prevMap,
      paused: pausedSet,
      maxStepUsd: config.maxRebalanceStepPct * T,
      capUsd: config.maxStrategyExposure * T,
      deployableUsd: deployable,
    });
    for (const a of assessments) {
      const parts = [...a.reasons];
      if (t.reasons[a.name]) parts.push(t.reasons[a.name]!);
      if (!a.paused && Math.abs((allocations[a.name] ?? 0) - (t.targets[a.name] ?? 0)) > 0.01) {
        parts.push(`target $${(t.targets[a.name] ?? 0).toFixed(2)} (smoothed/capped)`);
      }
      reasons[a.name] = parts.join('; ');
    }
    paused = [...pausedSet];
    const prevPaused = new Set(previous?.paused ?? []);
    for (const a of assessments.filter((x) => x.paused && !prevPaused.has(x.name))) {
      events.push({
        source: SOURCE,
        level: 'warn',
        type: 'strategy-paused',
        message: `${a.name} paused: ${a.reasons.filter((r) => r.startsWith('paused')).join('; ')}`,
        data: { strategy: a.name, health: a.health },
      });
    }
  }

  const allocated = Object.values(allocations).reduce((s, v) => s + v, 0);
  const unallocated = floorCents(T - allocated);
  const totalPnl =
    reports.reduce((s, r) => s + (finite(r.realizedPnlUsd) ? r.realizedPnlUsd : 0) + (finite(r.unrealizedPnlUsd) ? r.unrealizedPnlUsd : 0), 0) +
    delta.countedRevenueTotalUsd;
  const avgHealth = assessments.length ? assessments.reduce((s, a) => s + a.health, 0) / assessments.length : 100;
  const riskScore = killed
    ? 100
    : Math.min(100, Math.max(0, 60 * (drawdown / config.maxPortfolioDrawdown) + 0.4 * (100 - avgHealth)));
  const maxDrawdownSeen = Math.max(state.maxDrawdownSeen, drawdown);

  const finalAllocations: FinalAllocations = {
    schema: 'mm.allocations/v1',
    timestamp: ts,
    totalCapitalUsd: floorCents(T),
    reserveUsd: unallocated,
    allocations,
    paused: paused.sort(),
    killSwitch: killed,
    reasons,
  };
  const portfolio: PortfolioStateExt = {
    schema: 'mm.portfolio/v1',
    timestamp: ts,
    totalCapitalUsd: floorCents(T),
    allocatedUsd: Math.round(allocated * 100) / 100,
    reserveUsd: unallocated,
    totalPnlUsd: Math.round(totalPnl * 100) / 100,
    portfolioReturn: config.baseCapitalUsd > 0 ? totalPnl / config.baseCapitalUsd : 0,
    maxDrawdown: maxDrawdownSeen,
    riskScore: Math.round(riskScore * 10) / 10,
    activeStrategies: names.filter((n) => !paused.includes(n)),
    pausedStrategies: [...paused].sort(),
    reinvestedUsd: Math.round((real.reinvestedUsd + (anyLive ? 0 : simulated.reinvestedUsd)) * 100) / 100,
    realProfitUsd: Math.round((real.reinvestedUsd + real.retainedProfitUsd - real.lossCarryforwardUsd) * 100) / 100,
    simulatedProfitUsd:
      Math.round((simulated.reinvestedUsd + simulated.retainedProfitUsd - simulated.lossCarryforwardUsd) * 100) / 100,
    anyLive,
    notes,
  };
  const nextState: OrchestratorState = {
    ...state,
    updatedAt: ts,
    real: { reinvestedUsd: real.reinvestedUsd, retainedProfitUsd: real.retainedProfitUsd, lossCarryforwardUsd: real.lossCarryforwardUsd },
    simulated: {
      reinvestedUsd: simulated.reinvestedUsd,
      retainedProfitUsd: simulated.retainedProfitUsd,
      lossCarryforwardUsd: simulated.lossCarryforwardUsd,
    },
    highWaterMarkUsd: { ...state.highWaterMarkUsd, [hwmKey]: hwm },
    maxDrawdownSeen,
    lastRealizedPnlByStrategy: delta.nextRealizedByStrategy,
    lastRevenueByStream: delta.nextRevenueByStream,
    killSwitch: killTrippedNow
      ? { tripped: true, reason: `portfolio drawdown ${pct(drawdown)} >= ${pct(config.maxPortfolioDrawdown)}`, at: ts }
      : state.killSwitch,
    history: [
      ...state.history,
      {
        ts,
        totalCapitalUsd: T,
        equityUsd: equity,
        drawdown,
        realProfitDeltaUsd: delta.realDeltaUsd,
        simulatedProfitDeltaUsd: delta.simulatedDeltaUsd,
        reinvestedUsd: reinvestedNow,
        anyLive,
        allocatedUsd: allocated,
        killSwitch: killed,
      },
    ].slice(-HISTORY_LIMIT),
  };
  return { allocations: finalAllocations, portfolio, state: nextState, events, assessments, log };
}

/** One orchestrator cycle with real IO against $MM_STATE_DIR. */
export async function runCycle(config: OrchestratorConfig, now: Date = new Date()): Promise<Decision> {
  const [reports, proposal, revenue, previous, state] = await Promise.all([
    readStrategyReports(),
    readJsonSafe<AllocationProposal | null>(statePaths.proposal(), null),
    readJsonSafe<RevenueReport | null>(statePaths.revenue(), null),
    readJsonSafe<FinalAllocations | null>(statePaths.allocations(), null),
    loadState(),
  ]);
  if (reports.length === 0) console.log(`[orchestrator] no strategy reports in ${statePaths.strategiesDir()}`);
  const decision = decide({
    config,
    reports,
    proposal,
    revenue,
    previous: previous?.schema === 'mm.allocations/v1' ? previous : null,
    state,
    globalKill: isKillSwitchActive(),
    now,
  });

  await writeJsonAtomic(statePaths.allocations(), decision.allocations);
  await writeJsonAtomic(statePaths.portfolio(), decision.portfolio);
  await saveState(decision.state);
  for (const e of decision.events) await emitEvent(e);

  for (const line of decision.log) console.log(`[orchestrator] ${line}`);
  const a = decision.allocations;
  console.log(
    `[orchestrator] capital $${a.totalCapitalUsd.toFixed(2)}, allocated $${decision.portfolio.allocatedUsd.toFixed(2)}, unallocated/reserve $${a.reserveUsd.toFixed(2)}, killSwitch=${a.killSwitch}`,
  );
  for (const [name, usd] of Object.entries(a.allocations)) {
    console.log(`  ${name.padEnd(24)} $${usd.toFixed(2).padStart(10)}  ${a.reasons[name] ?? ''}`);
  }
  return decision;
}

/** Clears a latched drawdown kill switch and re-anchors the high-water mark on the next cycle. */
/** Sentinel high-water mark: rebase to current equity on the next cycle (set by an operator reset). */
export const HWM_REBASE = -1;

export async function resetKillSwitch(): Promise<void> {
  const state = await loadState();
  await saveState({
    ...state,
    killSwitch: { tripped: false, reason: null, at: null },
    highWaterMarkUsd: { combined: HWM_REBASE, real: HWM_REBASE },
  });
  await emitEvent({ source: SOURCE, level: 'warn', type: 'kill-switch-reset', message: 'Drawdown kill switch reset by operator' });
}
