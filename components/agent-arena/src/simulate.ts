import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readConfig } from './config.js';
import { leaderboardTable, summaryText } from './format.js';
import { ArenaRunner } from './runner.js';

/**
 * Fast offline evolution run in a temporary state dir (never touches the real
 * MM_STATE_DIR). Uses a virtual clock, so a given seed is fully reproducible.
 *   npm run simulate -- --cycles 500 --market synthetic --seed 1
 */
export async function simulate(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ text: string; stateDir: string }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cycles: { type: 'string', default: '500' },
      market: { type: 'string', default: 'synthetic' },
      seed: { type: 'string', default: '1' },
      quiet: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const cycles = Number(values.cycles);
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 1_000_000) throw new Error(`--cycles must be a positive integer`);
  if (values.market !== 'synthetic') throw new Error('simulate is offline-only: --market synthetic');

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-arena-sim-'));
  process.env.MM_STATE_DIR = stateDir;
  const cfg = readConfig({ ...env, MM_STATE_DIR: stateDir, ARENA_MARKET: 'synthetic', ARENA_SEED: values.seed, MODE: 'paper' });
  const base = Date.UTC(2026, 0, 1);
  let virtualCycle = 0;
  const now = () => new Date(base + virtualCycle * cfg.intervalMs);
  const runner = await ArenaRunner.open({ cfg, now, llm: null, log: () => undefined });

  const started = Date.now();
  for (let i = 0; i < cycles; i++) {
    virtualCycle = runner.state.cycle + 1;
    await runner.cycle({ paused: false });
    if (!values.quiet && (i + 1) % Math.max(1, Math.floor(cycles / 10)) === 0) {
      const s = runner.state;
      const eq = s.equityCurve.at(-1)?.equityUsd ?? 0;
      console.log(`  cycle ${s.cycle}: pop ${s.agents.length}, maxGen ${s.maxGeneration}, equity $${eq.toFixed(2)}, treasury $${s.treasuryUsd.toFixed(2)}`);
    }
  }
  const elapsed = Date.now() - started;
  const { summary } = await runner.persist();
  const text = [
    `simulated ${cycles} cycles (seed ${values.seed}) in ${elapsed} ms (${(elapsed / cycles).toFixed(2)} ms/cycle)`,
    summaryText(summary),
    '',
    leaderboardTable(summary.leaderboard),
    '',
    `state written to ${stateDir}`,
  ].join('\n');
  return { text, stateDir };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'simulate.ts'));
if (isMain) {
  simulate(process.argv.slice(2))
    .then(({ text }) => console.log(text))
    .catch((error: unknown) => {
      console.error(`[simulate] ${(error as Error).message}`);
      process.exit(1);
    });
}
