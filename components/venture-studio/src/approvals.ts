/**
 * Approval queue (the launch gate).
 *
 * - `studio/approvals.json` is written ONLY by the studio: requests plus the decisions
 *   it has consumed.
 * - Owners (core dashboard, `npm run approve|reject`) never write approvals.json; they
 *   append one JSON line per decision to `studio/decisions.jsonl` via appendDecision().
 * - Each studio cycle calls applyDecisions(): the first valid decision per ventureId that
 *   targets a pending request (and is not older than the request) is recorded; unknown
 *   ids, already-decided requests, stale and malformed lines are ignored. Re-running is
 *   idempotent.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from './mm-contract.js';
import { studioPaths } from './state.js';
import type { PolicyReport } from './types.js';

export type Decision = 'approved' | 'rejected';

export type ApprovalRequest = {
  ventureId: string;
  title: string;
  slug: string;
  price: number;
  currency: string;
  /** Local directory with landing.html + product.html (+ product.md) for review. */
  previewPath: string;
  policyReport: PolicyReport;
  requestedAt: string;
  decision?: Decision;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
};

export type ApprovalsFile = { schema: 'mm.studio-approvals/v1'; requests: ApprovalRequest[] };

export type DecisionLine = { ventureId: string; decision: Decision; decidedAt: string; decidedBy: string; note?: string };

const empty = (): ApprovalsFile => ({ schema: 'mm.studio-approvals/v1', requests: [] });

export async function readApprovals(file = studioPaths.approvals()): Promise<ApprovalsFile> {
  const data = await readJsonSafe<ApprovalsFile | null>(file, null);
  if (!data || data.schema !== 'mm.studio-approvals/v1' || !Array.isArray(data.requests)) return empty();
  return data;
}

export function pending(file: ApprovalsFile): ApprovalRequest[] {
  return file.requests.filter((r) => r.decision === undefined);
}

export async function pendingApprovals(file = studioPaths.approvals()): Promise<ApprovalRequest[]> {
  return pending(await readApprovals(file));
}

/** Studio-only: add a request for a venture that became `ready`. Idempotent per pending venture. */
export async function addRequest(req: Omit<ApprovalRequest, 'decision' | 'decidedAt' | 'decidedBy' | 'note'>, file = studioPaths.approvals()): Promise<boolean> {
  const data = await readApprovals(file);
  if (data.requests.some((r) => r.ventureId === req.ventureId && r.decision === undefined)) return false;
  data.requests.push({ ...req });
  await writeJsonAtomic(file, data);
  return true;
}

export function parseDecisionLine(line: string): DecisionLine | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.ventureId !== 'string' || !o.ventureId) return undefined;
  if (o.decision !== 'approved' && o.decision !== 'rejected') return undefined;
  if (typeof o.decidedAt !== 'string' || Number.isNaN(Date.parse(o.decidedAt))) return undefined;
  if (typeof o.decidedBy !== 'string' || !o.decidedBy) return undefined;
  if (o.note !== undefined && typeof o.note !== 'string') return undefined;
  const out: DecisionLine = { ventureId: o.ventureId, decision: o.decision, decidedAt: o.decidedAt, decidedBy: o.decidedBy };
  if (typeof o.note === 'string' && o.note.trim()) out.note = o.note.trim().slice(0, 2000);
  return out;
}

/** Append one owner decision (used by the CLI; the core dashboard writes the same line format). */
export async function appendDecision(
  d: { ventureId: string; decision: Decision; decidedBy: string; note?: string; decidedAt?: string },
  file = studioPaths.decisions(),
): Promise<DecisionLine> {
  const line: DecisionLine = { ventureId: d.ventureId, decision: d.decision, decidedAt: d.decidedAt ?? new Date().toISOString(), decidedBy: d.decidedBy };
  if (d.note?.trim()) line.note = d.note.trim();
  if (!parseDecisionLine(JSON.stringify(line))) throw new Error('invalid decision');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, JSON.stringify(line) + '\n', 'utf8');
  return line;
}

/**
 * Owner helper: only records a decision for a request that is currently pending.
 * Returns an error string instead of throwing for user-facing CLI messages.
 */
export async function decide(
  ventureId: string,
  decision: Decision,
  opts: { decidedBy: string; note?: string; approvalsFile?: string; decisionsFile?: string },
): Promise<{ ok: true; line: DecisionLine } | { ok: false; error: string }> {
  const data = await readApprovals(opts.approvalsFile);
  const req = data.requests.find((r) => r.ventureId === ventureId && r.decision === undefined);
  if (!req) {
    const decided = data.requests.find((r) => r.ventureId === ventureId);
    return { ok: false, error: decided ? `venture ${ventureId} is not pending (already ${decided.decision})` : `no approval request for venture ${ventureId}` };
  }
  const line = await appendDecision({ ventureId, decision, decidedBy: opts.decidedBy, note: opts.note }, opts.decisionsFile);
  return { ok: true, line };
}

export async function readDecisionLines(file = studioPaths.decisions()): Promise<DecisionLine[]> {
  let raw = '';
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: DecisionLine[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const d = parseDecisionLine(line);
    if (d) out.push(d);
  }
  return out;
}

/** Studio-only: consume decisions.jsonl into approvals.json. Returns newly applied decisions. */
export async function applyDecisions(opts: { approvalsFile?: string; decisionsFile?: string } = {}): Promise<ApprovalRequest[]> {
  const data = await readApprovals(opts.approvalsFile);
  const lines = await readDecisionLines(opts.decisionsFile);
  const applied: ApprovalRequest[] = [];
  for (const line of lines) {
    const req = data.requests.find((r) => r.ventureId === line.ventureId && r.decision === undefined);
    if (!req) continue; // unknown id or already decided
    if (Date.parse(line.decidedAt) < Date.parse(req.requestedAt)) continue; // stale line from before this request
    req.decision = line.decision;
    req.decidedAt = line.decidedAt;
    req.decidedBy = line.decidedBy;
    if (line.note) req.note = line.note;
    applied.push(req);
  }
  if (applied.length > 0) await writeJsonAtomic(opts.approvalsFile ?? studioPaths.approvals(), data);
  return applied;
}
