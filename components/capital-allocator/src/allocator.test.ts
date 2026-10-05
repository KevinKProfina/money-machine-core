import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, boundedProportional, buildProposal, type Candidate } from './allocator.js';
import { makeConfig, makeReport } from './test/fixtures.js';

const sum = (r: Record<string, number>) => Object.values(r).reduce((s, v) => s + v, 0);
const opts = { minStrategyCapitalUsd: 10, maxStrategyShare: 0.5, explorationShare: 0 };

describe('allocate invariants', () => {
  it('is proportional to weight when no bound binds', () => {
    const c: Candidate[] = [
      { name: 'a', weight: 60, exploration: false },
      { name: 'b', weight: 40, exploration: false },
    ];
    const r = allocate(c, 1000, { ...opts, maxStrategyShare: 1 });
    assert.equal(r.allocations.a, 600);
    assert.equal(r.allocations.b, 400);
    assert.equal(r.unallocatedUsd, 0);
  });

  it('caps each strategy; leftover goes to unallocated; sum <= total', () => {
    const c: Candidate[] = [
      { name: 'a', weight: 90, exploration: false },
      { name: 'b', weight: 10, exploration: false },
    ];
    const r = allocate(c, 1000, { ...opts, maxStrategyShare: 0.4 });
    assert.equal(r.allocations.a, 400);
    assert.ok(r.allocations.b! <= 400);
    assert.ok(sum(r.allocations) <= 1000);
    assert.equal(r.unallocatedUsd + sum(r.allocations), 1000);
    // single strategy cannot take more than the cap
    const solo = allocate([{ name: 'x', weight: 50, exploration: false }], 1000, opts);
    assert.equal(solo.allocations.x, 500);
    assert.equal(solo.unallocatedUsd, 500);
  });

  it('respects the minimum without renormalising it away', () => {
    const c: Candidate[] = [
      { name: 'big', weight: 99, exploration: false },
      { name: 'tiny', weight: 1, exploration: false },
    ];
    const r = allocate(c, 1000, { ...opts, minStrategyCapitalUsd: 50, maxStrategyShare: 1 });
    assert.equal(r.allocations.tiny, 50);
    assert.equal(r.allocations.big, 950);
  });

  it('drops the weakest strategies when capital cannot cover every minimum', () => {
    const c: Candidate[] = [
      { name: 'a', weight: 70, exploration: false },
      { name: 'b', weight: 60, exploration: false },
      { name: 'c', weight: 50, exploration: false },
    ];
    const r = allocate(c, 100, { ...opts, minStrategyCapitalUsd: 40, maxStrategyShare: 1 });
    assert.equal(r.allocations.c, 0);
    assert.ok(r.allocations.a! >= 40 && r.allocations.b! >= 40);
    assert.ok(sum(r.allocations) <= 100);
  });

  it('randomised: sum <= total, each in {0} ∪ [min, cap]', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 300; t++) {
      const n = 1 + Math.floor(rnd() * 8);
      const total = Math.round(rnd() * 10000 * 100) / 100;
      const o = { minStrategyCapitalUsd: Math.round(rnd() * 200), maxStrategyShare: 0.05 + rnd() * 0.95, explorationShare: rnd() < 0.5 ? 0 : rnd() * 0.5 };
      const c: Candidate[] = Array.from({ length: n }, (_, i) => ({ name: `s${i}`, weight: 1 + rnd() * 99, exploration: rnd() < 0.3 }));
      const r = allocate(c, total, o);
      const cap = o.maxStrategyShare * total;
      assert.ok(sum(r.allocations) <= total + 1e-6, `sum ${sum(r.allocations)} > ${total}`);
      for (const v of Object.values(r.allocations)) {
        assert.ok(v >= 0 && v <= cap + 1e-6, `value ${v} cap ${cap}`);
      }
      for (const cand of c.filter((x) => !(o.explorationShare > 0 && x.exploration))) {
        const v = r.allocations[cand.name]!;
        assert.ok(v === 0 || v >= Math.min(o.minStrategyCapitalUsd, cap) - 0.01, `min violated ${v}`);
      }
    }
  });

  it('boundedProportional handles empty input and zero budget', () => {
    assert.deepEqual(boundedProportional([], 100, [], []), []);
    assert.deepEqual(boundedProportional([1, 2], 0, [0, 0], [10, 10]), [0, 0]);
  });

  it('per-candidate cap (maxShare) is respected', () => {
    const c: Candidate[] = [
      { name: 'a', weight: 50, exploration: false },
      { name: 'synth', weight: 90, exploration: false, maxShare: 0.1 },
    ];
    const r = allocate(c, 1000, { ...opts, maxStrategyShare: 1 });
    assert.equal(r.allocations.synth, 100);
    assert.equal(r.allocations.a, 900);
  });

  it('exploration budget funds low-data strategies separately', () => {
    const c: Candidate[] = [
      { name: 'proven', weight: 70, exploration: false },
      { name: 'new1', weight: 50, exploration: true },
      { name: 'new2', weight: 50, exploration: true },
    ];
    const r = allocate(c, 1000, { ...opts, explorationShare: 0.1 });
    assert.equal(r.allocations.new1, 50);
    assert.equal(r.allocations.new2, 50);
    assert.equal(r.allocations.proven, 500);
    assert.ok(sum(r.allocations) <= 1000);
  });
});

