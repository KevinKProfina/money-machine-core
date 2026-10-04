import dotenv from 'dotenv';
import { InvariantError } from './arena.js';
import { ConfigError, readConfig, STRATEGY_NAME } from './config.js';
import { emitEvent } from './mm-contract.js';
import { ArenaRunner } from './runner.js';

dotenv.config({ quiet: true });

async function once(runner: ArenaRunner): Promise<void> {
  const started = Date.now();
  await runner.cycle();
  const { report, summary } = await runner.persist();
  console.log(
    `[arena] cycle=${summary.cycle} market=${summary.marketSource}${summary.marketOk ? '' : '(FAILED)'} status=${report.status} ` +
      `pop=${summary.population} births=${summary.births.lastCycle} deaths=${summary.deaths.lastCycle} maxGen=${summary.maxGeneration} ` +
      `equity=$${summary.equityUsd.toFixed(2)} treasury=$${summary.treasuryUsd.toFixed(2)} realized=$${report.realizedPnlUsd} ` +
      `unrealized=$${report.unrealizedPnlUsd} trades=${report.totalTrades} (${Date.now() - started} ms)`,
  );
}

async function main(): Promise<void> {
  const cfg = readConfig();
  console.log(`[init] ${STRATEGY_NAME} starting in PAPER mode (market: ${cfg.market})`);
  for (const note of cfg.modeNotes) console.warn(`[init] ${note}`);
  if (!cfg.llm.apiKey) console.log('[init] no ANTHROPIC_API_KEY: Claude mutator disabled (pure evolution)');
  const verbose = process.env.ARENA_VERBOSE === '1';
  const runner = await ArenaRunner.open({ cfg, log: (m) => (verbose || !m.startsWith('[trade]') ? console.log(m) : undefined) });

  if (process.argv.includes('--once')) {
    await once(runner);
    return;
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
    console.log('[loop] stopping after current cycle');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    try {
      await once(runner);
    } catch (error) {
      if (error instanceof InvariantError) throw error; // books are broken: stop, do not keep trading
      const message = `cycle failed: ${(error as Error).message}`;
      console.error(`[loop] ${message}`);
      await emitEvent({ source: STRATEGY_NAME, level: 'error', type: 'cycle.failed', message });
    }
    const until = Date.now() + cfg.intervalMs;
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(1_000, until - Date.now())));
  }
}

main().catch(async (error: unknown) => {
  const message = (error as Error).message ?? String(error);
  console.error(`[fatal] ${message}`);
  if (!(error instanceof ConfigError)) await emitEvent({ source: STRATEGY_NAME, level: 'error', type: 'fatal', message });
  else await emitEvent({ source: STRATEGY_NAME, level: 'error', type: 'config.refused', message });
  process.exit(1);
});
