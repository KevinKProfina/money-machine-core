import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildMutatorPrompt, costUsd, parseGenomeArray, runMutator, type LlmClient, type LlmResponse } from './mutator.js';
import { Rng } from './rng.js';
import { isWithinBounds } from './genome.js';
import { TRADER_GENOME, traderSpecies } from './species/trader.js';
import { FakeMarket, easyGenome, makeArena, tempStateDir, testConfig } from './testing/helpers.js';
import type { LlmState } from './state.js';

beforeEach(() => {
  tempStateDir();
});

const cfg = { genomes: 3, dailyBudgetUsd: 1, inputUsdPerMTok: 4, outputUsdPerMTok: 20, maxTokens: 2000 };
const freshLlm = (): LlmState => ({ totalUsd: 0, day: '', dayUsd: 0, calls: 0, refusals: 0, failures: 0, designedSpawned: 0, lastCallCycle: 0 });

function fakeClient(answer: string | (() => LlmResponse | Promise<LlmResponse>), usage = { input_tokens: 1000, output_tokens: 500 }) {
  const prompts: string[] = [];
  const client: LlmClient = {
    async create(prompt) {
      prompts.push(prompt);
      if (typeof answer === 'function') return answer();
      return { stop_reason: 'end_turn', content: [{ type: 'thinking' }, { type: 'text', text: answer }], usage };
    },
  };
  return { client, prompts };
}

const g = easyGenome();

test('parse: tolerates prose and code fences, clamps out-of-bound genes, rejects junk', () => {
  const text = 'Here you go:\n```json\n' + JSON.stringify([{ ...g, positionPct: 9, stopLossPct: -5 }, 'junk', { foo: 1 }, { ...g, rankBy: 1 }, { ...g }]) + '\n```';
  const res = parseGenomeArray(text, traderSpecies, 3, new Rng(1));
  assert.equal(res.genomes.length, 3);
  assert.equal(res.rejected, 2);
  assert.equal(res.genomes[0]!.positionPct, 0.5);
  assert.equal(res.genomes[0]!.stopLossPct, 1);
  assert.ok(res.clampedGenes >= 2);
  for (const genome of res.genomes) assert.ok(isWithinBounds(TRADER_GENOME, genome));
});

test('parse: unparseable answers yield nothing', () => {
  for (const t of ['', 'SKIP', '[not json', '{"a":1}', '[1,2,3]']) assert.equal(parseGenomeArray(t, traderSpecies, 5, new Rng(1)).genomes.length, 0, t);
});

test('prompt contains bounds and top/bottom stats', () => {
  const p = buildMutatorPrompt(traderSpecies, [{ genome: g, returnPct: 0.5, trades: 3, winRate: 1, ageCycles: 10, alive: true }], [], 4);
  assert.match(p, /positionPct: .*range \[0\.02, 0\.5\]/);
  assert.match(p, /JSON array of 4 objects/);
  assert.match(p, /"returnPct":50/);
});

test('runMutator: ok path charges usage-based cost', async () => {
  const { client, prompts } = fakeClient(JSON.stringify([g, g]));
  const llm = freshLlm();
  const out = await runMutator({ client, cfg, species: traderSpecies, top: [], bottom: [], rng: new Rng(1), llm, now: new Date('2026-03-01T10:00:00Z'), maxAffordableUsd: 100 });
  assert.equal(out.status, 'ok');
  assert.equal(out.genomes.length, 2);
  assert.equal(out.costUsd, costUsd(1000, 500, cfg));
  assert.ok(Math.abs(out.costUsd - 0.014) < 1e-12);
  assert.equal(prompts.length, 1);
  assert.equal(llm.day, '2026-03-01');
});

test('runMutator: refusal → skip (but the call is still charged)', async () => {
  const { client } = fakeClient(() => ({ stop_reason: 'refusal', content: [{ type: 'text', text: JSON.stringify([g]) }], usage: { input_tokens: 100, output_tokens: 0 } }));
  const out = await runMutator({ client, cfg, species: traderSpecies, top: [], bottom: [], rng: new Rng(1), llm: freshLlm(), now: new Date(), maxAffordableUsd: 100 });
  assert.equal(out.status, 'refused');
  assert.equal(out.genomes.length, 0);
  assert.ok(out.costUsd > 0);
});

