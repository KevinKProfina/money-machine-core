/** Best-effort Telegram alert. Without TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID it only logs. Never throws. */
export async function sendTelegramAlert(message: string, env: Record<string, string | undefined> = process.env): Promise<void> {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.log(`[alert] ${message}`);
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.error(`[alert] Telegram responded ${res.status}`);
  } catch (error) {
    console.error(`[alert] Telegram alert failed: ${(error as Error).message}`);
  }
}
