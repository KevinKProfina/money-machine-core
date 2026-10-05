import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { appendDecision, pendingApprovals } from './approvals.js';
import { readConfig } from './config.js';
import type { DeployResult } from './state.js';
import { StripeChannel } from './stripe.js';
import { Studio } from './studio.js';
import { summaryText } from './summary.js';
import { funnelLine, type Diagnosis } from './funnel.js';
import { FakeCollector } from './testing/fake-analytics.js';
import { FakeLlm } from './testing/fake-llm.js';
import { FakeStripe } from './testing/fake-stripe.js';
import { hash01, Rng } from './testing/rng.js';
import type { VentureState } from './types.js';

/**
 * Offline funnel simulation in a temporary state dir (never the real MM_STATE_DIR):
 * fake Claude, fake Stripe (test key → simulated), fake deploy, fake analytics collector
 * (shared state dir), virtual clock, seeded traffic/click/checkout behaviour per product
 * (most products get little traffic or interest).  `--auto-approve` exists ONLY here, to exercise the funnel past the gate.
 *   npm run simulate -- --days 60 --seed 1 --auto-approve
 */
export async function simulate(argv: string[]): Promise<{ text: string; stateDir: string; funnel: Record<string, number>; diagnoses: Partial<Record<Diagnosis, number>> }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      days: { type: 'string', default: '60' },
      seed: { type: 'string', default: '1' },
      'auto-approve': { type: 'boolean', default: false },
      'cycles-per-day': { type: 'string', default: '4' },
      quiet: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const days = Number(values.days);
  const perDay = Number(values['cycles-per-day']);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error('--days must be in (0, 3650]');
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > 96) throw new Error('--cycles-per-day must be an integer 1..96');
  const autoApprove = values['auto-approve'];
  const seed = values.seed;

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'venture-studio-sim-'));
  process.env.MM_STATE_DIR = stateDir;
  delete process.env.MM_KILL;
  const cfg = readConfig({
    MODE: 'paper',
    STUDIO_SITE_URL: 'https://shop.example.test',
    STUDIO_OPERATOR_NAME: 'Simulated Operator',
    STUDIO_OPERATOR_ADDRESS: 'Simulationsweg 1, 12345 Teststadt',
    STUDIO_OPERATOR_EMAIL: 'sim@example.test',
    STUDIO_DEPLOY_CMD: 'simulated',
    STUDIO_ANALYTICS_URL: 'https://stats.example.test',
  });
  const collector = new FakeCollector(cfg.analytics.site!, new Date(Date.UTC(2026, 0, 1)));

  const base = Date.UTC(2026, 0, 1);
  let tick = 0;
  const intervalMs = 86_400_000 / perDay;
  const now = () => new Date(base + tick * intervalMs);
  const fakeStripe = new FakeStripe();
  const llm = new FakeLlm({ seed });
  let deploys = 0;
  const deploy = async (): Promise<DeployResult> => {
    deploys++;
    return { ok: true, at: now().toISOString(), code: 0, timedOut: false, durationMs: 0, outputTail: 'simulated deploy' };
  };
  const studio = await Studio.open({
    cfg,
    now,
    llm,
    channel: new StripeChannel('sk_test_simulated', { fetchImpl: fakeStripe.fetch, backoffMs: 1 }),
    deploy,
    emit: async () => undefined,
    log: () => undefined,
    control: async () => ({ halted: false }),
  });

  const rng = new Rng(`world:${seed}`);
  // Seeded behaviour per product (the "world"): most products get little traffic or interest.
  type Profile = { kind: string; visitsPerDay: number; clickRate: number; completion: number };
  const profileOf = (slug: string): Profile => {
    const h = hash01(`${seed}:${slug}`);
    if (h < 0.4) return { kind: 'invisible', visitsPerDay: 0.8, clickRate: 0.05, completion: 0.5 };
    if (h < 0.7) return { kind: 'boring', visitsPerDay: 12, clickRate: 0.004, completion: 0.5 };
    if (h < 0.85) return { kind: 'leaky-checkout', visitsPerDay: 8, clickRate: 0.06, completion: 0.04 };
    return { kind: 'good', visitsPerDay: 10, clickRate: 0.06, completion: 0.5 };
  };
  const draws = (expected: number) => Math.floor(expected) + (rng.next() < expected - Math.floor(expected) ? 1 : 0);
  const referrers = ['google.com', 'duckduckgo.com', 'bing.com', 'ecosia.org'];
  const simulateTraffic = (at: Date) => {
    collector.bot(at, draws(3 / perDay));
    const catalogVisits = draws(2 / perDay);
    for (let k = 0; k < catalogVisits; k++) collector.record(at, '/', 'pageview', { newVisitor: rng.next() < 0.8, ref: rng.pick(referrers) });
    for (const v of studio.state.ventures) {
      if ((v.state !== 'live' && v.state !== 'winner') || !v.publish?.publishedAt) continue;
      const prof = profileOf(v.slug);
      const linkId = v.publish.stripe?.paymentLinkId;
      const purchasable = Boolean(linkId && fakeStripe.links.get(linkId)?.active);
      const visits = draws(prof.visitsPerDay / perDay);
      for (let k = 0; k < visits; k++) {
        collector.record(at, `/${v.slug}/`, 'pageview', { newVisitor: rng.next() < 0.8, ...(rng.next() < 0.6 ? { ref: rng.pick(referrers) } : {}) });
        if (!purchasable || rng.next() >= prof.clickRate) continue;
        collector.record(at, `/${v.slug}/`, 'buy_click');
        if (rng.next() < prof.completion) {
          fakeStripe.sell(linkId!);
          if (v.idea.category !== 'micro-tool') collector.record(at, `/${v.slug}/`, 'download'); // micro-tool download pages carry no beacon
        } else fakeStripe.abandon(linkId!, rng.next() < 0.9 ? 'expired' : 'open');
      }
    }
    collector.flush(at);
  };

  const totalCycles = Math.round(days * perDay);
  const lines: string[] = [];
  for (let i = 0; i < totalCycles; i++) {
    tick = i;
    simulateTraffic(now());
    await studio.cycle();
    if (autoApprove) {
      for (const p of await pendingApprovals()) await appendDecision({ ventureId: p.ventureId, decision: 'approved', decidedBy: 'simulate:auto-approve', decidedAt: now().toISOString() });
    }
    if (!values.quiet && (i + 1) % (perDay * 10) === 0) {
      const c = countStates(studio.state.ventures.map((v) => v.state));
      lines.push(`  day ${String((i + 1) / perDay).padStart(3)}: ventures ${studio.state.ventures.length}, live ${c.live ?? 0}, winners ${c.winner ?? 0}, killed ${c.killed ?? 0}, pending ${c.ready ?? 0}, sales ${fakeStripe.paidSessions().length}`);
    }
  }
  const summary = await studio.persist();

  const ever = (s: VentureState) => studio.state.ventures.filter((v) => v.history.some((h) => h.to === s)).length;
  const vs = studio.state.ventures;
  const funnel = {
    ideas: vs.length,
    parked: vs.filter((v) => v.state === 'parked').length,
    rejectedByScoring: vs.filter((v) => v.state === 'rejected' && v.rejectedBy === 'scoring').length,
    built: ever('review'),
    blocked: ever('blocked'),
    ready: ever('ready'),
    approved: ever('approved'),
    rejectedByOwner: vs.filter((v) => v.rejectedBy === 'owner').length,
    live: ever('live'),
    winners: ever('winner'),
    killed: ever('killed'),
    followUps: vs.filter((v) => v.parentId).length,
  };
  const paid = fakeStripe.paidSessions();
  const revenueCents = paid.reduce((s, x) => s + x.amount_total, 0);
  const measured = vs.filter((v) => v.funnel && v.publish?.publishedAt);
  const diagnoses: Partial<Record<Diagnosis, number>> = {};
  for (const v of measured) diagnoses[v.funnel!.diagnosis] = (diagnoses[v.funnel!.diagnosis] ?? 0) + 1;
  const diagLines = measured.map((v) => `  ${v.id} [${v.state}] ${v.title.slice(0, 48).padEnd(48)} world=${profileOf(v.slug).kind.padEnd(14)} → ${v.funnel!.diagnosis.padEnd(17)} ${funnelLine(v.funnel!)}`);
  const reangles = vs.filter((v) => v.followUpKind === 'reangle').length;
  const text = [
    `SIMULATION (offline, fake Claude, fake Stripe test mode, virtual clock) — ${days} days × ${perDay} cycles/day, seed ${seed}, auto-approve ${autoApprove ? 'ON (simulate only)' : 'OFF'}`,
    ...lines,
    '',
    'FUNNEL',
    `  ideas proposed      ${funnel.ideas}  (follow-ups of winners: ${funnel.followUps})`,
    `  → parked (human)    ${funnel.parked}`,
    `  → rejected (score)  ${funnel.rejectedByScoring}`,
    `  → built             ${funnel.built}`,
    `  → blocked           ${funnel.blocked}`,
    `  → ready (gate)      ${funnel.ready}`,
    `  → approved          ${funnel.approved}${autoApprove ? '' : '  (no --auto-approve: everything waits for the owner)'}`,
    `  → live              ${funnel.live}`,
    `  → winners           ${funnel.winners}`,
    `  → killed            ${funnel.killed}`,
    `  simulated sales ${paid.length} of ${fakeStripe.sessions.length} checkouts started, simulated revenue ${(revenueCents / 100).toFixed(2)} EUR, deploys ${deploys}, fake LLM cost $${summary.llm.totalUsd.toFixed(2)}`,
    '',
    'FUNNEL DIAGNOSES (simulated traffic via fake collector files; world = hidden behaviour profile)',
    `  ${Object.entries(diagnoses).map(([d, n]) => `${d} ${n}`).join(' · ') || '(no published ventures)'}  · re-angle follow-ups ${reangles}`,
    ...diagLines,
    '',
    summaryText(summary),
    '',
    `state written to ${stateDir}`,
  ].join('\n');
  return { text, stateDir, funnel, diagnoses };
}

function countStates(states: VentureState[]): Partial<Record<VentureState, number>> {
  const out: Partial<Record<VentureState, number>> = {};
  for (const s of states) out[s] = (out[s] ?? 0) + 1;
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'simulate.ts'));
if (isMain) {
  simulate(process.argv.slice(2))
    .then(({ text }) => console.log(text))
    .catch((error: unknown) => {
      console.error(`[simulate] ${(error as Error).message}`);
      process.exit(1);
    });
}
