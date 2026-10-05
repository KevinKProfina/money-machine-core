import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chooseTrafficSource, type TrafficSource } from './analytics.js';
import { addRequest, applyDecisions, readApprovals, type ApprovalsFile } from './approvals.js';
import { COMPONENT_NAME, type StudioConfig } from './config.js';
import { runDeployCmd, type Deployer } from './deploy.js';
import { renderLanding, renderMarkdown, renderProductPage, WITHDRAWAL_NOTICE_DE } from './html.js';
import type { FetchLike } from './http.js';
import { computeFunnel, diagnose, funnelLine, ventureTraffic, type DayAggregate, type TrafficSourceId } from './funnel.js';
import { createAnthropicClient, Llm, utcDay, type LlmClient } from './llm.js';
import { emitEvent, isKillSwitchActive, readStrategyBudget, writeJsonAtomic, type MMEvent } from './mm-contract.js';
import { checkMicroTool, combineScore, computeAutonomy, ideaHardFilter, scanContent } from './policy.js';
import { criticPrompt, followUpPrompt, ideasPrompt, landingPrompt, productPrompt, reanglePrompt, reviewPrompt, revisePrompt, SYSTEM, type HistoryItem } from './prompts.js';
import { SEEDS, seedByKey } from './seeds.js';
import { beaconSignature, publishedVentures, writeSite } from './site.js';
import { loadState, saveState, studioPaths, type StudioState } from './state.js';
import { emptyCheckouts, NoChannel, StripeChannel, type CheckoutCounts, type SalesChannel } from './stripe.js';
import { buildSummary, type StudioSummary, type TrafficSnapshot } from './summary.js';
import {
  BUILDABLE,
  CriticSchema,
  FollowUpsResponseSchema,
  IdeasResponseSchema,
  LandingCopySchema,
  ReviewSchema,
  type BlockKind,
  type Idea,
  type LandingCopy,
  type PolicyFinding,
  type PolicyReport,
  type Venture,
  type VentureState,
  PIPELINE_STATES,
} from './types.js';

export type EmitFn = (e: Omit<MMEvent, 'ts'>) => Promise<void>;
export type Control = { halted: boolean; reason?: string };

export type StudioDeps = {
  cfg: StudioConfig;
  now?: () => Date;
  /** undefined → real client when ANTHROPIC_API_KEY is set; null → disabled. */
  llm?: LlmClient | null;
  fetchImpl?: FetchLike;
  /** Override the sales channel (tests/simulator). */
  channel?: SalesChannel;
  deploy?: Deployer;
  emit?: EmitFn;
  log?: (m: string) => void;
  control?: () => Promise<Control>;
  /** Override the analytics source (tests); null → no analytics. Default: chooseTrafficSource(cfg). */
  traffic?: TrafficSource | null;
};

export async function readControl(): Promise<Control> {
  if (isKillSwitchActive()) return { halted: true, reason: 'kill switch active' };
  const budget = await readStrategyBudget(COMPONENT_NAME);
  if (budget?.paused) return { halted: true, reason: 'paused by orchestrator' };
  return { halted: false };
}

const MAX_ATTEMPTS = 3;
const DAY_MS = 86_400_000;
const PRODUCT_MAX_TOKENS = 16_000;

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50)
      .replace(/-+$/g, '') || 'produkt'
  );
}

function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/.exec(t);
  return (m ? m[1]! : t).trim() + '\n';
}

export function fallbackCopy(v: Venture): LandingCopy {
  const de = v.idea.language === 'de';
  return {
    headline: v.title,
    subheadline: v.idea.problem,
    benefits: v.idea.deliverableOutline.slice(0, 6),
    outline: v.idea.deliverableOutline,
    faq: [
      de
        ? { q: 'Wie erhalte ich das Produkt?', a: 'Direkt nach dem Kauf wirst du zur Download-Seite weitergeleitet.' }
        : { q: 'How do I get the product?', a: 'After checkout you are redirected to the download page.' },
      de ? { q: 'Für wen ist das?', a: v.idea.audience } : { q: 'Who is it for?', a: v.idea.audience },
    ],
    metaDescription: `${v.title}: ${v.idea.whyPay}`.slice(0, 155),
  };
}

export class Studio {
  readonly llm: Llm;
  readonly channel: SalesChannel;
  private readonly now: () => Date;
  private readonly emit: EmitFn;
  private readonly log: (m: string) => void;
  private readonly deploy: Deployer;
  private readonly controlFn: () => Promise<Control>;
  private cycleNotes: string[] = [];
  private lastControl: Control = { halted: false };
  private readonly trafficSource?: TrafficSource;
  /** Analytics daily aggregates loaded once per cycle. */
  traffic: TrafficSnapshot = { source: 'none' };