test('runMutator: missing usage charges the worst-case estimate; errors never throw', async () => {
  const { client } = fakeClient(() => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify([g]) }] }));
  const out = await runMutator({ client, cfg, species: traderSpecies, top: [], bottom: [], rng: new Rng(1), llm: freshLlm(), now: new Date(), maxAffordableUsd: 100 });
  assert.equal(out.status, 'ok');
  assert.ok(out.costUsd >= (2000 * 20) / 1e6);
  const failing: LlmClient = { create: async () => Promise.reject(new Error('boom')) };
  const err = await runMutator({ client: failing, cfg, species: traderSpecies, top: [], bottom: [], rng: new Rng(1), llm: freshLlm(), now: new Date(), maxAffordableUsd: 100 });
  assert.equal(err.status, 'error');
});

test('runMutator: daily budget enforced before calling; resets on a new UTC day', async () => {
  const { client, prompts } = fakeClient(JSON.stringify([g]));
  const llm = { ...freshLlm(), day: '2026-03-01', dayUsd: 0.99 };
  const out = await runMutator({ client, cfg, species: traderSpecies, top: [], bottom: [], rng: new Rng(1), llm, now: new Date('2026-03-01T23:00:00Z'), maxAffordableUsd: 100 });
  assert.equal(out.status, 'budget');
  assert.equal(prompts.length, 0);
  const next = await runMutator({ client, cfg, species: traderSpecies, top: [], bottom: [], rng: new Rng(1), llm, now: new Date('2026-03-02T00:01:00Z'), maxAffordableUsd: 100 });
  assert.equal(next.status, 'ok');
  assert.equal(llm.dayUsd, 0, 'caller charges dayUsd');
  const poor = await runMutator({ client, cfg, species: traderSpecies, top: [], bottom: [], rng: new Rng(1), llm, now: new Date('2026-03-02T00:01:00Z'), maxAffordableUsd: 0.001 });
  assert.equal(poor.status, 'budget');
});

test('arena integration: designed genomes spawn as generation-0 agents, cost charged to treasury, event emitted, budget respected', async () => {
  const conf = testConfig({ ANTHROPIC_API_KEY: 'test-key', ARENA_LLM_EVERY: '2', ARENA_LLM_GENOMES: '3', ARENA_IMMIGRANTS_PER_CYCLE: '0', ARENA_MIN_POPULATION: '5', ARENA_LLM_DAILY_BUDGET_USD: '1' });
  const { client, prompts } = fakeClient(JSON.stringify([{ ...g, positionPct: 7 }, g, g, g]));
  const { arena, state, events } = makeArena(conf, new FakeMarket(), { llm: client });
  arena.genesis();
  await arena.runCycle({ paused: false });
  assert.equal(prompts.length, 0, 'only every ARENA_LLM_EVERY cycles');
  const treasuryBefore = state.treasuryUsd;
  await arena.runCycle({ paused: false });
  assert.equal(prompts.length, 1);
  const designed = state.agents.filter((a) => a.origin === 'designed');
  assert.equal(designed.length, 3);
  assert.ok(designed.every((a) => a.generation === 0 && a.parentId === null && isWithinBounds(TRADER_GENOME, a.genome)));
  assert.equal(designed[0]!.genome.positionPct, 0.5);
  const cost = costUsd(1000, 500, conf.llm);
  assert.ok(Math.abs(treasuryBefore - state.treasuryUsd - (cost + 3 * conf.seedUsd)) < 1e-9);
  assert.ok(Math.abs(state.ledger.llmUsd - cost) < 1e-12);
  assert.ok(events.some((e) => e.type === 'arena.llm-batch-spawned'));
  arena.checkInvariant();
  // shrink the daily budget to what was spent + a little: the next call's worst case no longer fits
  conf.llm.dailyBudgetUsd = state.llm.dayUsd + 0.001;
  await arena.runCycle({ paused: false });
  await arena.runCycle({ paused: false });
  assert.equal(prompts.length, 1);
  assert.match(state.llm.lastNote ?? '', /budget/);
});

test('arena: no LLM call without an API key or while paused', async () => {
  const { client, prompts } = fakeClient(JSON.stringify([g]));
  const noKey = testConfig({ ARENA_LLM_EVERY: '1' });
  const a1 = makeArena(noKey, new FakeMarket(), { llm: client });
  a1.arena.genesis();
  await a1.arena.runCycle({ paused: false });
  const withKey = testConfig({ ANTHROPIC_API_KEY: 'k', ARENA_LLM_EVERY: '1' });
  const a2 = makeArena(withKey, new FakeMarket(), { llm: client });
  a2.arena.genesis();
  await a2.arena.runCycle({ paused: true });
  assert.equal(prompts.length, 0);
});
