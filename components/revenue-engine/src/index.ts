import { emitEvent } from './mm-contract.js';
import { runCycle } from './engine.js';
import { loadDotEnv } from './env.js';
import { consoleLogger as log } from './types.js';

loadDotEnv();

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  if (once) {
    await runCycle();
    return;
  }
  const raw = Number(process.env.REVENUE_INTERVAL_MS ?? 300_000);
  const intervalMs = Number.isFinite(raw) && raw >= 1000 ? raw : 300_000;
  log.info(`loop mode, interval ${intervalMs} ms (Ctrl+C to stop)`);
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    if (timer) clearTimeout(timer);
    wake?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    try {
      await runCycle();
    } catch (err) {
      log.error(`cycle failed: ${(err as Error).message}`);
      await emitEvent({ source: 'revenue-engine', level: 'error', type: 'revenue.cycle-failed', message: (err as Error).message });
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, intervalMs);
    });
  }
  log.info('stopped');
}

main().catch(async (err) => {
  log.error(`fatal: ${(err as Error).stack ?? err}`);
  await emitEvent({ source: 'revenue-engine', level: 'error', type: 'revenue.fatal', message: (err as Error).message });
  process.exit(1);
});
