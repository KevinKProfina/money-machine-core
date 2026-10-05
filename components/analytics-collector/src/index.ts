import fsp from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { COMPONENT_NAME, ConfigError, readConfig, type CollectorConfig } from './config.js';
import { emitEvent, writeJsonAtomic } from './mm-contract.js';
import { createCollector, type Collector } from './server.js';
import { analyticsPaths, compact, type Heartbeat } from './store.js';

/** `--once`: retention/compaction of the daily files, then exit (no server, nothing in memory to flush). */
export async function runOnce(cfg: CollectorConfig, now: Date = new Date()): Promise<{ removed: string[]; kept: number }> {
  await fsp.mkdir(analyticsPaths.root(), { recursive: true });
  const res = await compact(cfg.retentionDays, now);
  console.log(`[analytics] once: ${res.kept} day file(s) kept, ${res.removed.length} removed (retention ${cfg.retentionDays} days) in ${analyticsPaths.root()}`);
  return res;
}

export type RunningCollector = Collector & { port: number; stop: () => Promise<void> };

/** Starts the HTTP server with periodic flushes; `stop()` closes it and flushes once more. */
export async function startCollector(cfg: CollectorConfig, opts: { now?: () => Date; log?: (m: string) => void } = {}): Promise<RunningCollector> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const now = opts.now ?? (() => new Date());
  await fsp.mkdir(analyticsPaths.root(), { recursive: true });
  const c = createCollector(cfg, { now, log });
  await compact(cfg.retentionDays, now());
  let lastCompactDay = now().toISOString().slice(0, 10);
  const startedAt = now().toISOString();
  // heartbeat: tells venture-studio that a LIVE collector shares this state dir (`--once` writes none)
  const heartbeat = () =>
    writeJsonAtomic(analyticsPaths.heartbeat(), { schema: 'mm.analytics-collector/v1', updatedAt: now().toISOString(), startedAt, retentionDays: cfg.retentionDays, flushIntervalMs: cfg.flushIntervalMs } satisfies Heartbeat);
  await heartbeat();
  const flush = async () => {
    try {
      await c.store.flush();
      await heartbeat();
      const day = now().toISOString().slice(0, 10);
      if (day !== lastCompactDay) {
        lastCompactDay = day;
        await compact(cfg.retentionDays, now());
      }
    } catch (error) {
      log(`[analytics] flush failed: ${(error as Error).message}`);
    }
  };
  const timer = setInterval(() => void flush(), cfg.flushIntervalMs);
  timer.unref();
  await new Promise<void>((resolve, reject) => {
    c.server.once('error', reject);
    c.server.listen(cfg.port, cfg.host, () => resolve());
  });
  const addr = c.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port;
  let stopped = false;
  return {
    ...c,
    port,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await new Promise<void>((resolve) => {
        c.server.close(() => resolve());
        c.server.closeAllConnections();
      });
      await c.store.flush();
      await heartbeat();
    },
  };
}

async function main(argv: string[]): Promise<void> {
  const cfg = readConfig();
  for (const n of cfg.notes) console.warn(`[init] ${n}`);
  if (argv.includes('--once')) {
    await runOnce(cfg);
    return;
  }
  const c = await startCollector(cfg);
  console.log(`[analytics] listening on http://${cfg.host}:${c.port} (origins: ${cfg.allowedOrigins.join(', ') || 'none'}; flush every ${cfg.flushIntervalMs} ms; data in ${analyticsPaths.root()})`);
  await emitEvent({ source: COMPONENT_NAME, level: 'info', type: 'analytics.started', message: `collector listening on ${cfg.host}:${c.port}` });
  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[analytics] ${sig}: flushing and shutting down`);
    await c.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'index.ts'));
if (isMain) {
  dotenv.config({ quiet: true });
  main(process.argv.slice(2)).catch(async (error: unknown) => {
    const message = (error as Error).message ?? String(error);
    console.error(`[fatal] ${message}`);
    await emitEvent({ source: COMPONENT_NAME, level: 'error', type: error instanceof ConfigError ? 'config.refused' : 'fatal', message });
    process.exit(1);
  });
}
