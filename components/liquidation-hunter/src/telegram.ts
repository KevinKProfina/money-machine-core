import { fetchWithRetry, type FetchLike } from './http.js';

export type Notifier = { send(text: string): Promise<void> };

export const noopNotifier: Notifier = { async send() {} };

/** Telegram alerts; a no-op when token/chat are missing. Never throws. */
export function createTelegramNotifier(
  token: string | undefined,
  chatId: string | undefined,
  fetchImpl?: FetchLike,
): Notifier {
  if (!token || !chatId) return noopNotifier;
  return {
    async send(text: string) {
      try {
        const res = await fetchWithRetry(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          },
          { timeoutMs: 8000, retries: 2, backoffMs: 500, fetchImpl },
        );
        if (!res.ok) console.warn(`[telegram] send failed: HTTP ${res.status}`);
      } catch (err) {
        console.warn(`[telegram] send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
