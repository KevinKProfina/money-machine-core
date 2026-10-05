import Anthropic from '@anthropic-ai/sdk';
import type { Token } from './market.js';

export type GateDecision = { decision: 'BUY' | 'SKIP'; reason: string };
/** Optional final gate after the deterministic rules. Must never throw. */
export type Gate = (token: Token, score: number) => Promise<GateDecision>;

export const MODEL = 'claude-opus-5-5';

/** Parse a strict one-line "BUY: reason" / "SKIP: reason" answer; anything else is SKIP. */
export function parseGateAnswer(text: string): GateDecision {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  const match = /^(BUY|SKIP)\s*[:\-–]\s*(.*)$/i.exec(line);
  if (!match) return { decision: 'SKIP', reason: `unparseable answer: ${line.slice(0, 80) || '(empty)'}` };
  return { decision: match[1]!.toUpperCase() === 'BUY' ? 'BUY' : 'SKIP', reason: match[2]!.trim() || '(no reason)' };
}

export function buildPrompt(token: Token, score: number): string {
  const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
  return [
    'You are a conservative risk reviewer for a small, automated Solana token trading strategy.',
    'The token below already passed deterministic liquidity/volume/age/buy-pressure gates.',
    'Decide whether opening a small long position is reasonable. When in doubt, SKIP.',
    'Answer with exactly one line and nothing else, in one of these forms:',
    'BUY: <short reason>',
    'SKIP: <short reason>',
    '',
    `symbol: ${token.symbol} (${token.name})`,
    `mint: ${token.mint}`,
    `dex: ${token.dexId}`,
    `price: $${token.priceUsd}`,
    `liquidity: ${usd(token.liquidityUsd)}`,
    `24h volume: ${usd(token.volume24hUsd)}`,
    `market cap: ${usd(token.marketCapUsd)}`,
    `pair age: ${Number.isFinite(token.ageHours) ? `${token.ageHours.toFixed(1)}h` : 'unknown'}`,
    `24h buys/sells: ${token.buys24h}/${token.sells24h}`,
    `deterministic score: ${score}/100`,
  ].join('\n');
}

export function createClaudeGate(apiKey: string): Gate {
  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  return async (token, score) => {
    try {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: buildPrompt(token, score) }],
      });
      if (response.stop_reason === 'refusal') return { decision: 'SKIP', reason: 'model refused' };
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      return parseGateAnswer(text);
    } catch (error) {
      return { decision: 'SKIP', reason: `claude gate error: ${(error as Error).message}` };
    }
  };
}
