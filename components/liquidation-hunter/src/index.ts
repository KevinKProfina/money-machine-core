import { emitEvent } from './mm-contract.js';
import { ClaudeGate } from './claude-gate.js';
import { assertRunnable, ConfigError, loadConfig, STRATEGY_NAME } from './config.js';
import { runCycle } from './cycle.js';
import { createSource } from './sources/index.js';
import { createTelegramNotifier } from './telegram.js';

function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // no .env file: rely on the process environment
  }
}

async function main(): Promise<number> {
  loadDotEnv();
  const once = process.argv.includes('--once');

  let config;
  try {
    config = loadConfig();
    assertRunnable(config);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[${STRATEGY_NAME}] refusing to start: ${err.message}`);
      await emitEvent({ source: STRATEGY_NAME, level: 'error', type: 'config.invalid', message: err.message });
      return 1;
    }
    throw err;
  }

  const source = createSource(config);
  const claudeGate = config.claudeGateEnabled && config.anthropicApiKey ? ClaudeGate.fromApiKey(config.anthropicApiKey) : undefined;
  const notifier = createTelegramNotifier(config.telegramBotToken, config.telegramChatId);

  console.log(
    `[${STRATEGY_NAME}] mode=${config.mode} source=${source.id}${source.simulated ? ' (SIMULATED)' : ''} ` +
      `claudeGate=${claudeGate ? 'on' : 'off'} telegram=${config.telegramBotToken && config.telegramChatId ? 'on' : 'off'}`,
  );

  if (once) {
    await runCycle({ config, source, claudeGate, notifier });
    return 0;
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    try {
      await runCycle({ config, source, claudeGate, notifier });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${STRATEGY_NAME}] cycle failed: ${msg}`);
      await emitEvent({ source: STRATEGY_NAME, level: 'error', type: 'cycle.failed', message: msg });
    }
    const until = Date.now() + config.intervalMs;
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`[${STRATEGY_NAME}] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
