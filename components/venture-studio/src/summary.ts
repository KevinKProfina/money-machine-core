import type { ApprovalsFile } from './approvals.js';
import type { StudioConfig } from './config.js';
import type { Control } from './studio.js';
import { studioPaths, type DeployResult, type StudioState } from './state.js';
import type { SalesChannel } from './stripe.js';
import type { VentureState } from './types.js';

export type StudioSummary = {
  schema: 'mm.studio-summary/v1';
  timestamp: string;
  cycle: number;
  channel: 'stripe' | 'none';
  /** Sales are simulated (Stripe test key / simulator). */
  salesSimulated: boolean;
  deployed: boolean;
  lastDeploy?: DeployResult;
  siteDir: string;
  counts: Record<VentureState, number>;
  pendingApprovals: Array<{ ventureId: string; title: string; price: number; currency: string; requestedAt: string; previewPath: string }>;
  live: Array<{ ventureId: string; title: string; slug: string; url: string; price: number; sales: number; revenue: number; currency: string; daysLive: number; state: 'live' | 'winner'; purchasable: boolean }>;
  winners: Array<{ ventureId: string; title: string; sales: number; revenue: number; followUpsSpawned: boolean }>;
  killed: Array<{ ventureId: string; title: string; reason: string; at: string }>;
  blocked: Array<{ ventureId: string; title: string; kind: string; reasons: string[] }>;
  parkedOpportunities: Array<{ ventureId: string; title: string; category: string; autonomyScore: number; humanSteps: string[] }>;
  llm: { enabled: boolean; todayUsd: number; totalUsd: number; dailyBudgetUsd: number; calls: number; refusals: number; failures: number; budgetSkips: number };
  halted: boolean;
  blockers: string[];
  notes: string[];
};

const ALL_STATES: VentureState[] = ['idea', 'parked', 'rejected', 'queued', 'review', 'ready', 'approved', 'live', 'winner', 'killed', 'blocked'];