  private constructor(
    readonly cfg: StudioConfig,
    readonly state: StudioState,
    deps: StudioDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.emit = deps.emit ?? emitEvent;
    this.log = deps.log ?? ((m) => console.log(m));
    this.controlFn = deps.control ?? readControl;
    let client: LlmClient | undefined;
    if (deps.llm === null) client = undefined;
    else if (deps.llm) client = deps.llm;
    else if (cfg.llm.apiKey) client = createAnthropicClient(cfg.llm.apiKey);
    this.llm = new Llm(client, cfg.llm, state.llm, this.now);
    this.trafficSource = deps.traffic === null ? undefined : (deps.traffic ?? chooseTrafficSource(cfg, { fetchImpl: deps.fetchImpl, now: this.now }));
    this.channel = deps.channel ?? (cfg.stripe.apiKey ? new StripeChannel(cfg.stripe.apiKey, { fetchImpl: deps.fetchImpl }) : new NoChannel());
    this.deploy =
      deps.deploy ??
      (async (siteDir) =>
        cfg.deployCmd
          ? runDeployCmd(cfg.deployCmd, siteDir, cfg.deployTimeoutMs, studioPaths.deployLog(), this.now)
          : { ok: false, at: this.now().toISOString(), code: null, timedOut: false, durationMs: 0, outputTail: '', skipped: 'STUDIO_DEPLOY_CMD not set: site written locally only' });
  }

  static async open(deps: StudioDeps): Promise<Studio> {
    const now = deps.now ?? (() => new Date());
    const state = await loadState(now());
    return new Studio(deps.cfg, state, deps);
  }

  // ------------------------------------------------------------ helpers

  private iso(): string {
    return this.now().toISOString();
  }

  private transition(v: Venture, to: VentureState, note?: string): void {
    const from = v.state;
    v.state = to;
    v.updatedAt = this.iso();
    v.history.push({ ts: v.updatedAt, from, to, ...(note ? { note } : {}) });
    if (v.history.length > 50) v.history.splice(0, v.history.length - 50);
    this.log(`[studio] ${v.id} ${v.slug}: ${from} → ${to}${note ? ` (${note})` : ''}`);
  }

  private async event(level: MMEvent['level'], type: string, message: string, data?: unknown): Promise<void> {
    await this.emit({ source: COMPONENT_NAME, level, type, message, ...(data !== undefined ? { data } : {}) });
  }

  private async block(v: Venture, kind: BlockKind, reasons: string[]): Promise<void> {
    v.blocked = { kind, reasons };
    this.transition(v, 'blocked', `${kind}: ${reasons.join('; ').slice(0, 300)}`);
    await this.event('warn', 'studio.blocked', `${v.title}: blocked (${kind})`, { ventureId: v.id, kind, reasons });
  }

  private history(limit = 30): HistoryItem[] {
    const interesting = this.state.ventures.filter((v) => ['winner', 'killed', 'blocked', 'rejected', 'live', 'parked'].includes(v.state));
    return interesting.slice(-limit).map((v) => ({
      title: v.title,
      category: v.idea.category,
      state: v.state === 'rejected' && v.rejectedBy === 'owner' ? 'rejected-by-owner' : v.state,
      reason: v.killedReason ?? v.rejectedReason ?? v.blocked?.reasons.join('; ') ?? (v.state === 'parked' ? `needs human: ${v.humanSteps.join(', ')}` : undefined),
      price: v.idea.price,
      ...(v.sales ? { sales: v.sales.count } : {}),
      ...(v.funnel && v.funnel.diagnosis !== 'unknown' ? { diagnosis: v.funnel.diagnosis } : {}),
      ...(v.funnel ? { funnel: funnelLine(v.funnel) } : {}),
    }));
  }

  private uniqueSlug(base: string): string {
    const used = new Set(this.state.ventures.map((v) => v.slug));
    let slug = slugify(base);
    for (let i = 2; used.has(slug); i++) slug = `${slugify(base).slice(0, 46)}-${i}`;
    return slug;
  }

  /** Create a venture from an idea. Non-buildable categories are parked immediately. */
  addIdea(idea: Idea, source: 'claude' | 'seed', extra: Partial<Venture> = {}): Venture {
    const id = `v${String(this.state.nextId++).padStart(4, '0')}`;
    const price = Math.round(Math.min(500, Math.max(1, Number.isFinite(idea.price) ? idea.price : 1)) * 100) / 100;
    const normalized: Idea = { ...idea, price, slug: this.uniqueSlug(idea.slug || idea.title) };
    const { score, humanSteps } = computeAutonomy(normalized);
    normalized.autonomy = { ...normalized.autonomy, autonomyScore: score };
    const at = this.iso();
    const v: Venture = {
      id,
      slug: normalized.slug,
      title: normalized.title.trim().slice(0, 120),
      source,
      idea: normalized,
      autonomyScore: score,
      humanSteps,
      generation: 0,
      state: 'idea',
      createdAt: at,
      updatedAt: at,
      history: [{ ts: at, from: null, to: 'idea' }],
      ...extra,
    };
    this.state.ventures.push(v);
    if (!BUILDABLE.has(normalized.category)) this.transition(v, 'parked', `category ${normalized.category} needs a human: ${humanSteps.join(', ') || 'not producible by the studio'}`);
    return v;
  }

  // ------------------------------------------------------------ cycle

