import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { emptyLedger, type LlmLedger } from './llm.js';
import { readJsonSafe, stateDir, writeJsonAtomic } from './mm-contract.js';
import type { Venture } from './types.js';

export const studioPaths = {
  dir: () => path.join(stateDir(), 'studio'),
  ventures: () => path.join(stateDir(), 'studio', 'ventures.json'),
  ventureDir: (id: string) => path.join(stateDir(), 'studio', 'ventures', id),
  approvals: () => path.join(stateDir(), 'studio', 'approvals.json'),
  decisions: () => path.join(stateDir(), 'studio', 'decisions.jsonl'),
  summary: () => path.join(stateDir(), 'studio', 'summary.json'),
  site: () => path.join(stateDir(), 'studio', 'site'),
  deployLog: () => path.join(stateDir(), 'studio', 'deploy.log'),
  lock: () => path.join(stateDir(), 'studio', '.lock'),
};

export type DeployResult = { ok: boolean; at: string; code: number | null; timedOut: boolean; durationMs: number; outputTail: string; skipped?: string };

export type StudioState = {
  schema: 'mm.studio-state/v1';
  createdAt: string;
  updatedAt: string;
  cycle: number;
  nextId: number;
  ventures: Venture[];
  ideation: { day: string; count: number; seedCursor: number; lastNote?: string };
  llm: LlmLedger;
  site: {
    dirty: boolean;
    lastWrittenAt?: string;
    lastDeploy?: DeployResult;
    /** Beacon embedded in the written site ('' = none) and since when (traffic is only counted from then on). */
    beacon?: { signature: string; since?: string };
  };
};

export function emptyState(now: Date): StudioState {
  return {
    schema: 'mm.studio-state/v1',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    cycle: 0,
    nextId: 1,
    ventures: [],
    ideation: { day: '', count: 0, seedCursor: 0 },
    llm: emptyLedger(),
    site: { dirty: false },
  };
}

export async function loadState(now: Date): Promise<StudioState> {
  const s = await readJsonSafe<StudioState | null>(studioPaths.ventures(), null);
  if (!s || s.schema !== 'mm.studio-state/v1' || !Array.isArray(s.ventures)) return emptyState(now);
  return s;
}

export async function saveState(s: StudioState): Promise<void> {
  await writeJsonAtomic(studioPaths.ventures(), s);
}

/** Single-writer lock so a loop and a supervisor `--once` never run a cycle concurrently. */
export async function acquireLock(): Promise<(() => Promise<void>) | undefined> {
  const file = studioPaths.lock();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return async () => {
        await fsp.rm(file, { force: true });
      };
    } catch {
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      let alive = false;
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (alive) return undefined;
      await fsp.rm(file, { force: true }); // stale lock
    }
  }
  return undefined;
}
