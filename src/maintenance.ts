import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { statePaths } from '../contract/mm-contract.js';

/** Rotates `file` to file.1 … file.<keep> once it exceeds maxBytes. Best-effort. */
export function rotateIfLarge(file: string, maxBytes: number, keep = 3): void {
  try {
    if (fs.statSync(file).size <= maxBytes) return;
  } catch {
    return;
  }
  for (let i = keep - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {
      // gap in the series
    }
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch {
    // another process rotated it first
  }
}

/**
 * Keeps the shared events.jsonl bounded: when it grows past maxBytes, the newest
 * half is kept. Components append concurrently, so this rewrites via a temp file and
 * rename; a line appended in that instant can be lost, acceptable for an event log.
 */
export async function compactEventLog(maxBytes: number): Promise<boolean> {
  const file = statePaths.events();
  let content: string;
  try {
    if ((await fsp.stat(file)).size <= maxBytes) return false;
    content = await fsp.readFile(file, 'utf8');
  } catch {
    return false;
  }
  const keepFrom = content.indexOf('\n', content.length - Math.floor(maxBytes / 2));
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, keepFrom >= 0 ? content.slice(keepFrom + 1) : '', 'utf8');
  await fsp.rename(tmp, file);
  return true;
}

export type BackupOptions = { stateDir: string; backupDir: string; keep: number; now?: Date };

/** Directories inside the state dir that are caches and can be re-created; left out of backups. */
const BACKUP_EXCLUDES = ['arena/history', '*.tmp', '*.lock'];

/** Creates <backupDir>/mm-state-<timestamp>.tar.gz and prunes old archives beyond `keep`. */
export async function createBackup(options: BackupOptions): Promise<string> {
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  await fsp.mkdir(options.backupDir, { recursive: true });
  const archive = path.join(options.backupDir, `mm-state-${stamp}.tar.gz`);
  const args = ['-czf', archive, ...BACKUP_EXCLUDES.map((e) => `--exclude=${e}`), '-C', options.stateDir, '.'];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    // exit 1 = "file changed as we read it" (a component wrote mid-backup): archive is still usable
    child.on('close', (code) => (code === 0 || code === 1 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim()}`))));
  });
  await pruneBackups(options.backupDir, options.keep);
  return archive;
}

export async function listBackups(backupDir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(backupDir)).filter((f) => /^mm-state-.*\.tar\.gz$/.test(f)).sort();
  } catch {
    return [];
  }
}

async function pruneBackups(backupDir: string, keep: number): Promise<void> {
  const all = await listBackups(backupDir);
  for (const old of all.slice(0, Math.max(0, all.length - keep))) await fsp.rm(path.join(backupDir, old), { force: true });
}

/** Restores an archive into an EMPTY (or new) target directory; refuses to overwrite live state. */
export async function restoreBackup(archive: string, targetDir: string): Promise<void> {
  await fsp.mkdir(targetDir, { recursive: true });
  if ((await fsp.readdir(targetDir)).length > 0) {
    throw new Error(`target ${targetDir} is not empty — restore into a fresh directory and point MM_STATE_DIR at it`);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archive, '-C', targetDir], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
}
