import path from 'node:path';
import type http from 'node:http';
import { makeAskClaude } from './claude.ts';
import type { Config } from './config.ts';
import { createServer } from './http.ts';
import { checkInvariants } from './ledger.ts';
import { Marketplace, type MarketDeps, type MarketplaceReportFile } from './marketplace.ts';
import { emitEvent } from './mm-contract.ts';
import { loadState, ProcessLock } from './store.ts';

export function lockFor(config: Config): ProcessLock {
  return new ProcessLock(path.join(path.dirname(config.stateFile), 'marketplace.lock'));
}

export async function openMarketplace(config: Config, deps: Partial<MarketDeps> = {}): Promise<Marketplace> {
  const state = await loadState(config.stateFile);
  const problems = checkInvariants(state);
  if (problems.length) throw new Error(`ledger invariants violated in ${config.stateFile}: ${problems.join('; ')}`);
  const market = new Marketplace(state, { askClaude: makeAskClaude(config.anthropicApiKey), ...deps, config });
  const recovered = market.recoverInterrupted();
  if (recovered) console.warn(`[agent-marketplace] refunded ${recovered} job(s) interrupted by a previous shutdown`);
  return market;
}

/**
 * One cycle: load state, process queued jobs, write state + marketplace.json, exit.
 * If a daemon currently owns the state (lock held by a live process), nothing is touched.
 */
export async function runOnce(config: Config, deps: Partial<MarketDeps> = {}): Promise<MarketplaceReportFile | undefined> {
  const lock = lockFor(config);
  const got = lock.acquire();
  if (!got.ok) {
    console.log(`[agent-marketplace] daemon (pid ${got.holderPid}) owns the state and writes marketplace.json itself; --once skipped`);
    return undefined;
  }
  try {
    const market = await openMarketplace(config, deps);
    const processed = await market.processQueue();
    await market.flush();
    const report = market.report();
    console.log(
      `[agent-marketplace] once: processed ${processed} queued job(s); agents=${report.agents} services=${report.services} ` +
        `completed=${report.jobsCompleted} failed=${report.jobsFailed} platformRevenueUsd=${report.platformRevenueUsd} (internal credits)`,
    );
    return report;
  } finally {
    lock.release();
  }
}

export type Daemon = { server: http.Server; market: Marketplace; stop: () => Promise<void> };

export async function startDaemon(config: Config, deps: Partial<MarketDeps> = {}): Promise<Daemon> {
  const lock = lockFor(config);
  const got = lock.acquire();
  if (!got.ok) throw new Error(`another marketplace process (pid ${got.holderPid}) holds ${lock.file}`);
  try {
    const market = await openMarketplace(config, deps);
    const server = createServer(market, { maxBodyBytes: config.maxBodyBytes, adminToken: config.adminToken });
    server.requestTimeout = 60_000;
    server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => resolve());
    });
    void market.processQueue().catch((err: unknown) => console.error(`[agent-marketplace] queue error: ${(err as Error).message}`));
    await market.flush();
    const timer = setInterval(() => {
      void market.processQueue().catch((err: unknown) => console.error(`[agent-marketplace] queue error: ${(err as Error).message}`));
      void market.persistReport();
    }, config.reportIntervalMs);
    timer.unref();

    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await market.flush();
      lock.release();
    };
    if (!config.adminToken) console.warn('[agent-marketplace] ADMIN_TOKEN not set: POST /deposits is disabled');
    void emitEvent({ source: 'agent-marketplace', level: 'info', type: 'daemon.started', message: `listening on ${config.host}:${addressPort(server)}` });
    return { server, market, stop };
  } catch (err) {
    lock.release();
    throw err;
  }
}

export function addressPort(server: http.Server): number {
  const a = server.address();
  return typeof a === 'object' && a ? a.port : 0;
}
