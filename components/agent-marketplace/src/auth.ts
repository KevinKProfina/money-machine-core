import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Agent } from './types.ts';

export const API_KEY_PREFIX = 'amk_';

export function generateApiKey(): string {
  return API_KEY_PREFIX + randomBytes(32).toString('base64url');
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Constant-time string compare (hashes both sides first so lengths always match). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1];
}

/**
 * Resolve an API key to an agent. Every stored hash is compared in constant time
 * (no early exit) so response timing does not reveal partial matches.
 */
export function findAgentByKey(agents: Iterable<Agent>, key: string | undefined): Agent | undefined {
  if (!key) return undefined;
  const hash = hashApiKey(key);
  let found: Agent | undefined;
  for (const agent of agents) {
    if (safeEqual(agent.apiKeyHash, hash) && !found) found = agent;
  }
  return found;
}

export function isAdmin(adminToken: string | undefined, presented: string | undefined): boolean {
  if (!adminToken || !presented) return false;
  return safeEqual(adminToken, presented);
}