  async cycle(): Promise<{ notes: string[] }> {
    this.cycleNotes = [];
    this.state.cycle++;
    const control = await this.controlFn();
    this.lastControl = control;
    if (control.halted) this.cycleNotes.push(`${control.reason}: no ideation, build or publish; measuring and killing continue`);

    // 1. consume owner decisions (decisions.jsonl → approvals.json)
    const applied = await applyDecisions();
    const approvals = await readApprovals();

    // 1b. analytics: rebuild the site when the beacon config changed; load traffic once per cycle
    if ((this.state.site.beacon?.signature ?? '') !== beaconSignature(this.cfg) && publishedVentures(this.state.ventures).length > 0) this.state.site.dirty = true;
    await this.loadTraffic();

    // 2. advance each venture by at most one stage
    for (const v of [...this.state.ventures]) {
      try {
        await this.advance(v, control, approvals);
      } catch (error) {
        v.lastError = (error as Error).message;
        this.log(`[studio] ${v.id} error: ${v.lastError}`);
      }
    }
    if (applied.length) this.cycleNotes.push(`${applied.length} owner decision(s) applied`);

    // 3. ideation
    if (!control.halted) await this.ideate();

    // 4. site + deploy (also under kill switch: kills must be redeployed)
    if (this.state.site.dirty) await this.publishSite();

    this.state.updatedAt = this.iso();
    return { notes: this.cycleNotes };
  }

  async persist(): Promise<StudioSummary> {
    await saveState(this.state);
    const summary = buildSummary(this.state, this.cfg, this.channel, this.now(), await readApprovals(), this.lastControl, this.cycleNotes, this.llm.enabled, this.traffic);
    await writeJsonAtomic(studioPaths.summary(), summary);
    return summary;
  }

  private async advance(v: Venture, control: Control, approvals: ApprovalsFile): Promise<void> {
    switch (v.state) {
      case 'idea':
        if (!control.halted) await this.score(v);
        return;
      case 'queued':
        if (!control.halted) await this.build(v);
        return;
      case 'review':
        if (!control.halted) await this.review(v);
        return;
      case 'ready':
        await this.checkApproval(v, approvals);
        return;
      case 'approved':
        if (!control.halted) await this.publish(v);
        return;
      case 'blocked':
        if ((v.blocked?.kind === 'operator' && this.cfg.operator) || (v.blocked?.kind === 'site-url' && this.cfg.siteUrl)) {
          if (v.approval?.decision === 'approved') {
            delete v.blocked;
            this.transition(v, 'approved', 'missing configuration now present');
          }
        }
        return;
      case 'live':
      case 'winner':
        await this.measure(v, control);
        return;
      case 'killed':
        await this.ensureDeactivated(v);
        if (v.reanglePending && !control.halted) await this.spawnReangle(v);
        return;
      default:
        return;
    }
  }

  // ------------------------------------------------------------ 1. ideation

  private async ideate(): Promise<void> {
    const day = utcDay(this.now());
    const ide = this.state.ideation;
    if (ide.day !== day) {
      ide.day = day;
      ide.count = 0;
    }
    const active = this.state.ventures.filter((v) => PIPELINE_STATES.has(v.state)).length;
    if (active >= this.cfg.maxActive) return;
    const n = Math.min(this.cfg.ideasPerDay - ide.count, this.cfg.maxActive - active);
    if (n <= 0) return;

    const created: Venture[] = [];
    if (this.llm.enabled) {
      const r = await this.llm.callJson(
        { task: 'ideas', system: SYSTEM, prompt: ideasPrompt(n, this.history(), this.state.ventures.map((v) => v.slug)), maxTokens: 8000, effort: 'medium' },
        IdeasResponseSchema,
      );
      if (r.status !== 'ok') {
        ide.lastNote = `ideation skipped: ${r.note}`;
        this.cycleNotes.push(ide.lastNote);
        if (r.status !== 'budget') ide.count++; // a failed/refused call still uses an ideation slot
        return;
      }
      for (const idea of r.data.ideas.slice(0, n)) created.push(this.addIdea(idea, 'claude'));
      ide.count += Math.max(1, created.length);
    } else {
      for (let i = 0; i < n && ide.seedCursor < SEEDS.length; i++) {
        const seed = SEEDS[ide.seedCursor++]!;
        created.push(this.addIdea(structuredClone(seed.idea), 'seed', { seedKey: seed.key }));
        ide.count++;
      }
      if (created.length === 0) {
        ide.lastNote = 'offline seed catalog exhausted (set ANTHROPIC_API_KEY for new ideas)';
        this.cycleNotes.push(ide.lastNote);
        return;
      }
    }
    ide.lastNote = `${created.length} idea(s) proposed`;
    await this.event('info', 'studio.ideas', `${created.length} new idea(s): ${created.map((v) => v.title).join(' | ')}`, {
      ideas: created.map((v) => ({ id: v.id, title: v.title, category: v.idea.category, autonomyScore: v.autonomyScore, state: v.state, source: v.source })),
    });
  }

  // ------------------------------------------------------------ 2. scoring

