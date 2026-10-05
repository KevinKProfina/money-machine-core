import { pathToFileURL } from 'node:url';
import { lockFor, openMarketplace } from './app.ts';
import { loadConfig, type Config } from './config.ts';
import type { Marketplace } from './marketplace.ts';

/** Builtin services the platform agent offers. Prices are in internal USD credits. */
export const PLATFORM_SERVICES = [
  {
    name: 'Money Machine status',
    capability: 'mm-status',
    description: 'Compact status of the Money Machine (portfolio, strategies incl. paper/live mode, revenue, kill switch) read from $MM_STATE_DIR.',
    priceUsd: 0.05,
    handler: 'builtin:mm-status',
  },
  {
    name: 'Text summarizer',
    capability: 'summarize',
    description: 'One-line summary via Claude when configured; otherwise a deterministic extractive summary (mode: "fallback"). Input: { "text": string }.',
    priceUsd: 0.02,
    handler: 'builtin:summarize',
  },
  {
    name: 'Echo',
    capability: 'echo',
    description: 'Returns the input unchanged. Free; for integration testing.',
    priceUsd: 0,
    handler: 'builtin:echo',
  },
] as const;

/** Idempotent: creates the platform agent once and any missing builtin services. */
export function seedMarketplace(market: Marketplace): { agentId: string; apiKey?: string; created: string[] } {
  let platform = Object.values(market.state.agents).find((a) => a.platform);
  let apiKey: string | undefined;
  if (!platform) {
    const r = market.registerAgent({ name: 'Money Machine platform', platform: true });
    platform = r.agent;
    apiKey = r.apiKey;
  }
  const created: string[] = [];
  for (const def of PLATFORM_SERVICES) {
    const exists = Object.values(market.state.services).some((s) => s.agentId === platform.id && s.handler === def.handler);
    if (!exists) created.push(market.createService(platform.id, { ...def }).service.id);
  }
  return { agentId: platform.id, ...(apiKey ? { apiKey } : {}), created };
}

export async function runSeed(config: Config) {
  const lock = lockFor(config);
  const got = lock.acquire();
  if (!got.ok) throw new Error(`marketplace daemon (pid ${got.holderPid}) is running; stop it before seeding`);
  try {
    const market = await openMarketplace(config);
    const result = seedMarketplace(market);
    await market.flush();
    return result;
  } finally {
    lock.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSeed(loadConfig()).then(
    (r) => {
      console.log(`[agent-marketplace] platform agent: ${r.agentId}`);
      if (r.apiKey) console.log(`[agent-marketplace] platform API key (shown once, store it securely): ${r.apiKey}`);
      console.log(`[agent-marketplace] services created: ${r.created.length ? r.created.join(', ') : 'none (already seeded)'}`);
    },
    (err: unknown) => {
      console.error(`[agent-marketplace] seed failed: ${(err as Error).message}`);
      process.exit(1);
    },
  );
}
