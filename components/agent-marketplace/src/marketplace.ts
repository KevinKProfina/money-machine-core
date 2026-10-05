import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AskClaude } from './claude.ts';
import type { Config } from './config.ts';
import { BUILTINS, HandlerInputError } from './handlers/builtin.ts';
import {
  agentAccount,
  balanceOf,
  checkInvariants,
  deposit as ledgerDeposit,
  holdEscrow,
  LedgerError,
  PLATFORM,
  refund,
  settleSuccess,
  validateSplits,
} from './ledger.ts';
import { emitEvent, isKillSwitchActive, statePaths, type MarketplaceReport } from './mm-contract.ts';
import { emptyStats, recordOutcome, recordRating, reputationScore } from './reputation.ts';
import { pickBest, scoreServices, type ScoredService } from './routing.ts';
import { generateApiKey, hashApiKey } from './auth.ts';
import { WriteQueue } from './store.ts';
import type { Agent, Job, MarketState, RevenueSplit, Service } from './types.ts';
import { microsToUsd, usdToMicros } from './types.ts';
import { callWebhook, validateWebhookUrl, WebhookError, type LookupFn, type SendFn } from './webhook.ts';

export class MarketError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type MarketDeps = {
  config: Config;
  askClaude?: AskClaude;
  webhookSend?: SendFn;
  webhookLookup?: LookupFn;
  /** Persist state/report after mutations (disabled in pure unit tests). */
  persist?: boolean;
  log?: (msg: string) => void;
};

export type MarketplaceReportFile = MarketplaceReport & { notes: string[] };

const REPORT_NOTES = [
  'Balances are internal marketplace credits added by the operator via POST /deposits; no real payment rails are integrated.',
  'platformRevenueUsd and revenueEvents are platform fees earned on completed jobs, denominated in those internal credits.',
];

export class Marketplace {
  readonly writes = new WriteQueue();
  private readonly running = new Map<string, Promise<Job>>();

  constructor(
    readonly state: MarketState,
    readonly deps: MarketDeps,
  ) {}

