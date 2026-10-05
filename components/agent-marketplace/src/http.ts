import http from 'node:http';
import { z } from 'zod';
import { findAgentByKey, isAdmin, parseBearer } from './auth.ts';
import { MAX_SPLITS } from './ledger.ts';
import { MarketError, type Marketplace } from './marketplace.ts';
import type { Agent, Job } from './types.ts';

// ---------- request schemas ----------

const capabilitySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, 'capability may contain letters, digits, . _ : -');

const createAgentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  ownerWallet: z.string().trim().min(1).max(128).optional(),
});

const createServiceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  capability: capabilitySchema,
  description: z.string().trim().max(2000).default(''),
  priceUsd: z.number().finite().min(0).max(1_000_000),
  handler: z.string().trim().min(1).max(2048),
  active: z.boolean().optional(),
  splits: z
    .array(
      z.object({
        agentId: z.string().min(1).max(100),
        pct: z.number().gt(0).max(100),
        label: z.string().max(100).optional(),
      }),
    )
    .max(MAX_SPLITS)
    .optional(),
});

const depositSchema = z.object({
  agentId: z.string().min(1).max(100),
  amountUsd: z.number().finite().gt(0).max(1_000_000),
  memo: z.string().max(200).optional(),
});

const createJobSchema = z
  .object({
    serviceId: z.string().min(1).max(100).optional(),
    capability: capabilitySchema.optional(),
    input: z.unknown().optional(),
    maxPriceUsd: z.number().finite().min(0).optional(),
    wait: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.serviceId) !== Boolean(v.capability), { message: 'provide exactly one of serviceId or capability' });

const ratingSchema = z.object({ rating: z.number().int().min(1).max(5) });

// ---------- helpers ----------

class HttpError extends MarketError {}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string, details?: unknown): void {
  send(res, status, { error: { code, message, ...(details !== undefined ? { details } : {}) } });
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'payload_too_large', `body exceeds ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', `body exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body is not valid JSON');
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw Object.assign(new HttpError(400, 'validation_error', 'request validation failed'), {
      details: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export type ServerOptions = { maxBodyBytes: number; adminToken?: string; waitTimeoutMs?: number };

export function createServer(market: Marketplace, opts: ServerOptions): http.Server {
  const authAgent = (req: http.IncomingMessage): Agent => {
    const agent = findAgentByKey(Object.values(market.state.agents), parseBearer(req.headers.authorization));
    if (!agent) throw new HttpError(401, 'unauthorized', 'missing or invalid API key');
    return agent;
  };
  const admin = (req: http.IncomingMessage): boolean => isAdmin(opts.adminToken, parseBearer(req.headers.authorization));

  const viewJob = (job: Job) => job;

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean);
    const p0 = parts[0];

    if (method === 'GET' && url.pathname === '/health') {
      const h = market.health();
      return send(res, h.ok ? 200 : 500, { status: h.ok ? 'ok' : 'degraded', problems: h.problems, time: new Date().toISOString() });
    }
    if (method === 'GET' && url.pathname === '/metrics') return send(res, 200, market.report());

    if (p0 === 'agents') {
      if (parts.length === 1 && method === 'POST') {
        const body = parse(createAgentSchema, await readBody(req, opts.maxBodyBytes));
        const { agent, apiKey } = market.registerAgent(body);
        return send(res, 201, { agent: market.publicAgent(agent), apiKey, note: 'Store the apiKey now; it is not shown again.' });
      }
      if (parts.length === 2 && method === 'GET') return send(res, 200, market.publicAgent(market.getAgent(parts[1]!)));
      if (parts.length === 3 && parts[2] === 'balance' && method === 'GET') {
        const id = parts[1]!;
        if (!admin(req) && authAgent(req).id !== id) throw new HttpError(403, 'forbidden', 'can only read your own balance');
        return send(res, 200, market.balance(id));
      }
    }

    if (p0 === 'services') {
      if (parts.length === 1 && method === 'GET') {
        const capability = url.searchParams.get('capability') ?? undefined;
        const q = url.searchParams.get('q') ?? undefined;
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
        const scored = market.listServices({ capability, q }).slice(0, limit);
        return send(res, 200, {
          services: scored.map((s) => ({ ...market.publicService(s.service), routingScore: Number(s.score.toFixed(4)), scoreComponents: s.components })),
        });
      }
      if (parts.length === 1 && method === 'POST') {
        const agent = authAgent(req);
        const body = parse(createServiceSchema, await readBody(req, opts.maxBodyBytes));
        const { service, webhookSecret } = market.createService(agent.id, body);
        return send(res, 201, {
          service: market.publicService(service),
          ...(webhookSecret ? { webhookSecret, note: 'Use webhookSecret to verify x-marketplace-signature; it is not shown again.' } : {}),
        });
      }
      if (parts.length === 2 && method === 'GET') {
        const s = market.state.services[parts[1]!];
        if (!s) throw new HttpError(404, 'not_found', 'service not found');
        return send(res, 200, market.publicService(s));
      }
    }

    if (p0 === 'deposits' && parts.length === 1 && method === 'POST') {
      if (!opts.adminToken) throw new HttpError(403, 'forbidden', 'deposits are disabled (ADMIN_TOKEN not configured)');
      if (!admin(req)) throw new HttpError(401, 'unauthorized', 'admin token required');
      const body = parse(depositSchema, await readBody(req, opts.maxBodyBytes));
      return send(res, 201, market.deposit(body.agentId, body.amountUsd, body.memo));
    }

    if (p0 === 'jobs') {
      if (parts.length === 1 && method === 'POST') {
        const agent = authAgent(req);
        const body = parse(createJobSchema, await readBody(req, opts.maxBodyBytes));
        const job = market.requestJob(agent.id, { ...body, input: body.input ?? null });
        const run = market.runJob(job.id);
        if (body.wait) {
          const done = await withTimeout(run, opts.waitTimeoutMs ?? 30_000);
          if (done && done.status !== 'queued' && done.status !== 'running') return send(res, 200, viewJob(done));
        } else {
          run.catch((err: unknown) => console.error(`[agent-marketplace] job ${job.id} crashed: ${(err as Error).message}`));
        }
        return send(res, 202, viewJob(market.getJob(job.id)));
      }
      if (parts.length === 2 && method === 'GET') {
        const isAdmin = admin(req);
        const agent = isAdmin ? undefined : authAgent(req);
        const job = market.getJob(parts[1]!);
        if (agent && agent.id !== job.requesterAgentId && agent.id !== job.providerAgentId) {
          throw new HttpError(404, 'not_found', 'job not found');
        }
        return send(res, 200, viewJob(job));
      }
      if (parts.length === 3 && parts[2] === 'rating' && method === 'POST') {
        const agent = authAgent(req);
        const body = parse(ratingSchema, await readBody(req, opts.maxBodyBytes));
        return send(res, 200, viewJob(market.rateJob(agent.id, parts[1]!, body.rating)));
      }
    }

    throw new HttpError(404, 'not_found', `no route for ${method} ${url.pathname}`);
  }

  return http.createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof MarketError) {
        return sendError(res, err.status, err.code, err.message, (err as MarketError & { details?: unknown }).details);
      }
      console.error(`[agent-marketplace] unhandled error: ${(err as Error).stack ?? String(err)}`);
      sendError(res, 500, 'internal_error', 'internal server error');
    });
  });
}