  private async score(v: Venture): Promise<void> {
    const filter = ideaHardFilter(v.idea);
    if (filter.length > 0) {
      v.rejectedBy = 'scoring';
      v.rejectedReason = `hard filter: ${filter.join('; ')}`;
      this.transition(v, 'rejected', v.rejectedReason);
      return;
    }
    let critic: { score: number; reasons: string[] };
    let criticSource: 'claude' | 'seed';
    const seed = seedByKey(v.seedKey);
    if (v.source === 'seed' && seed) {
      critic = seed.critic;
      criticSource = 'seed';
    } else if (this.llm.enabled) {
      const r = await this.llm.callJson({ task: 'critic', system: SYSTEM, prompt: criticPrompt(v.idea), maxTokens: 2000, effort: 'medium' }, CriticSchema);
      if (r.status === 'budget') return; // retry next cycle
      if (r.status === 'refused') {
        v.rejectedBy = 'scoring';
        v.rejectedReason = 'critic refused to score this idea';
        this.transition(v, 'rejected', v.rejectedReason);
        return;
      }
      if (r.status !== 'ok') {
        v.scoreAttempts = (v.scoreAttempts ?? 0) + 1;
        v.lastError = r.note;
        if (v.scoreAttempts >= MAX_ATTEMPTS) {
          v.rejectedBy = 'scoring';
          v.rejectedReason = `critic failed ${MAX_ATTEMPTS}×: ${r.note}`;
          this.transition(v, 'rejected', v.rejectedReason);
        }
        return;
      }
      critic = { score: r.data.score, reasons: [...r.data.reasons, `demand: ${r.data.demandSignals}`, `competition: ${r.data.competition}`, `legal: ${r.data.legalRisk}`] };
      criticSource = 'claude';
    } else {
      return; // a Claude idea without Claude: wait
    }
    const final = combineScore(critic.score, v.autonomyScore, this.cfg.autonomyWeight);
    v.score = { critic: critic.score, autonomy: v.autonomyScore, final, reasons: critic.reasons.map((r) => r.slice(0, 300)), criticSource };
    if (final >= this.cfg.minScore && critic.score >= this.cfg.minCritic) this.transition(v, 'queued', `score ${final} (critic ${critic.score}, autonomy ${v.autonomyScore})`);
    else {
      v.rejectedBy = 'scoring';
      v.rejectedReason = `score ${final} (min ${this.cfg.minScore}; critic floor ${this.cfg.minCritic}) (critic ${critic.score}, autonomy ${v.autonomyScore}): ${critic.reasons.slice(0, 3).join('; ')}`;
      this.transition(v, 'rejected', v.rejectedReason);
    }
  }

  // ------------------------------------------------------------ 3. build

  private async generateProduct(v: Venture): Promise<{ ok: true; content: string } | { ok: false; wait?: boolean; fatal?: boolean; note: string }> {
    const seed = seedByKey(v.seedKey);
    if (v.source === 'seed' && seed?.product) return { ok: true, content: seed.product() };
    if (!this.llm.enabled) return { ok: false, wait: true, note: 'no LLM available' };
    const r = await this.llm.call({ task: 'product', system: SYSTEM, prompt: productPrompt(v, this.cfg.minProductChars), maxTokens: PRODUCT_MAX_TOKENS, effort: 'medium' });
    if (r.status === 'budget') return { ok: false, wait: true, note: r.note };
    if (r.status === 'refused') return { ok: false, fatal: true, note: 'model refused to build this product' };
    if (r.status !== 'ok') return { ok: false, note: r.note };
    return { ok: true, content: stripFences(r.text) };
  }

  private async generateCopy(v: Venture, product: string, issues?: PolicyFinding[]): Promise<LandingCopy> {
    const seed = seedByKey(v.seedKey);
    if (v.source === 'seed' && seed?.copy && !issues) return seed.copy;
    if (this.llm.enabled) {
      const extra = issues?.length ? `\n\nThe previous copy violated: ${issues.map((i) => `${i.rule} ("${i.excerpt}")`).join('; ')}. Avoid this.` : '';
      const r = await this.llm.callJson({ task: 'landing', system: SYSTEM, prompt: landingPrompt(v, product) + extra, maxTokens: 4000, effort: 'medium' }, LandingCopySchema);
      if (r.status === 'ok') return r.data;
    }
    return fallbackCopy(v);
  }

  private async writeArtifacts(v: Venture, product: string, copy: LandingCopy): Promise<void> {
    const dir = studioPaths.ventureDir(v.id);
    await fsp.mkdir(dir, { recursive: true });
    if (v.idea.category === 'micro-tool') {
      await fsp.writeFile(path.join(dir, 'product.html'), product);
      await fsp.rm(path.join(dir, 'product.md'), { force: true });
    } else {
      await fsp.writeFile(path.join(dir, 'product.md'), product);
      await fsp.writeFile(path.join(dir, 'product.html'), renderProductPage(v, renderMarkdown(product), this.cfg.operator));
    }
    await fsp.writeFile(path.join(dir, 'copy.json'), JSON.stringify(copy, null, 2));
    await fsp.writeFile(path.join(dir, 'landing.html'), renderLanding(v, copy, { mode: 'preview', siteUrl: this.cfg.siteUrl, operator: this.cfg.operator, currency: this.cfg.currency, priceNote: this.cfg.priceNote }));
    v.build = { ...(v.build ?? { attempts: 0, revisions: 0 }), dir, copy, productChars: product.length };
  }

  private async readProduct(v: Venture): Promise<string> {
    const dir = v.build!.dir;
    const file = v.idea.category === 'micro-tool' ? 'product.html' : 'product.md';
    return fsp.readFile(path.join(dir, file), 'utf8');
  }

