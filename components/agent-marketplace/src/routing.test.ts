import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyStats, recordOutcome, recordRating, reputationScore, successScore, ratingScore, LATENCY_ALPHA } from './reputation.ts';
import { latencyScore, pickBest, scoreServices } from './routing.ts';
import type { ReputationStats, Service } from './types.ts';

function svc(id: string, priceUsd: number): Service {
  return { id, agentId: `agt_${id}`, name: id, capability: 'cap', description: '', priceUsd, handler: 'builtin:echo', active: true, splits: [], createdAt: '' };
}

function stats(successes: number, failures: number, ratings: number[] = [], latency?: number): ReputationStats {
  let s = emptyStats();
  for (let i = 0; i < successes; i++) s = recordOutcome(s, true, latency ?? 100);
  for (let i = 0; i < failures; i++) s = recordOutcome(s, false, latency ?? 100);
  for (const r of ratings) s = recordRating(s, r);
  return s;
}

test('reputation: Bayesian prior pulls small samples toward the prior', () => {
  const fresh = emptyStats();
  assert.equal(successScore(fresh), 0.7);
  assert.equal(ratingScore(fresh), 3);
  const oneWin = stats(1, 0);
  const manyWins = stats(50, 0);
  assert.ok(successScore(oneWin) > successScore(fresh));
  assert.ok(successScore(manyWins) > successScore(oneWin));
  assert.ok(successScore(manyWins) < 1);
  assert.ok(successScore(stats(0, 3)) < successScore(fresh));
});

test('reputation: rating update and validation', () => {
  const s = recordRating(recordRating(emptyStats(), 5), 5);
  assert.equal(s.ratingCount, 2);
  assert.equal(s.ratingSum, 10);
  assert.ok(ratingScore(s) > 3 && ratingScore(s) < 5);
  assert.ok(reputationScore(s) > reputationScore(emptyStats()));
  assert.throws(() => recordRating(emptyStats(), 0));
  assert.throws(() => recordRating(emptyStats(), 6));
  assert.throws(() => recordRating(emptyStats(), 4.5));
});

test('reputation: latency EMA', () => {
  let s = recordOutcome(emptyStats(), true, 1000);
  assert.equal(s.latencyEmaMs, 1000);
  s = recordOutcome(s, true, 0);
  assert.equal(s.latencyEmaMs, (1 - LATENCY_ALPHA) * 1000);
  assert.equal(latencyScore(0), 1);
  assert.equal(latencyScore(1000), 0.5);
  assert.equal(latencyScore(undefined), 0.5);
});

test('routing: equal reputation → cheaper wins', () => {
  const best = pickBest([{ service: svc('a', 1) }, { service: svc('b', 0.5) }]);
  assert.equal(best?.service.id, 'b');
});

test('routing: strong reputation beats a slightly lower price', () => {
  const ranked = scoreServices([
    { service: svc('cheap-bad', 0.9), serviceStats: stats(2, 20, [1, 1, 2], 4000) },
    { service: svc('good', 1), serviceStats: stats(40, 0, [5, 5, 5, 5], 200) },
  ]);
  assert.equal(ranked[0]?.service.id, 'good');
  assert.ok(ranked[0]!.score > ranked[1]!.score);
  for (const r of ranked) assert.ok(r.score > 0 && r.score <= 1);
});

test('routing: maxPrice filter and deterministic tie-break', () => {
  assert.equal(pickBest([{ service: svc('a', 2) }, { service: svc('b', 3) }], 1), undefined);
  assert.equal(pickBest([{ service: svc('z', 1) }, { service: svc('y', 1) }])?.service.id, 'y');
  assert.deepEqual(scoreServices([]), []);
});
