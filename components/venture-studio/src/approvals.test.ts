import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { addRequest, appendDecision, applyDecisions, decide, parseDecisionLine, pendingApprovals, readApprovals } from './approvals.js';
import { studioPaths } from './state.js';
import { tempStateDir } from './testing/helpers.js';
import type { PolicyReport } from './types.js';

beforeEach(() => {
  tempStateDir();
});

const report: PolicyReport = { pass: true, checkedAt: '2026-01-01T00:00:00.000Z', claudeReviewed: false, findings: [], notes: [] };
const req = (ventureId: string, requestedAt = '2026-01-01T00:00:00.000Z') => ({ ventureId, title: `T ${ventureId}`, slug: ventureId, price: 9, currency: 'eur', previewPath: '/tmp/x', policyReport: report, requestedAt });

test('addRequest is idempotent per pending venture; pending lists undecided requests', async () => {
  assert.equal(await addRequest(req('v1')), true);
  assert.equal(await addRequest(req('v1')), false);
  await addRequest(req('v2'));
  const data = await readApprovals();
  assert.equal(data.schema, 'mm.studio-approvals/v1');
  assert.equal(data.requests.length, 2);
  assert.deepEqual((await pendingApprovals()).map((r) => r.ventureId), ['v1', 'v2']);
});

test('applyDecisions: first decision per pending venture wins; duplicates are idempotent', async () => {
  await addRequest(req('v1'));
  await appendDecision({ ventureId: 'v1', decision: 'approved', decidedBy: 'dashboard:owner', decidedAt: '2026-01-02T00:00:00.000Z' });
  await appendDecision({ ventureId: 'v1', decision: 'rejected', decidedBy: 'dashboard:owner', decidedAt: '2026-01-02T00:01:00.000Z', note: 'changed mind' });
  await appendDecision({ ventureId: 'v1', decision: 'approved', decidedBy: 'dashboard:owner', decidedAt: '2026-01-02T00:00:00.000Z' });
  const applied = await applyDecisions();
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.decision, 'approved');
  assert.equal(applied[0]!.decidedBy, 'dashboard:owner');
  // second run: nothing new, file unchanged
  const before = await fsp.readFile(studioPaths.approvals(), 'utf8');
  assert.equal((await applyDecisions()).length, 0);
  assert.equal(await fsp.readFile(studioPaths.approvals(), 'utf8'), before);
  assert.equal((await pendingApprovals()).length, 0);
});

test('applyDecisions ignores unknown ids, non-pending requests, stale and malformed lines', async () => {
  await addRequest(req('v1', '2026-01-05T00:00:00.000Z'));
  await fsp.appendFile(
    studioPaths.decisions(),
    [
      '{not json',
      JSON.stringify({ ventureId: 'v1', decision: 'maybe', decidedAt: '2026-01-06T00:00:00.000Z', decidedBy: 'x' }),
      JSON.stringify({ ventureId: 'v1', decision: 'approved', decidedAt: 'yesterday', decidedBy: 'x' }),
      JSON.stringify({ ventureId: 'v1', decision: 'approved', decidedAt: '2026-01-06T00:00:00.000Z' }), // no decidedBy
      JSON.stringify({ ventureId: 'v1', decision: 'approved', decidedAt: '2026-01-01T00:00:00.000Z', decidedBy: 'x' }), // before request → stale
      JSON.stringify({ ventureId: 'ghost', decision: 'approved', decidedAt: '2026-01-06T00:00:00.000Z', decidedBy: 'x' }),
      '',
    ].join('\n'),
  );
  assert.equal((await applyDecisions()).length, 0);
  assert.equal((await pendingApprovals()).length, 1);
  assert.equal((await readApprovals()).requests.some((r) => r.ventureId === 'ghost'), false);

  await appendDecision({ ventureId: 'v1', decision: 'rejected', decidedBy: 'cli:me', note: 'too generic', decidedAt: '2026-01-06T00:00:00.000Z' });
  const applied = await applyDecisions();
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.note, 'too generic');
  // a later approve for the now-decided venture is ignored
  await appendDecision({ ventureId: 'v1', decision: 'approved', decidedBy: 'cli:me', decidedAt: '2026-01-07T00:00:00.000Z' });
  assert.equal((await applyDecisions()).length, 0);
  assert.equal((await readApprovals()).requests[0]!.decision, 'rejected');
});

test('decide only appends for pending requests and never writes approvals.json', async () => {
  const missing = await decide('nope', 'approved', { decidedBy: 'cli:me' });
  assert.equal(missing.ok, false);
  await addRequest(req('v1'));
  const before = await fsp.readFile(studioPaths.approvals(), 'utf8');
  const ok = await decide('v1', 'approved', { decidedBy: 'cli:me' });
  assert.equal(ok.ok, true);
  assert.equal(await fsp.readFile(studioPaths.approvals(), 'utf8'), before);
  const lines = (await fsp.readFile(studioPaths.decisions(), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = parseDecisionLine(lines[0]!);
  assert.equal(parsed?.ventureId, 'v1');
  assert.equal(parsed?.decision, 'approved');
  await applyDecisions();
  const again = await decide('v1', 'rejected', { decidedBy: 'cli:me' });
  assert.equal(again.ok, false);
  if (!again.ok) assert.match(again.error, /not pending/);
});
