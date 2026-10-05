import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './mm-contract.ts';
import { emptyState, type MarketState } from './types.ts';

/**
 * Loads the marketplace state. A missing file yields an empty state; a file that exists
 * but cannot be parsed is a fatal error (we must never silently overwrite a ledger).
 */
export async function loadState(file: string): Promise<MarketState> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw err;
  }
  const parsed = JSON.parse(raw) as MarketState;
  if (parsed?.schema !== 'agent-marketplace.state/v1') throw new Error(`unexpected state schema in ${file}`);
  return { ...emptyState(), ...parsed, reputation: { ...emptyState().reputation, ...parsed.reputation } };
}

/** Serialized write queue: writes run strictly one after another (atomic tmp+rename each). */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(file: string, value: () => unknown): Promise<void> {
    const run = this.tail.then(() => writeJsonAtomic(file, value()));
    this.tail = run.catch((err: unknown) => {
      console.error(`[agent-marketplace] write failed for ${file}: ${(err as Error).message}`);
    });
    return run;
  }

  /** Resolves once every queued write has finished (errors are logged, not thrown). */
  idle(): Promise<void> {
    return this.tail;
  }
}

/** Single-writer process lock (pid file). Stale locks from dead processes are taken over. */
export class ProcessLock {
  constructor(readonly file: string) {}

  acquire(): { ok: true } | { ok: false; holderPid: number } {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(this.file, String(process.pid), { flag: 'wx' });
        return { ok: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const pid = Number(fs.readFileSync(this.file, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isAlive(pid)) return { ok: false, holderPid: pid };
        fs.rmSync(this.file, { force: true }); // stale
      }
    }
    return { ok: false, holderPid: -1 };
  }

  release(): void {
    try {
      if (Number(fs.readFileSync(this.file, 'utf8').trim()) === process.pid) fs.rmSync(this.file, { force: true });
    } catch {
      // already gone
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