export function buildSummary(
  state: StudioState,
  cfg: StudioConfig,
  channel: SalesChannel,
  now: Date,
  approvals: ApprovalsFile,
  control: Control,
  cycleNotes: string[],
  llmEnabled: boolean,
): StudioSummary {
  const counts = Object.fromEntries(ALL_STATES.map((s) => [s, 0])) as Record<VentureState, number>;
  for (const v of state.ventures) counts[v.state]++;
  const money = (cents: number) => Math.round(cents) / 100;

  const blockers: string[] = [];
  if (channel.id === 'none') blockers.push('no sales channel: revenue needs STRIPE_API_KEY (landing pages show "coming soon", nothing can become a winner)');
  if (cfg.stripe.refusedReason) blockers.push(cfg.stripe.refusedReason);
  if (!cfg.operator) blockers.push(`publishing blocked: operator details missing (${cfg.operatorMissing.join(', ')}) — required for the Impressum`);
  if (!cfg.siteUrl) blockers.push('publishing blocked: STUDIO_SITE_URL missing');
  if (!cfg.deployCmd) blockers.push('STUDIO_DEPLOY_CMD not set: the site is only written locally, nothing is deployed');
  if (control.halted) blockers.push(`${control.reason}: no ideation, build or publish`);
  if (state.llm.day === now.toISOString().slice(0, 10) && state.llm.dayUsd >= cfg.llm.dailyBudgetUsd * 0.95) blockers.push('daily LLM budget exhausted');

  const notes = [...cfg.notes, ...cycleNotes];
  if (!llmEnabled) notes.push('no ANTHROPIC_API_KEY: offline seed catalog, seed scores and regex-only policy review');
  if (channel.simulated) notes.push('sales are SIMULATED (Stripe test mode); no real money');
  notes.push('per-venture sales are for studio decisions only and are NOT reported to revenue-engine (its Stripe adapter counts the money)');

  const live = state.ventures
    .filter((v) => (v.state === 'live' || v.state === 'winner') && v.publish)
    .map((v) => ({
      ventureId: v.id,
      title: v.title,
      slug: v.slug,
      url: v.publish!.url,
      price: v.idea.price,
      sales: v.sales?.count ?? 0,
      revenue: money(v.sales?.revenueCents ?? 0),
      currency: cfg.currency,
      daysLive: Math.round(((now.getTime() - Date.parse(v.publish!.publishedAt ?? v.updatedAt)) / 86_400_000) * 10) / 10,
      state: v.state as 'live' | 'winner',
      purchasable: Boolean(v.publish!.stripe?.paymentLinkUrl && !v.publish!.stripe.deactivated),
    }));

  const lastAt = (v: (typeof state.ventures)[number]) => v.history[v.history.length - 1]?.ts ?? v.updatedAt;

  return {
    schema: 'mm.studio-summary/v1',
    timestamp: now.toISOString(),
    cycle: state.cycle,
    channel: channel.id,
    salesSimulated: channel.simulated,
    deployed: state.site.lastDeploy?.ok === true,
    ...(state.site.lastDeploy ? { lastDeploy: state.site.lastDeploy } : {}),
    siteDir: studioPaths.site(),
    counts,
    pendingApprovals: approvals.requests
      .filter((r) => r.decision === undefined)
      .map((r) => ({ ventureId: r.ventureId, title: r.title, price: r.price, currency: r.currency, requestedAt: r.requestedAt, previewPath: r.previewPath })),
    live,
    winners: state.ventures
      .filter((v) => v.state === 'winner')
      .map((v) => ({ ventureId: v.id, title: v.title, sales: v.sales?.count ?? 0, revenue: money(v.sales?.revenueCents ?? 0), followUpsSpawned: Boolean(v.followUpsSpawned) })),
    killed: state.ventures
      .filter((v) => v.state === 'killed')
      .slice(-20)
      .map((v) => ({ ventureId: v.id, title: v.title, reason: v.killedReason ?? '', at: lastAt(v) })),
    blocked: state.ventures.filter((v) => v.state === 'blocked').map((v) => ({ ventureId: v.id, title: v.title, kind: v.blocked?.kind ?? 'unknown', reasons: v.blocked?.reasons ?? [] })),
    parkedOpportunities: state.ventures
      .filter((v) => v.state === 'parked')
      .map((v) => ({ ventureId: v.id, title: v.title, category: v.idea.category, autonomyScore: v.autonomyScore, humanSteps: v.humanSteps })),
    llm: {
      enabled: llmEnabled,
      todayUsd: state.llm.day === now.toISOString().slice(0, 10) ? round4(state.llm.dayUsd) : 0,
      totalUsd: round4(state.llm.totalUsd),
      dailyBudgetUsd: cfg.llm.dailyBudgetUsd,
      calls: state.llm.calls,
      refusals: state.llm.refusals,
      failures: state.llm.failures,
      budgetSkips: state.llm.budgetSkips,
    },
    halted: control.halted,
    blockers,
    notes,
  };
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

export function summaryText(s: StudioSummary): string {
  const c = s.counts;
  const lines = [
    `venture-studio cycle ${s.cycle} @ ${s.timestamp}  channel=${s.channel}${s.salesSimulated ? ' (SIMULATED)' : ''}  deployed=${s.deployed}`,
    `states: idea ${c.idea} · queued ${c.queued} · review ${c.review} · ready ${c.ready} · approved ${c.approved} · live ${c.live} · winner ${c.winner} · killed ${c.killed} · blocked ${c.blocked} · rejected ${c.rejected} · parked ${c.parked}`,
    `LLM: today $${s.llm.todayUsd.toFixed(3)} / $${s.llm.dailyBudgetUsd} · total $${s.llm.totalUsd.toFixed(3)} · calls ${s.llm.calls}${s.llm.enabled ? '' : ' (disabled)'}`,
  ];
  if (s.pendingApprovals.length) {
    lines.push('', 'PENDING APPROVAL (npm run approve -- <id> | npm run reject -- <id> [note]):');
    for (const p of s.pendingApprovals) lines.push(`  ${p.ventureId}  ${p.title}  ${p.price} ${p.currency.toUpperCase()}  preview: ${p.previewPath}`);
  }
  if (s.live.length) {
    lines.push('', 'LIVE:');
    for (const l of s.live) lines.push(`  ${l.ventureId}  [${l.state}] ${l.title}  ${l.url}  sales ${l.sales}  revenue ${l.revenue} ${l.currency.toUpperCase()}  ${l.daysLive}d${l.purchasable ? '' : '  (not purchasable)'}`);
  }
  if (s.parkedOpportunities.length) {
    lines.push('', 'OPPORTUNITIES NEEDING A HUMAN:');
    for (const p of s.parkedOpportunities) lines.push(`  ${p.title} (${p.category}, autonomy ${p.autonomyScore}): ${p.humanSteps.join('; ')}`);
  }
  if (s.blocked.length) {
    lines.push('', 'BLOCKED:');
    for (const b of s.blocked) lines.push(`  ${b.ventureId} ${b.title} [${b.kind}]: ${b.reasons.join('; ').slice(0, 200)}`);
  }
  if (s.killed.length) {
    lines.push('', 'KILLED (last 20):');
    for (const k of s.killed) lines.push(`  ${k.title}: ${k.reason}`);
  }
  if (s.blockers.length) lines.push('', 'BLOCKERS:', ...s.blockers.map((b) => `  - ${b}`));
  if (s.notes.length) lines.push('', 'NOTES:', ...s.notes.map((n) => `  - ${n}`));
  return lines.join('\n');
}