  private async build(v: Venture): Promise<void> {
    v.build ??= { dir: studioPaths.ventureDir(v.id), attempts: 0, revisions: 0 };
    const res = await this.generateProduct(v);
    if (!res.ok) {
      if (res.wait) return;
      v.lastError = res.note;
      v.build.attempts++;
      if (res.fatal || v.build.attempts >= MAX_ATTEMPTS) await this.block(v, 'build', [res.note]);
      return;
    }
    const min = v.idea.category === 'micro-tool' ? this.cfg.minToolChars : this.cfg.minProductChars;
    if (res.content.length < min) {
      v.build.attempts++;
      v.lastError = `product too short (${res.content.length} < ${min} chars)`;
      if (v.build.attempts >= MAX_ATTEMPTS) await this.block(v, 'build', [v.lastError]);
      return;
    }
    const copy = await this.generateCopy(v, res.content);
    await this.writeArtifacts(v, res.content, copy);
    delete v.lastError;
    this.transition(v, 'review', `built ${res.content.length} chars`);
  }

  // ------------------------------------------------------------ policy review

  regexFindings(v: Venture, product: string, copy: LandingCopy, landingHtml: string): PolicyFinding[] {
    const copyText = [copy.headline, copy.subheadline, ...copy.benefits, ...copy.outline, ...copy.faq.flatMap((f) => [f.q, f.a]), copy.metaDescription].join('\n');
    const findings = [...scanContent(product, 'product'), ...scanContent(copyText, 'landing'), ...scanContent(v.title, 'title')];
    if (v.idea.category === 'micro-tool') for (const issue of checkMicroTool(product)) findings.push({ rule: 'micro-tool', source: 'regex', where: 'product', excerpt: issue });
    if (!/AI-assisted/.test(landingHtml)) findings.push({ rule: 'ai-disclosure', source: 'regex', where: 'landing', excerpt: 'AI-assisted notice missing' });
    if (!landingHtml.includes(WITHDRAWAL_NOTICE_DE.slice(0, 40))) findings.push({ rule: 'withdrawal-notice', source: 'regex', where: 'landing', excerpt: 'withdrawal notice missing' });
    return findings;
  }

  private async review(v: Venture): Promise<void> {
    if (!v.build?.copy) {
      this.transition(v, 'queued', 'build artifacts missing; rebuilding');
      return;
    }
    const product = await this.readProduct(v);
    const landingHtml = await fsp.readFile(path.join(v.build.dir, 'landing.html'), 'utf8');
    const findings = this.regexFindings(v, product, v.build.copy, landingHtml);
    const notes: string[] = [];
    let claudeReviewed = false;
    if (this.llm.enabled) {
      const r = await this.llm.callJson({ task: 'review', system: SYSTEM, prompt: reviewPrompt(v, product, v.build.copy), maxTokens: 3000, effort: 'low' }, ReviewSchema);
      if (r.status === 'budget') return; // wait for budget; never skip the review
      if (r.status === 'ok') {
        claudeReviewed = true;
        if (!r.data.pass && r.data.issues.length === 0) findings.push({ rule: 'review-failed', source: 'claude', where: 'product', excerpt: 'reviewer rejected without details' });
        for (const i of r.data.issues) findings.push({ rule: i.rule, source: 'claude', where: 'product', excerpt: i.excerpt.slice(0, 300) });
      } else if (r.status === 'refused') {
        findings.push({ rule: 'review-refused', source: 'claude', where: 'product', excerpt: 'policy reviewer refused' });
      } else {
        v.build.attempts++;
        v.lastError = r.note;
        if (v.build.attempts >= MAX_ATTEMPTS + 1) await this.block(v, 'policy', [`policy review failed: ${r.note}`]);
        return;
      }
    } else notes.push('regex-only review: no ANTHROPIC_API_KEY (Claude policy review skipped)');
    if (v.source === 'seed') notes.push('seed catalog content (offline)');

    const report: PolicyReport = { pass: findings.length === 0, checkedAt: this.iso(), claudeReviewed, findings, notes };
    v.policy = report;
    if (report.pass) {
      this.transition(v, 'ready', 'policy review passed');
      await this.requestApproval(v);
      return;
    }
    if (v.build.revisions < 1 && this.llm.enabled) {
      // ONE revision, then re-review next cycle
      const productIssues = findings.filter((f) => f.where !== 'landing');
      const landingIssues = findings.filter((f) => f.where === 'landing');
      let revised = product;
      if (productIssues.length > 0) {
        const r = await this.llm.call({ task: 'revise', system: SYSTEM, prompt: revisePrompt(v, product, productIssues), maxTokens: PRODUCT_MAX_TOKENS, effort: 'medium' });
        if (r.status === 'budget') return;
        if (r.status !== 'ok') {
          await this.block(v, 'policy', [...findings.map((f) => `${f.rule}: ${f.excerpt}`), `revision failed: ${r.note}`]);
          return;
        }
        revised = stripFences(r.text);
      }
      const copy = landingIssues.length > 0 ? await this.generateCopy(v, revised, landingIssues) : v.build.copy;
      await this.writeArtifacts(v, revised, copy);
      v.build.revisions++;
      v.history.push({ ts: this.iso(), from: 'review', to: 'review', note: `revised after ${findings.length} finding(s)` });
      return;
    }
    await this.block(v, 'policy', findings.map((f) => `${f.rule} (${f.source}, ${f.where}): ${f.excerpt}`));
  }

