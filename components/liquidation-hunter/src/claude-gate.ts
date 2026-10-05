import Anthropic from '@anthropic-ai/sdk';
import type { Opportunity } from './types.js';

export type ClaudeVerdict = { decision: 'execute' | 'skip'; reason: string };

/** Minimal shape of the client we use, so tests can inject a fake. */
export type BetaMessagesClient = {
  beta: { messages: { create: (params: any) => Promise<any> } };
};

export const CLAUDE_MODEL = 'claude-opus-5-5';

export function buildPrompt(opp: Opportunity): string {
  const { position: p, economics: e } = opp;
  return [
    'You are a conservative risk reviewer for a DeFi liquidation bot.',
    p.simulated ? 'NOTE: this position is SIMULATED test data.' : '',
    `Protocol: ${p.protocol} (${p.chain}); collateral ${p.collateralSymbol}, debt ${p.debtSymbol}.`,
    `Collateral $${p.collateralUsd.toFixed(2)}, debt $${p.debtUsd.toFixed(2)}, health factor ${e.healthFactor.toFixed(4)}.`,
    `Liquidation threshold ${(p.liquidationThreshold * 100).toFixed(2)} %, bonus ${(p.liquidationBonus * 100).toFixed(2)} %, close factor ${p.closeFactor}.`,
    `Repay $${e.repayUsd.toFixed(2)}, seize $${e.collateralSeizedUsd.toFixed(2)}, gas $${e.gasUsd.toFixed(2)}, slippage $${e.slippageUsd.toFixed(2)}, flash fee $${e.flashLoanFeeUsd.toFixed(2)}.`,
    `Expected net $${e.netProfitUsd.toFixed(2)}; risk score ${e.riskScore.toFixed(1)}/100; collateral annual vol ${(p.collateralVolatility * 100).toFixed(0)} %.`,
    'Risks include price moves before the collateral is sold, gas spikes, competing liquidators/MEV, failed transactions and sale slippage.',
    'Answer with exactly one line: "EXECUTE: <short reason>" or "SKIP: <short reason>". No other text.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Parses a strict one-line answer. Anything unclear is SKIP. */
export function parseVerdict(text: string): ClaudeVerdict {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length !== 1) return { decision: 'skip', reason: 'claude: unclear answer' };
  const m = /^(EXECUTE|SKIP)\s*:\s*(.*)$/i.exec(lines[0]!.replace(/^["'`*]+|["'`*]+$/g, ''));
  if (!m) return { decision: 'skip', reason: 'claude: unclear answer' };
  const decision = m[1]!.toUpperCase() === 'EXECUTE' ? 'execute' : 'skip';
  return { decision, reason: `claude: ${m[2]?.trim() || decision}` };
}

export class ClaudeGate {
  constructor(private readonly client: BetaMessagesClient) {}

  static fromApiKey(apiKey: string): ClaudeGate {
    return new ClaudeGate(new Anthropic({ apiKey, timeout: 30_000, maxRetries: 2 }));
  }

  async review(opp: Opportunity): Promise<ClaudeVerdict> {
    try {
      const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: buildPrompt(opp) }],
      };
      const response = await this.client.beta.messages.create(params);
      if (response?.stop_reason === 'refusal') return { decision: 'skip', reason: 'claude: refusal' };
      const blocks: unknown[] = Array.isArray(response?.content) ? response.content : [];
      const text = blocks
        .filter((b): b is { type: 'text'; text: string } => (b as { type?: string })?.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return parseVerdict(text);
    } catch (err) {
      return { decision: 'skip', reason: `claude: error (${err instanceof Error ? err.message : String(err)})` };
    }
  }
}
