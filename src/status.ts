import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  isKillSwitchActive,
  readJsonSafe,
  readStrategyReports,
  stateDir,
  statePaths,
  type FinalAllocations,
  type MarketplaceReport,
  type MMEvent,
  type PortfolioState,
  type RevenueReport,
  type StrategyReport,
} from '../contract/mm-contract.js';
import type { StepResult, DaemonState } from './runner.js';
import { readStudioSummary, type StudioSummary } from './studio.js';

export type SupervisorState = {
  startedAt?: string;
  lastBackup?: { at: string; file?: string; error?: string };
  cycles: number;
  lastCycle?: { startedAt: string; finishedAt: string; ok: boolean; steps: StepResult[] };
  daemons: DaemonState[];
};

export const supervisorStatePath = () => path.join(stateDir(), 'core', 'supervisor.json');
export const arenaSummaryPath = () => path.join(stateDir(), 'arena', 'summary.json');

/** The fields of agent-arena's summary.json that core displays (the file carries more). */
export type ArenaSummary = {
  schema: 'mm.arena-summary/v1';
  timestamp: string;
  cycle: number;
  population: number;
  maxGeneration: number;
  treasuryUsd: number;
  equityUsd: number;
  births?: { total: number; lastCycle: number };
  deaths?: { total: number; lastCycle: number };
  leaderboard?: { id: string; generation: number; balanceUsd: number; return: number; ageCycles: number }[];
};

export type SystemStatus = {
  timestamp: string;
  stateDir: string;
  killSwitch: { active: boolean; reason?: string };
  strategies: (StrategyReport & { stale: boolean })[];
  allocations: FinalAllocations | null;
  portfolio: PortfolioState | null;
  revenue: RevenueReport | null;
  marketplace: Omit<MarketplaceReport, 'revenueEvents'> | null;
  supervisor: SupervisorState | null;
  arena: ArenaSummary | null;
  studio: StudioSummary | null;
  events: MMEvent[];
  warnings: string[];
};

export async function readRecentEvents(limit = 50): Promise<MMEvent[]> {
  let content = '';
  try {
    content = await fsp.readFile(statePaths.events(), 'utf8');
  } catch {
    return [];
  }
  const events: MMEvent[] = [];
  for (const line of content.trim().split('\n').slice(-limit)) {
    try {
      events.push(JSON.parse(line) as MMEvent);
    } catch {
      // skip corrupt line
    }
  }
  return events.reverse();
}

export async function collectStatus(staleAfterMs = 30 * 60_000, now = Date.now()): Promise<SystemStatus> {
  const warnings: string[] = [];
  const reports = await readStrategyReports();
  const strategies = reports.map((r) => ({ ...r, stale: now - Date.parse(r.lastUpdated) > staleAfterMs }));
  for (const s of strategies) {
    if (s.stale) warnings.push(`strategy ${s.name} report is stale (last update ${s.lastUpdated})`);
    if (s.mode === 'live') warnings.push(`strategy ${s.name} is running in LIVE mode with real funds`);
  }

  const allocations = await readJsonSafe<FinalAllocations | null>(statePaths.allocations(), null);
  const portfolio = await readJsonSafe<PortfolioState | null>(statePaths.portfolio(), null);
  const revenue = await readJsonSafe<RevenueReport | null>(statePaths.revenue(), null);
  const market = await readJsonSafe<MarketplaceReport | null>(statePaths.marketplace(), null);
  const supervisor = await readJsonSafe<SupervisorState | null>(supervisorStatePath(), null);
  const arenaRaw = await readJsonSafe<ArenaSummary | null>(arenaSummaryPath(), null);
  const arena = arenaRaw?.schema === 'mm.arena-summary/v1' ? arenaRaw : null;

  let reason: string | undefined;
  const killActive = isKillSwitchActive();
  if (killActive) {
    try {
      reason = (await fsp.readFile(statePaths.kill(), 'utf8')).trim() || undefined;
    } catch {
      reason = process.env.MM_KILL === '1' ? 'MM_KILL=1' : undefined;
    }
  }
  if (allocations?.killSwitch && !killActive) warnings.push('orchestrator tripped its drawdown kill switch');
  if (supervisor?.lastCycle && !supervisor.lastCycle.ok) {
    const failed = supervisor.lastCycle.steps.filter((s) => !s.ok).map((s) => s.name);
    warnings.push(`last cycle had failing components: ${failed.join(', ')}`);
  }

  let marketplace: SystemStatus['marketplace'] = null;
  if (market) {
    const { revenueEvents: _omit, ...rest } = market;
    marketplace = rest;
  }

  return {
    timestamp: new Date(now).toISOString(),
    stateDir: stateDir(),
    killSwitch: { active: killActive, reason },
    strategies,
    allocations,
    portfolio,
    revenue,
    marketplace,
    supervisor,
    arena,
    studio: await readStudioSummary(),
    events: await readRecentEvents(),
    warnings,
  };
}