  private get config(): Config {
    return this.deps.config;
  }

  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.log(`[agent-marketplace] ${m}`)))(msg);
  }

  // ---------- persistence ----------

  persistState(): Promise<void> {
    if (this.deps.persist === false) return Promise.resolve();
    return this.writes.enqueue(this.config.stateFile, () => this.state);
  }

  persistReport(): Promise<void> {
    if (this.deps.persist === false) return Promise.resolve();
    return this.writes.enqueue(statePaths.marketplace(), () => this.report());
  }

  async flush(): Promise<void> {
    await this.persistState();
    await this.persistReport();
    await this.writes.idle();
  }

  // ---------- agents ----------

  registerAgent(input: { name: string; ownerWallet?: string; platform?: boolean }): { agent: Agent; apiKey: string } {
    const apiKey = generateApiKey();
    const agent: Agent = {
      id: `agt_${randomUUID()}`,
      name: input.name,
      ...(input.ownerWallet ? { ownerWallet: input.ownerWallet } : {}),
      apiKeyHash: hashApiKey(apiKey),
      createdAt: new Date().toISOString(),
      ...(input.platform ? { platform: true } : {}),
    };
    this.state.agents[agent.id] = agent;
    void this.persistState();
    return { agent, apiKey };
  }

  getAgent(id: string): Agent {
    const agent = this.state.agents[id];
    if (!agent) throw new MarketError(404, 'not_found', 'agent not found');
    return agent;
  }

  publicAgent(agent: Agent) {
    const { apiKeyHash: _omit, ...rest } = agent;
    const rep = this.state.reputation.agents[agent.id] ?? emptyStats();
    return { ...rest, reputation: { score: round(reputationScore(rep), 4), ...rep } };
  }

  balance(agentId: string) {
    this.getAgent(agentId);
    return { agentId, balanceUsd: microsToUsd(balanceOf(this.state, agentAccount(agentId))), currency: 'USD (internal credits)' };
  }

  // ---------- services ----------

  createService(
    agentId: string,
    input: {
      name: string;
      capability: string;
      description: string;
      priceUsd: number;
      handler: string;
      splits?: RevenueSplit[];
      active?: boolean;
    },
  ): { service: Service; webhookSecret?: string } {
    const agent = this.getAgent(agentId);
    const splits = input.splits ?? [];
    try {
      validateSplits(splits);
    } catch (err) {
      throw new MarketError(400, 'invalid_splits', (err as Error).message);
    }
    for (const s of splits) {
      if (!this.state.agents[s.agentId]) throw new MarketError(400, 'invalid_splits', `split recipient ${s.agentId} not found`);
      if (s.agentId === agentId) throw new MarketError(400, 'invalid_splits', 'provider cannot be a split recipient');
    }
    if (usdToMicros(input.priceUsd) < 0) throw new MarketError(400, 'invalid_price', 'price must be >= 0');

    let webhookSecret: string | undefined;
    if (input.handler.startsWith('builtin:')) {
      const name = input.handler.slice('builtin:'.length);
      if (!BUILTINS[name]) throw new MarketError(400, 'invalid_handler', `unknown builtin handler "${name}"`);
      if (!agent.platform) throw new MarketError(403, 'forbidden', 'builtin handlers can only be offered by the platform agent');
    } else if (input.handler.startsWith('webhook:')) {
      try {
        validateWebhookUrl(input.handler.slice('webhook:'.length), {
          allowlist: this.config.webhookAllowlist,
          allowPrivate: this.config.webhookAllowPrivate,
        });
      } catch (err) {
        throw new MarketError(400, 'invalid_handler', (err as Error).message);
      }
      webhookSecret = randomBytes(32).toString('hex');
    } else {
      throw new MarketError(400, 'invalid_handler', 'handler must be builtin:<name> or webhook:<url>');
    }

    const service: Service = {
      id: `svc_${randomUUID()}`,
      agentId,
      name: input.name,
      capability: input.capability.toLowerCase(),
      description: input.description,
      priceUsd: microsToUsd(usdToMicros(input.priceUsd)),
      handler: input.handler,
      active: input.active ?? true,
      splits,
      ...(webhookSecret ? { webhookSecret } : {}),
      createdAt: new Date().toISOString(),
    };
    this.state.services[service.id] = service;
    void this.persistState();
    void this.persistReport();
    return { service, ...(webhookSecret ? { webhookSecret } : {}) };
  }

  publicService(s: Service) {
    const { webhookSecret: _omit, ...rest } = s;
    const handlerKind = s.handler.startsWith('builtin:') ? s.handler : 'webhook';
    const rep = this.state.reputation.services[s.id] ?? emptyStats();
    return { ...rest, handler: handlerKind, reputation: { score: round(reputationScore(rep), 4), ...rep } };
  }

  private candidates(filter: { capability?: string; excludeAgentId?: string; q?: string }) {
    const cap = filter.capability?.toLowerCase();
    const q = filter.q?.toLowerCase();
    return Object.values(this.state.services)
      .filter((s) => s.active)
      .filter((s) => !cap || s.capability === cap)
      .filter((s) => !filter.excludeAgentId || s.agentId !== filter.excludeAgentId)
      .filter((s) => !q || `${s.name} ${s.description} ${s.capability}`.toLowerCase().includes(q))
      .map((service) => ({
        service,
        serviceStats: this.state.reputation.services[service.id],
        agentStats: this.state.reputation.agents[service.agentId],
      }));
  }

  /** Discovery: active services (optionally by capability / text), best routing score first. */
  listServices(filter: { capability?: string; q?: string } = {}): ScoredService[] {
    return scoreServices(this.candidates(filter));
  }

  // ---------- money ----------

  deposit(agentId: string, amountUsd: number, memo?: string) {
    this.getAgent(agentId);
    const micros = usdToMicros(amountUsd);
    if (micros <= 0) throw new MarketError(400, 'invalid_amount', 'amount must be positive');
    const entry = ledgerDeposit(this.state, agentId, micros, memo);
    void this.persistState();
    return { entryId: entry.id, ...this.balance(agentId) };
  }

  // ---------- jobs ----------

  /** Create a job: resolve the service (explicit or routed by capability) and hold the price in escrow. */
  requestJob(
    requesterAgentId: string,
    input: { serviceId?: string; capability?: string; input: unknown; maxPriceUsd?: number },
  ): Job {
    this.getAgent(requesterAgentId);
    if (isKillSwitchActive()) throw new MarketError(503, 'kill_switch', 'Money Machine kill switch is active; new jobs are not accepted');
    let service: Service | undefined;
    if (input.serviceId) {
      service = this.state.services[input.serviceId];
      if (!service || !service.active) throw new MarketError(404, 'not_found', 'service not found or inactive');
      if (input.maxPriceUsd !== undefined && service.priceUsd > input.maxPriceUsd) {
        throw new MarketError(409, 'price_exceeded', 'service price exceeds maxPriceUsd');
      }
    } else if (input.capability) {
      service = pickBest(this.candidates({ capability: input.capability, excludeAgentId: requesterAgentId }), input.maxPriceUsd)?.service;
      if (!service) throw new MarketError(404, 'no_provider', `no active provider for capability "${input.capability}"`);
    } else {
      throw new MarketError(400, 'invalid_request', 'serviceId or capability is required');
    }
    if (service.agentId === requesterAgentId) {
      throw new MarketError(400, 'self_dealing', 'agents cannot purchase their own services');
    }
    const job: Job = {
      id: `job_${randomUUID()}`,
      serviceId: service.id,
      requesterAgentId,
      providerAgentId: service.agentId,
      input: input.input,
      status: 'queued',
      priceUsd: service.priceUsd,
      timings: { createdAt: new Date().toISOString() },
    };
    try {
      holdEscrow(this.state, job);
    } catch (err) {
      if (err instanceof LedgerError && err.code === 'insufficient_funds') {
        throw new MarketError(402, 'insufficient_funds', 'balance does not cover the service price');
      }
      throw err;
    }
    this.state.jobs[job.id] = job;
    void this.persistState();
    return job;
  }

  getJob(id: string): Job {
    const job = this.state.jobs[id];
    if (!job) throw new MarketError(404, 'not_found', 'job not found');
    return job;
  }

  /** Execute a queued job and settle escrow. Idempotent: concurrent calls share one execution. */
  runJob(jobId: string): Promise<Job> {
    const existing = this.running.get(jobId);
    if (existing) return existing;
    const p = this.execute(jobId).finally(() => this.running.delete(jobId));
    this.running.set(jobId, p);
    return p;
  }

  private async execute(jobId: string): Promise<Job> {
    const job = this.getJob(jobId);
    if (job.status !== 'queued' || isKillSwitchActive()) return job;
    const service = this.state.services[job.serviceId];
    job.status = 'running';
    job.timings.startedAt = new Date().toISOString();
    const started = performance.now();
    let result: unknown;
    let error: string | undefined;
    try {
      if (!service) throw new Error('service no longer exists');
      result = await this.invoke(service, job);
    } catch (err) {
      error = err instanceof HandlerInputError || err instanceof WebhookError ? err.message : `execution failed: ${(err as Error).message}`;
    }
    const durationMs = Math.round(performance.now() - started);
    const now = new Date().toISOString();
    job.timings.finishedAt = now;
    job.timings.durationMs = durationMs;

    if (error === undefined) {
      const s = settleSuccess(this.state, job, this.config.platformFeePct, service?.splits ?? [], now);
      job.status = 'completed';
      job.result = result;
      job.feeUsd = microsToUsd(s.feeMicros);
      if (s.feeMicros > 0) {
        this.state.revenueEvents.push({ id: job.id, timestamp: now, amountUsd: microsToUsd(s.feeMicros), serviceId: job.serviceId });
      }
    } else {
      refund(this.state, job, now);
      job.status = job.priceUsd > 0 ? 'refunded' : 'failed';
      job.error = error;
    }
    const ok = job.status === 'completed';
    this.state.reputation.services[job.serviceId] = recordOutcome(this.state.reputation.services[job.serviceId] ?? emptyStats(), ok, durationMs);
    this.state.reputation.agents[job.providerAgentId] = recordOutcome(this.state.reputation.agents[job.providerAgentId] ?? emptyStats(), ok, durationMs);

    this.log(`job ${job.id} ${job.status} (${durationMs} ms, $${job.priceUsd})`);
    if (this.deps.persist !== false) void emitEvent({
      source: 'agent-marketplace',
      level: ok ? 'info' : 'warn',
      type: ok ? 'job.completed' : 'job.failed',
      message: `job ${job.id} ${job.status}`,
      data: { jobId: job.id, serviceId: job.serviceId, priceUsd: job.priceUsd, feeUsd: job.feeUsd ?? 0 },
    });
    await Promise.all([this.persistState(), this.persistReport()]);
    return job;
  }

  private async invoke(service: Service, job: Job): Promise<unknown> {
    if (service.handler.startsWith('builtin:')) {
      const handler = BUILTINS[service.handler.slice('builtin:'.length)];
      if (!handler) throw new Error(`unknown builtin ${service.handler}`);
      return handler(job.input, { askClaude: this.deps.askClaude });
    }
    if (service.handler.startsWith('webhook:')) {
      return callWebhook(
        service.handler.slice('webhook:'.length),
        { jobId: job.id, serviceId: service.id, capability: service.capability, requesterAgentId: job.requesterAgentId, input: job.input },
        {
          allowlist: this.config.webhookAllowlist,
          allowPrivate: this.config.webhookAllowPrivate,
          lookup: this.deps.webhookLookup,
          send: this.deps.webhookSend,
          secret: service.webhookSecret ?? '',
          timeoutMs: this.config.webhookTimeoutMs,
          jobId: job.id,
        },
      );
    }
    throw new Error('invalid handler');
  }

  /** Run every queued job (sequentially, oldest first). */
  async processQueue(): Promise<number> {
    if (isKillSwitchActive()) {
      this.log('kill switch active: queued jobs stay queued (escrow held) until it is cleared');
      return 0;
    }
    const queued = Object.values(this.state.jobs)
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.timings.createdAt.localeCompare(b.timings.createdAt));
    for (const job of queued) await this.runJob(job.id);
    return queued.length;
  }

  /** After a crash, jobs left in `running` have an unknown outcome: refund the requester. */
  recoverInterrupted(): number {
    let n = 0;
    for (const job of Object.values(this.state.jobs)) {
      if (job.status !== 'running') continue;
      refund(this.state, job);
      job.status = job.priceUsd > 0 ? 'refunded' : 'failed';
      job.error = 'interrupted by marketplace restart; escrow refunded';
      job.timings.finishedAt = new Date().toISOString();
      n++;
    }
    if (n) void this.persistState();
    return n;
  }

  rateJob(requesterAgentId: string, jobId: string, rating: number): Job {
    const job = this.getJob(jobId);
    if (job.requesterAgentId !== requesterAgentId) throw new MarketError(403, 'forbidden', 'only the requester can rate a job');
    if (job.status !== 'completed') throw new MarketError(409, 'invalid_state', 'only completed jobs can be rated');
    if (job.rating !== undefined) throw new MarketError(409, 'already_rated', 'job already rated');
    job.rating = rating;
    this.state.reputation.services[job.serviceId] = recordRating(this.state.reputation.services[job.serviceId] ?? emptyStats(), rating);
    this.state.reputation.agents[job.providerAgentId] = recordRating(this.state.reputation.agents[job.providerAgentId] ?? emptyStats(), rating);
    void this.persistState();
    return job;
  }

  // ---------- reporting ----------

  report(): MarketplaceReportFile {
    const jobs = Object.values(this.state.jobs);
    const completed = jobs.filter((j) => j.status === 'completed');
    const revenueMicros = this.state.revenueEvents.reduce((a, e) => a + usdToMicros(e.amountUsd), 0);
    return {
      schema: 'mm.marketplace/v1',
      timestamp: new Date().toISOString(),
      agents: Object.keys(this.state.agents).length,
      services: Object.values(this.state.services).filter((s) => s.active).length,
      jobsCompleted: completed.length,
      jobsFailed: jobs.filter((j) => j.status === 'failed' || j.status === 'refunded').length,
      grossVolumeUsd: microsToUsd(completed.reduce((a, j) => a + usdToMicros(j.priceUsd), 0)),
      platformRevenueUsd: microsToUsd(revenueMicros),
      revenueEvents: [...this.state.revenueEvents],
      notes: [...REPORT_NOTES, `platform account balance: $${microsToUsd(balanceOf(this.state, PLATFORM))}`],
    };
  }

  health() {
    const problems = checkInvariants(this.state);
    return { ok: problems.length === 0, problems, stateFile: path.basename(this.config.stateFile) };
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
