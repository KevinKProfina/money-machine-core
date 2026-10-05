import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJsonSafe, stateDir } from '../contract/mm-contract.js';

// Core-side view of components/venture-studio. The studio is the only writer of its
// summary and approvals; owner decisions are appended to decisions.jsonl, which the
// studio consumes on its next cycle.

export const studioDir = () => path.join(stateDir(), 'studio');
export const studioSummaryPath = () => path.join(studioDir(), 'summary.json');
export const studioDecisionsPath = () => path.join(studioDir(), 'decisions.jsonl');

export type StudioSummary = {
  schema: 'mm.studio-summary/v1';
  timestamp: string;
  channel?: string;
  deployed?: unknown;
  counts?: Record<string, number>;
  pendingApprovals?: { ventureId: string; title: string; price: number; requestedAt: string; previewPath?: string }[];
  live?: { title: string; slug: string; url?: string; price: number; sales: number; revenue: number; daysLive: number }[];
  parkedOpportunities?: { title: string; autonomyScore: number; humanSteps?: string[] }[];
  blockers?: string[];
};

export async function readStudioSummary(): Promise<StudioSummary | null> {
  const raw = await readJsonSafe<StudioSummary | null>(studioSummaryPath(), null);
  return raw?.schema === 'mm.studio-summary/v1' ? raw : null;
}

const VENTURE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export async function appendStudioDecision(input: {
  ventureId: string;
  decision: 'approved' | 'rejected';
  decidedBy: string;
  note?: string;
}): Promise<void> {
  if (!VENTURE_ID.test(input.ventureId)) throw new Error('invalid ventureId');
  if (input.decision !== 'approved' && input.decision !== 'rejected') throw new Error('invalid decision');
  const line = {
    ventureId: input.ventureId,
    decision: input.decision,
    decidedAt: new Date().toISOString(),
    decidedBy: input.decidedBy.slice(0, 80),
    ...(input.note ? { note: input.note.slice(0, 500) } : {}),
  };
  await fsp.mkdir(studioDir(), { recursive: true });
  await fsp.appendFile(studioDecisionsPath(), JSON.stringify(line) + '\n', 'utf8');
}

/**
 * Resolves a preview path to a file inside the studio directory, or undefined when it
 * points anywhere else (path traversal, symlink tricks via "..", absolute paths elsewhere).
 */
export function resolvePreviewFile(requested: string): string | undefined {
  const root = path.resolve(studioDir());
  const target = path.resolve(root, requested);
  if (target !== root && target.startsWith(root + path.sep)) return target;
  return undefined;
}
