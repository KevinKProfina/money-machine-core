import Anthropic from '@anthropic-ai/sdk';
import type { Genome } from './genome.js';
import type { Rng } from './rng.js';
import type { LlmState } from './state.js';
import type { Species } from './types.js';

export const MODEL = 'claude-opus-5-5';

export type LlmResponse = {
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
};

/** Minimal client surface so tests can inject a fake. */
export type LlmClient = { create(prompt: string, maxTokens: number): Promise<LlmResponse> };

/** Real client: call shape per the Money Machine engineering brief. */
export function createAnthropicClient(apiKey: string): LlmClient {
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  return {
    async create(prompt, maxTokens) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: prompt }],
      });
      return {
        stop_reason: response.stop_reason,
        content: response.content.map((block) => (block.type === 'text' ? { type: 'text', text: block.text } : { type: block.type })),
        usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
      };
    },
  };
}

export type GenomeStat = { genome: Genome; returnPct: number; trades: number; winRate: number; ageCycles: number; alive: boolean };

export type MutatorConfig = {
  genomes: number;
  dailyBudgetUsd: number;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  maxTokens: number;
};

const r = (x: number, d = 4) => Number(x.toPrecision(d));

export function buildMutatorPrompt(species: Species, top: GenomeStat[], bottom: GenomeStat[], n: number): string {
  const genes = Object.entries(species.genomeSpec)
    .map(([k, s]) => `- ${k}: ${s.description}; range [${s.min}, ${s.max}]${s.integer || s.categorical ? ' (integer)' : ''}`)
    .join('\n');
  const fmt = (g: GenomeStat) =>
    JSON.stringify({ returnPct: r(g.returnPct * 100), trades: g.trades, winRate: r(g.winRate, 3), ageCycles: g.ageCycles, alive: g.alive, genome: Object.fromEntries(Object.entries(g.genome).map(([k, v]) => [k, r(v)])) });
  return [
    `You are tuning an evolutionary population of small PAPER-trading agents (species "${species.id}": ${species.description}).`,
    'Each agent pays upkeep every cycle and dies when its balance is too low; profitable agents reproduce with mutation.',
    'Fills include fees, slippage and liquidity price impact. All trading is simulated.',
    '',
    'Genes:',
    genes,
    '',
    'Best performing genomes:',
    ...top.map(fmt),
    '',
    'Worst performing genomes:',
    ...bottom.map(fmt),
    '',
    `Propose ${n} NEW, diverse genomes that you expect to survive and be profitable after costs.`,
    `Answer with ONLY a JSON array of ${n} objects using exactly the gene names above as keys and numbers as values. No prose, no code fences.`,
  ].join('\n');
}

export type ParseResult = { genomes: Genome[]; rejected: number; clampedGenes: number };

/** Defensive parse of a JSON array of genomes; out-of-bound values are clamped, junk is rejected. */
export function parseGenomeArray(text: string, species: Species, max: number, rng: Rng): ParseResult {
  const out: ParseResult = { genomes: [], rejected: 0, clampedGenes: 0 };
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return out;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(data)) return out;
  const geneCount = Object.keys(species.genomeSpec).length;
  for (const item of data) {
    if (out.genomes.length >= max) break;
    const res = species.validate(item, species.randomGenome(rng));
    if (res.missing.length > geneCount / 2) {
      out.rejected++;
      continue;
    }
    out.clampedGenes += res.clamped.length;
    out.genomes.push(res.genome);
  }
  return out;
}

export function costUsd(inputTokens: number, outputTokens: number, cfg: MutatorConfig): number {
  return (inputTokens * cfg.inputUsdPerMTok + outputTokens * cfg.outputUsdPerMTok) / 1_000_000;
}

/** Conservative upper bound of one call's cost (prompt at ~2 chars/token, full max_tokens output). */
export function worstCaseCostUsd(prompt: string, cfg: MutatorConfig): number {
  return costUsd(Math.ceil(prompt.length / 2) + 50, cfg.maxTokens, cfg);
}

export type MutatorOutcome =
  | { status: 'ok'; genomes: Genome[]; costUsd: number; note: string }
  | { status: 'refused' | 'error' | 'empty'; genomes: []; costUsd: number; note: string }
  | { status: 'budget'; genomes: []; costUsd: 0; note: string };

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Ask Claude for new genomes. Enforces the daily budget (and the caller-provided
 * treasury limit) before calling; the returned cost must be charged by the caller.
 * Never throws.
 */
export async function runMutator(args: {
  client: LlmClient;
  cfg: MutatorConfig;
  species: Species;
  top: GenomeStat[];
  bottom: GenomeStat[];
  rng: Rng;
  llm: LlmState;
  now: Date;
  maxAffordableUsd: number;
}): Promise<MutatorOutcome> {
  const { cfg, llm } = args;
  const day = utcDay(args.now);
  if (llm.day !== day) {
    llm.day = day;
    llm.dayUsd = 0;
  }
  const prompt = buildMutatorPrompt(args.species, args.top, args.bottom, cfg.genomes);
  const worst = worstCaseCostUsd(prompt, cfg);
  if (llm.dayUsd + worst > cfg.dailyBudgetUsd) return { status: 'budget', genomes: [], costUsd: 0, note: `daily LLM budget $${cfg.dailyBudgetUsd} reached` };
  if (worst > args.maxAffordableUsd) return { status: 'budget', genomes: [], costUsd: 0, note: 'treasury cannot cover worst-case LLM cost' };

  let response: LlmResponse;
  try {
    response = await args.client.create(prompt, cfg.maxTokens);
  } catch (error) {
    // A failed request may still have been billed; we cannot know, so charge nothing but record it.
    return { status: 'error', genomes: [], costUsd: 0, note: `LLM call failed: ${(error as Error).message}` };
  }
  const inTok = response.usage?.input_tokens;
  const outTok = response.usage?.output_tokens;
  const cost =
    typeof inTok === 'number' && typeof outTok === 'number' && Number.isFinite(inTok) && Number.isFinite(outTok)
      ? costUsd(inTok, outTok, cfg)
      : worst; // unknown usage → charge the conservative estimate
  if (response.stop_reason === 'refusal') return { status: 'refused', genomes: [], costUsd: cost, note: 'model refused; skipped' };
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
  const parsed = parseGenomeArray(text, args.species, cfg.genomes, args.rng);
  if (parsed.genomes.length === 0) return { status: 'empty', genomes: [], costUsd: cost, note: `no usable genomes in answer (rejected ${parsed.rejected})` };
  return {
    status: 'ok',
    genomes: parsed.genomes,
    costUsd: cost,
    note: `${parsed.genomes.length} genomes (rejected ${parsed.rejected}, clamped genes ${parsed.clampedGenes})`,
  };
}
