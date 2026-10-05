import { z } from 'zod';
import type { AskClaude } from '../claude.ts';
import {
  isKillSwitchActive,
  readJsonSafe,
  readStrategyReports,
  statePaths,
  type FinalAllocations,
  type PortfolioState,
  type RevenueReport,
} from '../mm-contract.ts';

export type BuiltinContext = { askClaude?: AskClaude };
export type BuiltinHandler = (input: unknown, ctx: BuiltinContext) => Promise<unknown>;

export class HandlerInputError extends Error {}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new HandlerInputError(`invalid input: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
  return r.data;
}

// ---------- echo ----------

export const echo: BuiltinHandler = async (input) => ({ echo: input });

// ---------- summarize ----------

const summarizeInput = z.object({
  text: z.string().min(1).max(50_000),
  maxSentences: z.number().int().min(1).max(10).optional(),
});

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Deterministic extractive summary: the first N sentences (N defaults to 2). */
export function extractiveSummary(text: string, maxSentences = 2): string {
  const sentences = splitSentences(text);
  const out = sentences.slice(0, maxSentences).join(' ');
  return out.length > 1000 ? out.slice(0, 997) + '...' : out;
}

export const summarize: BuiltinHandler = async (input, ctx) => {
  const { text, maxSentences = 2 } = parseInput(summarizeInput, input);
  if (ctx.askClaude) {
    const answer = await ctx.askClaude(
      'Summarize the following text in ONE line of at most 40 words. Reply with the summary line only, ' +
        'no preamble. If you cannot, reply exactly SKIP.\n\n<text>\n' +
        text +
        '\n</text>',
    );
    const line = answer?.split('\n').map((l) => l.trim()).find(Boolean);
    if (line && line.toUpperCase() !== 'SKIP' && line.length <= 600) {
      return { mode: 'claude', summary: line };
    }
  }
  return {
    mode: 'fallback',
    summary: extractiveSummary(text, maxSentences),
    note: 'Deterministic extractive summary (first sentences); Claude not configured or returned no usable answer.',
  };
};

// ---------- mm-status ----------

/** Compact status of the Money Machine read from $MM_STATE_DIR (read-only). */
export const mmStatus: BuiltinHandler = async () => {
  const [portfolio, allocations, revenue, strategies] = await Promise.all([
    readJsonSafe<PortfolioState | null>(statePaths.portfolio(), null),
    readJsonSafe<FinalAllocations | null>(statePaths.allocations(), null),
    readJsonSafe<RevenueReport | null>(statePaths.revenue(), null),
    readStrategyReports(),
  ]);
  const p = portfolio?.schema === 'mm.portfolio/v1' ? portfolio : null;
  const a = allocations?.schema === 'mm.allocations/v1' ? allocations : null;
  const r = revenue?.schema === 'mm.revenue/v1' ? revenue : null;
  return {
    generatedAt: new Date().toISOString(),
    killSwitch: isKillSwitchActive() || a?.killSwitch === true,
    portfolio: p
      ? {
          timestamp: p.timestamp,
          totalCapitalUsd: p.totalCapitalUsd,
          allocatedUsd: p.allocatedUsd,
          reserveUsd: p.reserveUsd,
          totalPnlUsd: p.totalPnlUsd,
          portfolioReturn: p.portfolioReturn,
          maxDrawdown: p.maxDrawdown,
          riskScore: p.riskScore,
          activeStrategies: p.activeStrategies,
          pausedStrategies: p.pausedStrategies,
        }
      : null,
    strategies: strategies.map((s) => ({
      name: s.name,
      kind: s.kind,
      mode: s.mode,
      simulated: s.mode !== 'live',
      status: s.status,
      capitalUsd: s.capitalUsd,
      totalReturn: s.totalReturn,
      winRate: s.winRate,
      maxDrawdown: s.maxDrawdown,
      totalTrades: s.totalTrades,
      openPositions: s.openPositions,
      lastUpdated: s.lastUpdated,
    })),
    revenue: r ? { timestamp: r.timestamp, totalUsd: r.totalUsd, last7dUsd: r.last7dUsd, last30dUsd: r.last30dUsd, concentration: r.concentration } : null,
    notes: [
      ...(p ? [] : ['portfolio.json not found yet']),
      ...(strategies.length ? [] : ['no strategy reports found']),
      ...(strategies.some((s) => s.mode !== 'live') ? ['strategies in paper/dry-run mode report simulated PnL'] : []),
    ],
  };
};

export const BUILTINS: Record<string, BuiltinHandler> = {
  echo,
  summarize,
  'mm-status': mmStatus,
};
