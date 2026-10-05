import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { costUsd, emptyLedger, extractJson, Llm, worstCaseCostUsd, type LlmClient, type LlmRequest } from './llm.js';

const pricing = { dailyBudgetUsd: 1, inputUsdPerMTok: 4, outputUsdPerMTok: 20 };
const req: LlmRequest = { task: 'critic', system: 'sys', prompt: 'x'.repeat(1000), maxTokens: 2000, effort: 'medium' };

function client(answer: { text?: string; stop?: string; inTok?: number; outTok?: number; throws?: boolean } = {}): LlmClient & { n: number } {
  const c = {
    n: 0,
    async create() {
      c.n++;
      if (answer.throws) throw new Error('boom');
      return { stop_reason: answer.stop ?? 'end_turn', text: answer.text ?? '{"a":1}', usage: { input_tokens: answer.inTok ?? 1000, output_tokens: answer.outTok ?? 500 } };
    },
  };
  return c;
}

test('cost from usage × $/MTok; worst case uses full max_tokens', () => {
  assert.equal(costUsd(1_000_000, 0, pricing), 4);
  assert.equal(costUsd(0, 1_000_000, pricing), 20);
  const w = worstCaseCostUsd(req, pricing);
  assert.ok(w >= costUsd(0, 2000, pricing));
});

test('budget cap is checked with the worst case BEFORE the call', async () => {
  const c = client();
  const ledger = emptyLedger();
  const now = () => new Date('2026-01-01T10:00:00Z');
  const llm = new Llm(c, pricing, ledger, now);
  ledger.day = '2026-01-01';
  ledger.dayUsd = 0.98; // worst case of the request (~0.04) would exceed $1
  const r = await llm.call(req);
  assert.equal(r.status, 'budget');
  assert.equal(c.n, 0);
  assert.equal(ledger.budgetSkips, 1);
  // next day the budget resets
  const llm2 = new Llm(c, pricing, ledger, () => new Date('2026-01-02T00:00:01Z'));
  const r2 = await llm2.call(req);
  assert.equal(r2.status, 'ok');
  assert.equal(c.n, 1);
  assert.equal(ledger.day, '2026-01-02');
  assert.ok(Math.abs(ledger.dayUsd - costUsd(1000, 500, pricing)) < 1e-12);
});

test('spend never exceeds the daily cap over many calls', async () => {
  const c = client({ inTok: 20_000, outTok: 2000 });
  const ledger = emptyLedger();
  const llm = new Llm(c, pricing, ledger, () => new Date('2026-01-01T00:00:00Z'));
  for (let i = 0; i < 100; i++) await llm.call(req);
  assert.ok(ledger.dayUsd <= pricing.dailyBudgetUsd);
  assert.ok(c.n > 0 && c.n < 100);
});

test('refusal → refused (cost booked, no content); errors book the worst case', async () => {
  const ledger = emptyLedger();
  const llm = new Llm(client({ stop: 'refusal', text: 'should be ignored' }), pricing, ledger, () => new Date());
  const r = await llm.callJson(req, z.object({ a: z.number() }));
  assert.equal(r.status, 'refused');
  assert.equal(ledger.refusals, 1);
  const llmErr = new Llm(client({ throws: true }), pricing, ledger, () => new Date());
  const before = ledger.totalUsd;
  const e = await llmErr.call(req);
  assert.equal(e.status, 'error');
  assert.ok(ledger.totalUsd - before >= worstCaseCostUsd(req, pricing) - 1e-12);
  const disabled = new Llm(undefined, pricing, emptyLedger(), () => new Date());
  assert.equal((await disabled.call(req)).status, 'disabled');
});

test('callJson validates with zod after defensive extraction', async () => {
  const schema = z.object({ a: z.number() });
  const ok = await new Llm(client({ text: 'Sure!\n```json\n{"a": 2}\n```' }), pricing, emptyLedger(), () => new Date()).callJson(req, schema);
  assert.deepEqual(ok.status === 'ok' && ok.data, { a: 2 });
  const bad = await new Llm(client({ text: '{"a":"x"}' }), pricing, emptyLedger(), () => new Date()).callJson(req, schema);
  assert.equal(bad.status, 'invalid');
  assert.deepEqual(extractJson('noise [1,2] tail'), [1, 2]);
  assert.equal(extractJson('nothing'), undefined);
});