  private async requestApproval(v: Venture): Promise<void> {
    const requestedAt = this.iso();
    v.approval = { requestedAt };
    await addRequest({
      ventureId: v.id,
      title: v.title,
      slug: v.slug,
      price: v.idea.price,
      currency: this.cfg.currency,
      previewPath: v.build!.dir,
      policyReport: v.policy!,
      requestedAt,
    });
    await this.event('info', 'studio.ready_for_approval', `${v.title} is ready and waits for owner approval`, { ventureId: v.id, price: v.idea.price, previewPath: v.build!.dir });
  }

  // ------------------------------------------------------------ 4. the gate

  private async checkApproval(v: Venture, approvals: ApprovalsFile): Promise<void> {
    const reqs = approvals.requests.filter((r) => r.ventureId === v.id);
    const req = reqs[reqs.length - 1];
    if (!req) {
      await this.requestApproval(v); // recover a lost request
      return;
    }
    if (!req.decision) return; // still pending: nothing public happens
    v.approval = { requestedAt: req.requestedAt, decision: req.decision, decidedAt: req.decidedAt, decidedBy: req.decidedBy, note: req.note };
    if (req.decision === 'approved') {
      this.transition(v, 'approved', `approved by ${req.decidedBy ?? 'owner'}`);
      await this.event('info', 'studio.approved', `${v.title} approved by ${req.decidedBy ?? 'owner'}`, { ventureId: v.id });
    } else {
      v.rejectedBy = 'owner';
      v.rejectedReason = `rejected by owner${req.note ? `: ${req.note}` : ''}`;
      this.transition(v, 'rejected', v.rejectedReason);
      await this.event('info', 'studio.rejected', `${v.title} rejected by ${req.decidedBy ?? 'owner'}`, { ventureId: v.id, note: req.note });
    }
  }

  // ------------------------------------------------------------ 5. publish

  private async publish(v: Venture): Promise<void> {
    // Hard invariant: only an owner-approved venture can be published.
    if (v.approval?.decision !== 'approved') {
      this.transition(v, 'ready', 'publish attempted without approval; back to the queue');
      return;
    }
    if (!this.cfg.operator) {
      await this.block(v, 'operator', [`operator details missing (${this.cfg.operatorMissing.join(', ')}) — required for the Impressum`]);
      return;
    }
    if (!this.cfg.siteUrl) {
      await this.block(v, 'site-url', ['STUDIO_SITE_URL missing']);
      return;
    }
    const token = v.publish?.token ?? crypto.randomBytes(16).toString('hex');
    const url = `${this.cfg.siteUrl}/${v.slug}/`;
    const downloadUrl = `${this.cfg.siteUrl}/${v.slug}/${token}/`;
    v.publish = { ...(v.publish ?? { attempts: 0 }), token, url, downloadUrl, channel: this.channel.id };

    if (this.channel.id === 'stripe') {
      const ok = await this.attachListing(v);
      if (!ok) return;
    }
    v.publish.publishedAt = this.iso();
    this.state.site.dirty = true;
    this.transition(v, 'live', this.channel.id === 'stripe' ? `published with payment link${this.channel.simulated ? ' (Stripe test mode)' : ''}` : 'published as "coming soon" (no sales channel)');
    await this.event('info', 'studio.publish', `${v.title} published at ${url}`, { ventureId: v.id, url, channel: this.channel.id, simulated: this.channel.simulated });
  }

  /** Create Stripe product/price/payment link. Only ever called for approved ventures. */
  private async attachListing(v: Venture): Promise<boolean> {
    const pub = v.publish!;
    pub.stripe ??= { testMode: this.channel.simulated };
    try {
      const listing = await this.channel.createListing({
        ventureId: v.id,
        name: v.title,
        description: v.build?.copy?.metaDescription ?? v.idea.problem,
        unitAmountCents: Math.round(v.idea.price * 100),
        currency: this.cfg.currency,
        downloadUrl: pub.downloadUrl,
        submitMessage: WITHDRAWAL_NOTICE_DE,
        existing: { productId: pub.stripe.productId, priceId: pub.stripe.priceId },
        onProgress: (p) => Object.assign(pub.stripe!, p),
      });
      Object.assign(pub.stripe, listing, { deactivated: false });
      pub.salesSince = this.iso();
      delete v.lastError;
      return true;
    } catch (error) {
      pub.attempts++;
      v.lastError = `stripe: ${(error as Error).message}`;
      if (pub.attempts >= MAX_ATTEMPTS) await this.block(v, 'publish', [v.lastError]);
      return false;
    }
  }

  private async publishSite(): Promise<void> {
    if (!this.cfg.operator || !this.cfg.siteUrl) {
      this.cycleNotes.push('site not written: operator details or STUDIO_SITE_URL missing');
      return;
    }
    await writeSite(this.state.ventures, this.cfg, studioPaths.site(), this.now(), this.channel.id);
    this.state.site.lastWrittenAt = this.iso();
    const sig = beaconSignature(this.cfg);
    if ((this.state.site.beacon?.signature ?? '') !== sig || !this.state.site.beacon) this.state.site.beacon = { signature: sig, ...(sig ? { since: utcDay(this.now()) } : {}) };
    const result = await this.deploy(studioPaths.site());
    this.state.site.lastDeploy = result;
    if (result.skipped) {
      this.state.site.dirty = false;
      this.cycleNotes.push(result.skipped);
    } else if (result.ok) {
      this.state.site.dirty = false;
      await this.event('info', 'studio.deploy', `site deployed (${result.durationMs} ms)`);
    } else {
      // stays dirty → retried next cycle
      await this.event('error', 'studio.deploy_failed', `deploy failed${result.timedOut ? ' (timeout)' : ` (code ${result.code})`}`, { outputTail: result.outputTail.slice(-500) });
    }
  }

