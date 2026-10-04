/**
 * Operator alerts via Telegram. Silently disabled without TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID;
 * a failed send is logged and never breaks the supervisor.
 */
export type AlertSender = (text: string) => Promise<void>;

export function telegramSender(
  token = process.env.TELEGRAM_BOT_TOKEN,
  chatId = process.env.TELEGRAM_CHAT_ID,
  fetchImpl: typeof fetch = fetch,
): AlertSender | undefined {
  if (!token || !chatId) return undefined;
  return async (text) => {
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) console.warn(`telegram alert failed: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`telegram alert failed: ${(err as Error).message}`);
    }
  };
}

export type AlertState = { failing: string[]; killSwitch: boolean; live: string[] };

/**
 * Decides which alerts to send by comparing the previous and current state, so a
 * component that stays broken alerts once (and once more when it recovers), not every cycle.
 */
export function diffAlerts(prev: AlertState, next: AlertState): string[] {
  const out: string[] = [];
  const newlyFailing = next.failing.filter((n) => !prev.failing.includes(n));
  const recovered = prev.failing.filter((n) => !next.failing.includes(n));
  if (newlyFailing.length) out.push(`⚠️ Money Machine: component failing: ${newlyFailing.join(', ')}`);
  if (recovered.length) out.push(`✅ Money Machine: component recovered: ${recovered.join(', ')}`);
  if (next.killSwitch && !prev.killSwitch) out.push('🛑 Money Machine: kill switch ACTIVE — no new positions');
  if (!next.killSwitch && prev.killSwitch) out.push('▶️ Money Machine: kill switch cleared');
  const newlyLive = next.live.filter((n) => !prev.live.includes(n));
  if (newlyLive.length) out.push(`💸 Money Machine: LIVE mode (real funds) detected for: ${newlyLive.join(', ')}`);
  return out;
}
