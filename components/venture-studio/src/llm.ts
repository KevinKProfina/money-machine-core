import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

export const MODEL = 'claude-opus-5-5';

export type LlmTask = 'ideas' | 'critic' | 'product' | 'landing' | 'review' | 'revise' | 'followups';

export type LlmRequest = {
  task: LlmTask;
  system: string;
  prompt: string;
  maxTokens: number;
  effort: 'low' | 'medium';
  /** When set, the real client asks for structured output with this schema. */
  schema?: z.ZodType;
};

export type LlmResponse = {
  stop_reason: string | null;
  text: string;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
};

/** Minimal client surface so tests and the simulator can inject a fake. */
export type LlmClient = { create(req: LlmRequest): Promise<LlmResponse> };

/**
 * Real client. Structured outputs (output_config.format via zodOutputFormat) are sent
 * on the plain beta `create` call rather than `messages.parse`: `parse` throws on a
 * refusal or invalid JSON and loses `usage`, while we must (1) check
 * stop_reason === 'refusal' first and (2) charge the real token usage either way.
 * The returned text is validated with the same zod schema by the caller.
 */
export function createAnthropicClient(apiKey: string): LlmClient {
  const client = new Anthropic({ apiKey, timeout: 15 * 60_000, maxRetries: 2 });
  return {
    async create(req) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: req.maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: req.schema ? { effort: req.effort, format: zodOutputFormat(req.schema) } : { effort: req.effort },
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
      });
      const text = response.stop_reason === 'refusal' ? '' : response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      return { stop_reason: response.stop_reason, text, usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens } };
    },
  };
}

export type LlmLedger = {
  day: string;
  dayUsd: number;
  totalUsd: number;
  calls: number;
  refusals: number;
  failures: number;
  budgetSkips: number;
  lastNote?: string;
};

export function emptyLedger(): LlmLedger {
  return { day: '', dayUsd: 0, totalUsd: 0, calls: 0, refusals: 0, failures: 0, budgetSkips: 0 };
}

export type Pricing = { dailyBudgetUsd: number; inputUsdPerMTok: number; outputUsdPerMTok: number };

export function costUsd(inputTokens: number, outputTokens: number, p: Pricing): number {
  return (inputTokens * p.inputUsdPerMTok + outputTokens * p.outputUsdPerMTok) / 1_000_000;
}

/** Conservative upper bound of one call (prompt at ~2 chars/token, full max_tokens output). */
export function worstCaseCostUsd(req: Pick<LlmRequest, 'system' | 'prompt' | 'maxTokens'>, p: Pricing): number {
  return costUsd(Math.ceil((req.system.length + req.prompt.length) / 2) + 200, req.maxTokens, p);
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export type LlmResult =
  | { status: 'ok'; text: string; costUsd: number }
  | { status: 'disabled' | 'budget' | 'refused' | 'error'; note: string; costUsd: number };

export type JsonResult<T> = { status: 'ok'; data: T; costUsd: number } | { status: 'disabled' | 'budget' | 'refused' | 'error' | 'invalid'; note: string; costUsd: number };

/** Extract the first JSON object/array from a text answer (tolerates fences and prose). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const starts = [trimmed.indexOf('{'), trimmed.indexOf('[')].filter((i) => i >= 0);
  if (starts.length === 0) return undefined;
  const start = Math.min(...starts);
  const close = trimmed[start] === '{' ? '}' : ']';
  const end = trimmed.lastIndexOf(close);
  if (end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Budget-guarded LLM access. The daily cap is checked against the worst case
 * BEFORE every call; actual cost (usage × price) is booked afterwards. Never throws.
 */
export class Llm {
  constructor(
    private readonly client: LlmClient | undefined,
    private readonly pricing: Pricing,
    readonly ledger: LlmLedger,
    private readonly now: () => Date,
  ) {}

  get enabled(): boolean {
    return this.client !== undefined;
  }

  private rollDay(): void {
    const day = utcDay(this.now());
    if (this.ledger.day !== day) {
      this.ledger.day = day;
      this.ledger.dayUsd = 0;
    }
  }

  canAfford(req: Pick<LlmRequest, 'system' | 'prompt' | 'maxTokens'>): boolean {
    this.rollDay();
    return this.ledger.dayUsd + worstCaseCostUsd(req, this.pricing) <= this.pricing.dailyBudgetUsd;
  }

  async call(req: LlmRequest): Promise<LlmResult> {
    if (!this.client) return { status: 'disabled', note: 'no ANTHROPIC_API_KEY', costUsd: 0 };
    this.rollDay();
    const worst = worstCaseCostUsd(req, this.pricing);
    if (this.ledger.dayUsd + worst > this.pricing.dailyBudgetUsd) {
      this.ledger.budgetSkips++;
      this.ledger.lastNote = `${req.task}: daily LLM budget $${this.pricing.dailyBudgetUsd} would be exceeded (worst case $${worst.toFixed(3)})`;
      return { status: 'budget', note: this.ledger.lastNote, costUsd: 0 };
    }
    this.ledger.calls++;
    let res: LlmResponse;
    try {
      res = await this.client.create(req);
    } catch (error) {
      // The request may have been billed; we cannot know. Book the worst case to stay under the cap.
      this.book(worst);
      this.ledger.failures++;
      this.ledger.lastNote = `${req.task}: LLM call failed: ${(error as Error).message}`;
      return { status: 'error', note: this.ledger.lastNote, costUsd: worst };
    }
    const inTok = res.usage?.input_tokens;
    const outTok = res.usage?.output_tokens;
    const cost = typeof inTok === 'number' && typeof outTok === 'number' && Number.isFinite(inTok) && Number.isFinite(outTok) ? costUsd(inTok, outTok, this.pricing) : worst;
    this.book(cost);
    if (res.stop_reason === 'refusal') {
      this.ledger.refusals++;
      this.ledger.lastNote = `${req.task}: model refused`;
      return { status: 'refused', note: this.ledger.lastNote, costUsd: cost };
    }
    if (res.stop_reason === 'max_tokens') {
      this.ledger.lastNote = `${req.task}: answer truncated at max_tokens`;
      return { status: 'error', note: this.ledger.lastNote, costUsd: cost };
    }
    return { status: 'ok', text: res.text, costUsd: cost };
  }

  async callJson<S extends z.ZodType>(req: Omit<LlmRequest, 'schema'>, schema: S): Promise<JsonResult<z.infer<S>>> {
    const r = await this.call({ ...req, schema });
    if (r.status !== 'ok') return r;
    const parsed = schema.safeParse(extractJson(r.text));
    if (!parsed.success) return { status: 'invalid', note: `${req.task}: answer did not match schema`, costUsd: r.costUsd };
    return { status: 'ok', data: parsed.data, costUsd: r.costUsd };
  }

  private book(usd: number): void {
    this.ledger.dayUsd += usd;
    this.ledger.totalUsd += usd;
  }
}