const usd = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? '-' : `$${n.toFixed(2)}`);
const pct = (n: number | undefined) => (n === undefined || !Number.isFinite(n) ? '-' : `${(n * 100).toFixed(1)}%`);

export function formatStatus(status: SystemStatus): string {
  const lines: string[] = [];
  lines.push(`Money Machine status @ ${status.timestamp}`);
  lines.push(`state dir: ${status.stateDir}`);
  lines.push(`kill switch: ${status.killSwitch.active ? `ACTIVE${status.killSwitch.reason ? ` (${status.killSwitch.reason})` : ''}` : 'off'}`);
  lines.push('');

  if (status.portfolio) {
    const p = status.portfolio;
    lines.push(`Portfolio: capital ${usd(p.totalCapitalUsd)} | allocated ${usd(p.allocatedUsd)} | reserve ${usd(p.reserveUsd)} | pnl ${usd(p.totalPnlUsd)} | return ${pct(p.portfolioReturn)} | max dd ${pct(p.maxDrawdown)} | risk ${p.riskScore.toFixed(0)}`);
  } else {
    lines.push('Portfolio: no orchestrator snapshot yet');
  }
  lines.push('');

  lines.push('Strategies:');
  if (status.strategies.length === 0) lines.push('  (no strategy reports yet)');
  for (const s of status.strategies) {
    const budget = status.allocations?.allocations[s.name];
    lines.push(
      `  ${s.name.padEnd(22)} ${s.mode.padEnd(7)} ${s.status.padEnd(7)} budget ${usd(budget).padStart(10)} pnl ${usd(s.realizedPnlUsd + s.unrealizedPnlUsd).padStart(10)} ret ${pct(s.totalReturn).padStart(7)} win ${pct(s.winRate).padStart(6)} dd ${pct(s.maxDrawdown).padStart(6)} trades ${s.totalTrades}${s.stale ? '  [STALE]' : ''}`,
    );
  }
  lines.push('');

  if (status.revenue) {
    lines.push(`Revenue: total ${usd(status.revenue.totalUsd)} | 7d ${usd(status.revenue.last7dUsd)} | 30d ${usd(status.revenue.last30dUsd)} | concentration ${status.revenue.concentration.toFixed(2)}`);
    for (const [name, stream] of Object.entries(status.revenue.streams)) {
      lines.push(`  ${name.padEnd(22)} ${stream.kind.padEnd(16)} ${usd(stream.totalUsd).padStart(10)}${stream.simulated ? '  (simulated)' : ''}`);
    }
  } else {
    lines.push('Revenue: no report yet');
  }
  lines.push('');

  if (status.marketplace) {
    const m = status.marketplace;
    lines.push(`Marketplace: ${m.agents} agents, ${m.services} services, jobs ${m.jobsCompleted} ok / ${m.jobsFailed} failed, volume ${usd(m.grossVolumeUsd)}, platform revenue ${usd(m.platformRevenueUsd)}`);
  } else {
    lines.push('Marketplace: no report yet');
  }

  if (status.arena) {
    const a = status.arena;
    lines.push('');
    lines.push(`Arena: cycle ${a.cycle} | population ${a.population} | max generation ${a.maxGeneration} | equity ${usd(a.equityUsd)} | treasury ${usd(a.treasuryUsd)}${a.births ? ` | births ${a.births.total} / deaths ${a.deaths?.total ?? 0}` : ''}`);
    for (const agent of (a.leaderboard ?? []).slice(0, 5)) {
      lines.push(`  ${agent.id.padEnd(22)} gen ${String(agent.generation).padStart(3)} balance ${usd(agent.balanceUsd).padStart(10)} return ${pct(agent.return).padStart(7)} age ${agent.ageCycles}`);
    }
  }

  if (status.studio) {
    const st = status.studio;
    lines.push('');
    const counts = Object.entries(st.counts ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
    lines.push(`Venture studio: channel ${st.channel ?? '-'}${counts ? ` | ${counts}` : ''}`);
    for (const p of st.pendingApprovals ?? []) lines.push(`  awaiting approval: ${p.ventureId} "${p.title}" ${usd(p.price)}`);
    for (const v of st.live ?? []) lines.push(`  live: ${v.title} ${usd(v.price)} sales ${v.sales} revenue ${usd(v.revenue)} (${v.daysLive}d)`);
    for (const b of st.blockers ?? []) lines.push(`  blocker: ${b}`);
  }

  if (status.supervisor?.lastCycle) {
    const c = status.supervisor.lastCycle;
    lines.push('');
    lines.push(`Last cycle (${c.finishedAt}): ${c.ok ? 'ok' : 'FAILED'}`);
    for (const step of c.steps) {
      lines.push(`  ${step.name.padEnd(22)} ${step.skipped ? `skipped: ${step.skipped}` : step.ok ? `ok (${step.durationMs} ms)` : step.timedOut ? 'TIMEOUT' : `exit ${step.exitCode}`}`);
    }
  }

  if (status.warnings.length) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of status.warnings) lines.push(`  ! ${w}`);
  }
  return lines.join('\n');
}
