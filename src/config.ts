import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ComponentType = 'cycle' | 'daemon';

export type ComponentConfig = {
  name: string;
  /** Directory relative to MM_ROOT. */
  dir: string;
  type: ComponentType;
  /** Cycle components run in ascending phase order; same phase runs in parallel. */
  phase?: number;
  /** npm script to run. Defaults: cycle → "once", daemon → "start". */
  script?: string;
  enabled?: boolean;
};

export type SystemConfig = {
  coreDir: string;
  root: string;
  stateDir: string;
  logsDir: string;
  cycleIntervalMs: number;
  stepTimeoutMs: number;
  dashboardPort: number;
  dashboardHost: string;
  adminToken?: string;
  components: (ComponentConfig & { absDir: string; script: string })[];
};

export const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number (got "${raw}")`);
  return value;
}

export function loadSystemConfig(configPath = path.join(coreDir, 'system.config.json')): SystemConfig {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { components: ComponentConfig[] };
  const root = path.resolve(coreDir, process.env.MM_ROOT ?? '..');
  const stateDir = path.resolve(coreDir, process.env.MM_STATE_DIR ?? '.mm-state');
  // Child processes and the contract helpers resolve MM_STATE_DIR themselves, so pin it absolute.
  process.env.MM_STATE_DIR = stateDir;

  const names = new Set<string>();
  const components = raw.components
    .filter((c) => c.enabled !== false)
    .map((c) => {
      if (names.has(c.name)) throw new Error(`duplicate component name ${c.name}`);
      names.add(c.name);
      if (c.type !== 'cycle' && c.type !== 'daemon') throw new Error(`component ${c.name}: invalid type ${String(c.type)}`);
      return {
        ...c,
        absDir: path.resolve(root, c.dir),
        script: c.script ?? (c.type === 'cycle' ? 'once' : 'start'),
      };
    });

  return {
    coreDir,
    root,
    stateDir,
    logsDir: path.join(coreDir, 'logs'),
    cycleIntervalMs: positiveNumber('MM_CYCLE_INTERVAL_MS', 300_000),
    stepTimeoutMs: positiveNumber('MM_STEP_TIMEOUT_MS', 120_000),
    dashboardPort: positiveNumber('MM_DASHBOARD_PORT', 8780),
    dashboardHost: process.env.MM_DASHBOARD_HOST ?? '127.0.0.1',
    adminToken: process.env.MM_ADMIN_TOKEN || undefined,
    components,
  };
}

/** Groups cycle components by phase, ascending. */
export function cyclePhases(config: Pick<SystemConfig, 'components'>): SystemConfig['components'][] {
  const byPhase = new Map<number, SystemConfig['components']>();
  for (const c of config.components.filter((c) => c.type === 'cycle')) {
    const phase = c.phase ?? 0;
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), c]);
  }
  return [...byPhase.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list);
}
