import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateToken, rankCandidates, riskGates, scoreToken } from './strategy.js';
import { bestPairsByMint } from './market.js';
import { FIXTURE_NOW, MINTS, loadFixture, makeToken, testConfig } from './testing/fixtures.js';

const rules = testConfig().strategy;

test('healthy token passes gates with a solid score', () => {
  const evaluation = evaluateToken(makeToken(), rules);
  assert.equal(evaluation.allowed, true, evaluation.reasons.join(';'));
  assert.ok(evaluation.score >= rules.minScore);
});

test('rejects very low liquidity', () => {
  const failures = riskGates(makeToken({ liquidityUsd: 5_000 }), rules);
  assert.ok(failures.some((f) => f.startsWith('liquidity $5000')));
});

test('rejects tokens that are too new or have unknown age', () => {
  assert.ok(riskGates(makeToken({ ageHours: 3 }), rules).some((f) => f.startsWith('pair age')));
  assert.ok(riskGates(makeToken({ ageHours: Number.NaN }), rules).includes('unknown pair age'));
});

test('rejects sell pressure, thin volume, tiny/huge market cap and thin liquidity vs mcap', () => {
  assert.ok(riskGates(makeToken({ buys24h: 300, sells24h: 900 }), rules).some((f) => f.startsWith('buy/sell ratio')));
  assert.ok(riskGates(makeToken({ volume24hUsd: 10_000 }), rules).some((f) => f.startsWith('24h volume')));
  assert.ok(riskGates(makeToken({ marketCapUsd: 100_000 }), rules).some((f) => f.startsWith('market cap')));
  assert.ok(riskGates(makeToken({ marketCapUsd: 1e12 }), rules).some((f) => f.includes('>')));
  assert.ok(riskGates(makeToken({ marketCapUsd: 400_000_000 }), rules).some((f) => f.startsWith('liquidity/mcap')));
  assert.ok(riskGates(makeToken({ buys24h: 10, sells24h: 5 }), rules).some((f) => f.startsWith('24h txns')));
});

test('score is bounded and monotonic in liquidity and volume', () => {
  const base = scoreToken(makeToken());
  assert.ok(scoreToken(makeToken({ liquidityUsd: 1_500_000, volume24hUsd: 6_000_000 })) > base);
  assert.ok(scoreToken(makeToken({ liquidityUsd: 60_000 })) < base);
  const max = scoreToken(makeToken({ liquidityUsd: 1e9, volume24hUsd: 3e9, buys24h: 1000, sells24h: 1, ageHours: 1e5 }));
  assert.ok(max <= 100 && max >= 0);
});

test('low score is rejected even when gates pass', () => {
  const evaluation = evaluateToken(makeToken(), { ...rules, minScore: 99 });
  assert.equal(evaluation.allowed, false);
  assert.match(evaluation.reasons[0]!, /^score/);
});

test('fixture market: only GOOD1 and GOOD2 are allowed, ranked by score', () => {
  const pairs = loadFixture<{ pairs: never[] }>('dexscreener-tokens.json').pairs;
  const tokens = [...bestPairsByMint(pairs, FIXTURE_NOW.getTime()).values()];
  const ranked = rankCandidates(tokens, rules);
  const allowed = ranked.filter((r) => r.evaluation.allowed).map((r) => r.token.mint);
  assert.deepEqual(allowed, [MINTS.GOOD1, MINTS.GOOD2]);
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1]!.evaluation.score >= ranked[i]!.evaluation.score);
});