describe('buildProposal', () => {
  it('failed strategies get 0 and the proposal is schema-valid', () => {
    const reports = [
      makeReport({ name: 'ok' }),
      makeReport({ name: 'broken', status: 'failed', totalReturn: 0.5, sharpeRatio: 3 }),
    ];
    const { proposal } = buildProposal(reports, makeConfig(), new Date('2026-01-01T00:00:00Z'));
    assert.equal(proposal.schema, 'mm.allocation-proposal/v1');
    assert.equal(proposal.timestamp, '2026-01-01T00:00:00.000Z');
    assert.equal(proposal.allocations.broken, 0);
    assert.equal(proposal.scores.broken!.riskGateAllowed, false);
    assert.ok(proposal.allocations.ok! > 0);
    assert.ok(sum(proposal.allocations) <= proposal.totalCapitalUsd);
  });

  it('a 2-trade strategy with stellar stats cannot dominate a proven one', () => {
    const reports = [
      makeReport({ name: 'lucky', totalTrades: 2, totalReturn: 0.9, winRate: 1, sharpeRatio: 6, maxDrawdown: 0 }),
      makeReport({ name: 'proven', totalTrades: 150, totalReturn: 0.25, winRate: 0.65, sharpeRatio: 1.8, maxDrawdown: 0.07 }),
    ];
    const { proposal } = buildProposal(reports, makeConfig({ maxStrategyShare: 1 }));
    assert.ok(proposal.allocations.proven! > proposal.allocations.lucky!);
    assert.ok(proposal.scores.proven!.score > proposal.scores.lucky!.score);
  });

  it('risk profile changes the outcome', () => {
    const reports = [makeReport({ name: 'risky', maxDrawdown: 0.28, totalReturn: 0.4 })];
    const cons = buildProposal(reports, makeConfig({ riskProfile: 'conservative' })).proposal;
    const aggr = buildProposal(reports, makeConfig({ riskProfile: 'aggressive' })).proposal;
    assert.equal(cons.allocations.risky, 0);
    assert.ok(aggr.allocations.risky! > 0);
    assert.equal(aggr.riskProfile, 'aggressive');
  });

  it('synthetic-market-data strategies are discounted, capped and cannot out-compete real-data ones', () => {
    const stellar = { totalTrades: 200, totalReturn: 0.6, winRate: 0.9, sharpeRatio: 4, maxDrawdown: 0.02 };
    const reports = [
      makeReport({ name: 'synth', kind: 'liquidation', ...stellar, notes: ['synthetic-market-data (SimulatedSource)'] }),
      makeReport({ name: 'real', totalTrades: 100, totalReturn: 0.08, winRate: 0.55, sharpeRatio: 0.8, maxDrawdown: 0.1 }),
    ];
    const { proposal } = buildProposal(reports, makeConfig({ maxStrategyShare: 1 }));
    assert.ok(proposal.allocations.real! > proposal.allocations.synth!);
    assert.ok(proposal.scores.real!.score > proposal.scores.synth!.score);
    assert.ok(proposal.allocations.synth! <= 100); // default 10 % cap without exploration
    assert.ok(proposal.allocations.synth! > 0);
    assert.ok(proposal.scores.synth!.reasons.some((r) => r.includes('synthetic market data')));
    // with exploration enabled, the cap follows EXPLORATION_SHARE
    const p2 = buildProposal(reports, makeConfig({ maxStrategyShare: 1, explorationShare: 0.05 })).proposal;
    assert.ok(p2.allocations.synth! <= 50);
    // SYNTHETIC_DATA_WEIGHT=0 removes funding entirely
    const p3 = buildProposal(reports, makeConfig({ syntheticDataWeight: 0 })).proposal;
    assert.equal(p3.allocations.synth, 0);
  });

  it('empty reports -> empty proposal', () => {
    const { proposal, unallocatedUsd } = buildProposal([], makeConfig());
    assert.deepEqual(proposal.allocations, {});
    assert.deepEqual(proposal.scores, {});
    assert.equal(unallocatedUsd, 1000);
  });

  it('duplicate names: only the first is funded', () => {
    const { proposal } = buildProposal([makeReport({ name: 'x' }), makeReport({ name: 'x', totalReturn: 0.5 })], makeConfig());
    assert.equal(Object.keys(proposal.allocations).length, 1);
    assert.ok(proposal.allocations.x! <= 500);
  });
});