  // ------------------------------------------------------------ 6. measure & evolve

  private async measure(v: Venture, control: Control): Promise<void> {
    const pub = v.publish;
    if (!pub) return;
    // A venture published without a channel gets its link once Stripe becomes available.
    if (this.channel.id === 'stripe' && !pub.stripe?.paymentLinkId && !control.halted) {
      if (await this.attachListing(v)) {
        this.state.site.dirty = true;
        await this.event('info', 'studio.publish', `${v.title}: payment link attached`, { ventureId: v.id });
      }
      return;
    }
    let checkouts: CheckoutCounts = emptyCheckouts();
    if (pub.stripe?.paymentLinkId) {
      try {
        // one paginated list of ALL sessions: started vs completed, and the paid ones are the sales
        checkouts = await this.channel.countCheckouts(pub.stripe.paymentLinkId);
        v.sales = { count: checkouts.paid, revenueCents: checkouts.revenueCents, currency: this.cfg.currency, simulated: this.channel.simulated, lastCheckedAt: this.iso() };
      } catch (error) {
        v.sales = { ...(v.sales ?? { count: 0, revenueCents: 0, currency: this.cfg.currency, simulated: this.channel.simulated }), lastCheckedAt: this.iso(), error: (error as Error).message };
        return; // never decide on missing data
      }
    }
    await this.updateFunnel(v, checkouts);
    if (!pub.salesSince) return; // not purchasable yet → no evaluation
    const daysLive = (this.now().getTime() - Date.parse(pub.salesSince)) / DAY_MS;
    const sales = v.sales?.count ?? 0;
    if (daysLive >= this.cfg.evalDays) {
      if (sales === 0) {
        // analytics configured but unreachable: wait up to 2 days for data before deciding
        if (this.traffic.error && daysLive < this.cfg.evalDays + 2) return;
        const diag = v.funnel?.diagnosis;
        // people try to buy but do not finish: keep it live longer (flagged in the summary)
        if (diag === 'checkout-friction' && daysLive < this.cfg.evalDays * this.cfg.analytics.frictionGraceFactor) return;
        await this.kill(v, this.killReason(v, daysLive));
        if (diag === 'no-interest' && v.followUpKind !== 'reangle') {
          v.reanglePending = true;
          if (!control.halted) await this.spawnReangle(v);
        }
        return;
      }
      if (v.state === 'live' && sales >= this.cfg.winnerSales && this.channel.id === 'stripe') {
        this.transition(v, 'winner', `${sales} sales in ${daysLive.toFixed(0)} days`);
        await this.event('info', 'studio.winner', `${v.title} is a winner (${sales} sales${this.channel.simulated ? ', simulated' : ''})`, { ventureId: v.id, sales, simulated: this.channel.simulated });
      }
    }
    if (v.state === 'winner' && !v.followUpsSpawned && !control.halted) await this.spawnFollowUps(v);
  }

  /** Loads the collector's daily aggregates for the window the live ventures need. */
  private async loadTraffic(): Promise<void> {
    const src = this.trafficSource;
    const site = this.cfg.analytics.site;
    if (!src || !site) {
      this.traffic = { source: 'none' };
      return;
    }
    const nowMs = this.now().getTime();
    const today = utcDay(this.now());
    const starts = this.state.ventures
      .filter((v) => (v.state === 'live' || v.state === 'winner') && v.publish?.publishedAt)
      .map((v) => utcDay(new Date(Date.parse(v.publish!.salesSince ?? v.publish!.publishedAt!))));
    let from = [utcDay(new Date(nowMs - 29 * DAY_MS)), ...starts].sort()[0]!;
    const oldest = utcDay(new Date(nowMs - (this.cfg.analytics.retentionDays - 1) * DAY_MS));
    if (from < oldest) from = oldest;
    try {
      const days: DayAggregate[] = await src.load(site, from, today);
      this.traffic = { source: src.id, site, fromDay: from, days };
    } catch (error) {
      const message = (error as Error).message;
      this.traffic = { source: src.id, site, fromDay: from, error: message };
      this.cycleNotes.push(`analytics unavailable (${src.id}): ${message}`);
    }
  }

  /** Funnel + diagnosis for one live venture (pure math in funnel.ts). */
  private async updateFunnel(v: Venture, checkouts: CheckoutCounts): Promise<void> {
    const pub = v.publish!;
    let since = utcDay(new Date(Date.parse(pub.salesSince ?? pub.publishedAt ?? v.updatedAt)));
    const beaconSince = this.state.site.beacon?.signature ? this.state.site.beacon.since : undefined;
    if (beaconSince && beaconSince > since) since = beaconSince; // only count days the beacon was on the page
    const days = this.traffic.days;
    const source: TrafficSourceId = days ? this.traffic.source : 'none';
    const f = computeFunnel(days ? ventureTraffic(days, v.slug, since) : undefined, checkouts, source, since);
    const d = diagnose(f, this.cfg.analytics.thresholds);
    v.funnel = { ...f, diagnosis: d.diagnosis, diagnosisReason: d.reason, measuredAt: this.iso() };
    if (d.diagnosis === 'checkout-friction' && !v.frictionFlaggedAt) {
      v.frictionFlaggedAt = this.iso();
      await this.event('warn', 'studio.funnel_alert', `${v.title}: checkout friction — ${d.reason}`, { ventureId: v.id, diagnosis: d.diagnosis, funnel: f });
    }
  }

