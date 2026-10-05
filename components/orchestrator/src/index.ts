import 'dotenv/config';
import { readConfig } from './config.js';
import { resetKillSwitch, runCycle } from './cycle.js';
import { emitEvent } from './mm-contract.js';

const args = process.argv.slice(2);

async function fatal(err: unknown): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[orchestrator] fatal: ${message}`);
  await emitEvent({ source: 'orchestrator', level: 'error', type: 'fatal', message });
  process.exit(1);
}

async function main(): Promise<void> {
  if (args.includes('--reset-kill-switch')) {
    await resetKillSwitch();
    console.log('[orchestrator] drawdown kill switch reset; high-water mark re-anchors next cycle');
    return;
  }

  const config = readConfig(); // throws ConfigError on invalid env -> exit 1
  if (args.includes('--once')) {
    await runCycle(config);
    return;
  }

  console.log(`[orchestrator] loop mode, interval ${config.pollIntervalMs} ms`);
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    try {
      await runCycle(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[orchestrator] cycle failed: ${message}`);
      await emitEvent({ source: 'orchestrator', level: 'error', type: 'cycle-failed', message });
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, config.pollIntervalMs);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}

main().catch(fatal);
