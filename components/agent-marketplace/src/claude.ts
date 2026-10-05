import Anthropic from '@anthropic-ai/sdk';

export const CLAUDE_MODEL = 'claude-opus-5-5';

/** Returns a one-line answer, or undefined for SKIP (refusal, empty, unclear, error). */
export type AskClaude = (prompt: string) => Promise<string | undefined>;

export function makeAskClaude(apiKey: string | undefined, timeoutMs = 30_000): AskClaude | undefined {
  if (!apiKey) return undefined;
  const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 2 });
  return async (prompt) => {
    try {
      const msg = await client.beta.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: prompt }],
      });
      if (msg.stop_reason === 'refusal') return undefined;
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join(' ')
        .trim();
      return text || undefined;
    } catch (err) {
      console.warn(`[agent-marketplace] Claude call failed, using fallback: ${(err as Error).message}`);
      return undefined;
    }
  };
}