  private killReason(v: Venture, daysLive: number): string {
    const f = v.funnel;
    const t = this.cfg.analytics.thresholds;
    const base = `no sales in ${f?.diagnosis === 'checkout-friction' ? Math.floor(daysLive) : this.cfg.evalDays} days`;
    switch (f?.diagnosis) {
      case 'no-traffic':
        return `${base} — traffic problem, not necessarily a product problem (${f.visits} landing visits < ${t.minVisits})`;
      case 'no-interest':
        return `${base} — no interest: ${f.diagnosisReason}${v.followUpKind !== 'reangle' ? '; re-angle follow-up proposed' : ''}`;
      case 'checkout-friction':
        return `${base} — checkout friction: ${f.diagnosisReason}`;
      default:
        return base;
    }
  }

  /** No-interest kill → one follow-up idea with a different angle/price. It goes through scoring, build, review and the owner gate. */
  private async spawnReangle(v: Venture): Promise<void> {
    const extra: Partial<Venture> = { parentId: v.id, generation: v.generation + 1, followUpKind: 'reangle' };
    let created: Venture | undefined;
    if (v.source === 'claude' && this.llm.enabled) {
      const r = await this.llm.callJson(
        { task: 'reangle', system: SYSTEM, prompt: reanglePrompt(v, v.funnel ? funnelLine(v.funnel) : 'no funnel data', this.history()), maxTokens: 6000, effort: 'medium' },
        IdeasResponseSchema,
      );
      if (r.status === 'budget') return; // stays pending
      const idea = r.status === 'ok' ? r.data.ideas[0] : undefined;
      if (idea) created = this.addIdea(idea, 'claude', extra);
    } else {
      // offline: same seed content, lower price (a price test is the only angle the seed catalog can change)
      const idea = structuredClone(v.idea);
      idea.price = Math.max(3, Math.round(idea.price * 0.7));
      idea.slug = `${v.slug}-r`;
      idea.title = `${v.title} (${v.idea.language === 'de' ? 'neuer Ansatz' : 'new angle'})`;
      created = this.addIdea(idea, v.source, { ...extra, ...(v.seedKey ? { seedKey: v.seedKey } : {}) });
    }
    delete v.reanglePending;
    if (created) await this.event('info', 'studio.ideas', `re-angle follow-up for ${v.title} (no-interest): ${created.title}`, { parentId: v.id, ideas: [{ id: created.id, title: created.title, kind: 'reangle' }] });
  }

  async kill(v: Venture, reason: string): Promise<void> {
    v.killedReason = reason;
    this.transition(v, 'killed', reason);
    await this.ensureDeactivated(v);
    this.state.site.dirty = true;
    await this.event('info', 'studio.kill', `${v.title} discontinued: ${reason}`, { ventureId: v.id, reason });
  }

  private async ensureDeactivated(v: Venture): Promise<void> {
    const s = v.publish?.stripe;
    if (!s?.paymentLinkId || s.deactivated) return;
    try {
      await this.channel.deactivate(s.paymentLinkId);
      s.deactivated = true;
    } catch (error) {
      v.lastError = `deactivate payment link failed (will retry): ${(error as Error).message}`;
    }
  }

  private async spawnFollowUps(parent: Venture): Promise<void> {
    const extra = (kind: Venture['followUpKind']): Partial<Venture> => ({ parentId: parent.id, generation: parent.generation + 1, followUpKind: kind });
    const created: Venture[] = [];
    if (parent.source === 'claude' && this.llm.enabled) {
      const r = await this.llm.callJson(
        { task: 'followups', system: SYSTEM, prompt: followUpPrompt(parent, this.history(), this.cfg.maxFollowUps), maxTokens: 6000, effort: 'medium' },
        FollowUpsResponseSchema,
      );
      if (r.status === 'budget') return;
      if (r.status === 'ok') {
        for (const { kind, ...idea } of r.data.ideas.slice(0, this.cfg.maxFollowUps)) created.push(this.addIdea(idea, 'claude', extra(kind)));
      }
    } else {
      // offline: one price-test variant of the same seed product
      const idea = structuredClone(parent.idea);
      idea.price = Math.round(idea.price * 1.3 * 100) / 100;
      idea.slug = `${parent.slug}-v${parent.generation + 2}`;
      idea.title = `${parent.title} (v${parent.generation + 2})`;
      created.push(this.addIdea(idea, parent.source, { ...extra('price-test'), ...(parent.seedKey ? { seedKey: parent.seedKey } : {}) }));
    }
    parent.followUpsSpawned = true;
    if (created.length) await this.event('info', 'studio.ideas', `${created.length} follow-up idea(s) for winner ${parent.title}`, { parentId: parent.id, ideas: created.map((c) => ({ id: c.id, title: c.title, kind: c.followUpKind })) });
  }
}
