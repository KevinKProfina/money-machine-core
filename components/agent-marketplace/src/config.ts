import path from 'node:path';
import { stateDir } from './mm-contract.ts';

export type Config = {
  port: number;
  host: string;
  adminToken: string | undefined;
  platformFeePct: number;
  webhookAllowlist: string[];
  /** Allow webhook targets that resolve to private/loopback IPs (tests / local dev only). */
  webhookAllowPrivate: boolean;
  webhookTimeoutMs: number;
  anthropicApiKey: string | undefined;
  reportIntervalMs: number;
  maxBodyBytes: number;
  stateFile: string;
};

function num(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`invalid numeric env value "${value}" (expected ${min}..${max})`);
  }
  return n;
}

export function marketplaceStateFile(): string {
  return path.join(stateDir(), 'agent-marketplace', 'state.json');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: num(env.PORT, 8790, 0, 65535),
    host: env.HOST?.trim() || '127.0.0.1',
    adminToken: env.ADMIN_TOKEN?.trim() || undefined,
    platformFeePct: num(env.PLATFORM_FEE_PCT, 10, 0, 100),
    webhookAllowlist: (env.WEBHOOK_ALLOWLIST ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    webhookAllowPrivate: env.WEBHOOK_ALLOW_PRIVATE === '1',
    webhookTimeoutMs: num(env.WEBHOOK_TIMEOUT_MS, 10_000, 100, 120_000),
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    reportIntervalMs: num(env.REPORT_INTERVAL_MS, 60_000, 1_000, 86_400_000),
    maxBodyBytes: num(env.MAX_BODY_BYTES, 64 * 1024, 1024, 10 * 1024 * 1024),
    stateFile: marketplaceStateFile(),
  };
}
