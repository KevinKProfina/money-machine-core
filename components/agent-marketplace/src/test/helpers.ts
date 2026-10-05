import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../config.ts';
import { Marketplace, type MarketDeps } from '../marketplace.ts';
import { emptyState } from '../types.ts';

/** Point MM_STATE_DIR at a fresh temp dir for this test process and return it. */
export function useTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mkt-test-'));
  process.env.MM_STATE_DIR = dir;
  delete process.env.MM_KILL;
  return dir;
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({}), port: 0, ...overrides };
}

export function memMarket(overrides: Partial<Config> = {}, deps: Partial<MarketDeps> = {}): Marketplace {
  return new Marketplace(emptyState(), { config: testConfig(overrides), persist: false, log: () => {}, ...deps });
}

/** Platform agent with builtin services + a funded buyer. */
export function seededMarket(overrides: Partial<Config> = {}, deps: Partial<MarketDeps> = {}) {
  const m = memMarket(overrides, deps);
  const platform = m.registerAgent({ name: 'platform', platform: true });
  const buyer = m.registerAgent({ name: 'buyer' });
  m.deposit(buyer.agent.id, 10);
  return { m, platform, buyer };
}
