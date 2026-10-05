import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NEUTRAL_SCORE, scoreStrategy, shrinkToPrior } from './scoring.js';
import { ConfigError, parseRiskProfile, readConfig } from './config.js';
import { makeConfig, makeReport } from './test/fixtures.js';

describe('scoring', () => {
  it('ranks a better strategy above a worse one', () => {
    const cfg = makeConfig();
    const good = scoreStrategy(makeReport({ totalReturn: 0.3, winRate: 0.7, sharpeRatio: 2, maxDrawdown: 0.05 }), cfg);
    const bad = scoreStrategy(makeReport({ totalReturn: -0.05, winRate: 0.4, sharpeRatio: -0.3, maxDrawdown: 0.2 }), cfg);
    assert.ok(good.adjustedScore > bad.adjustedScore);
    assert.ok(good.rawScore <= 100 && bad.rawScore >= 0);
  });

  it('shrinks small samples toward the neutral prior', () => {
    const cfg = makeConfig();
    const stellar = { totalReturn: 0.8, winRate: 1, sharpeRatio: 5, maxDrawdown: 0 };
    const twoTrades = scoreStrategy(makeReport({ ...stellar, totalTrades: 2 }), cfg);
    const manyTrades = scoreStrategy(makeReport({ ...stellar, totalTrades: 200 }), cfg);
    assert.equal(twoTrades.rawScore, manyTrades.rawScore);
    assert.ok(twoTrades.adjustedScore < NEUTRAL_SCORE + 0.1 * (twoTrades.rawScore - NEUTRAL_SCORE) + 1e-9);
    assert.ok(manyTrades.adjustedScore > twoTrades.adjustedScore + 25);
    assert.equal(twoTrades.lowData, true);
    assert.equal(manyTrades.lowData, false);
  });

  it('shrinkToPrior: 0 trades = neutral, many trades -> raw', () => {
    assert.equal(shrinkToPrior(90, 0, 20).adjusted, NEUTRAL_SCORE);
    assert.ok(Math.abs(shrinkToPrior(90, 1e6, 20).adjusted - 90) < 0.01);
    assert.equal(shrinkToPrior(90, 0, 0).adjusted, 90);
  });

  it('risk gate rejects failed strategies', () => {
    const s = scoreStrategy(makeReport({ status: 'failed' }), makeConfig());
    assert.equal(s.riskGateAllowed, false);
    assert.ok(s.reasons.some((r) => r.includes('failed')));
  });

  it('risk gate rejects drawdown above the profile limit', () => {
    const r = makeReport({ maxDrawdown: 0.25 });
    assert.equal(scoreStrategy(r, makeConfig({ riskProfile: 'conservative' })).riskGateAllowed, false);
    assert.equal(scoreStrategy(r, makeConfig({ riskProfile: 'aggressive' })).riskGateAllowed, true);
  });

  it('risk gate rejects heavy losses and invalid metrics', () => {
    assert.equal(scoreStrategy(makeReport({ totalReturn: -0.3 }), makeConfig()).riskGateAllowed, false);
    assert.equal(scoreStrategy(makeReport({ winRate: Number.NaN }), makeConfig()).riskGateAllowed, false);
  });

  it('paused status is noted but not gated (orchestrator decides)', () => {
    const s = scoreStrategy(makeReport({ status: 'paused' }), makeConfig());
    assert.equal(s.riskGateAllowed, true);
  });

  it('low-data strategies skip the score gate only when exploration is enabled', () => {
    const r = makeReport({ totalTrades: 0 }); // adjusted = 50 < conservative min 52
    assert.equal(scoreStrategy(r, makeConfig({ riskProfile: 'conservative' })).riskGateAllowed, false);
    assert.equal(scoreStrategy(r, makeConfig({ riskProfile: 'conservative', explorationShare: 0.1 })).riskGateAllowed, true);
  });
});

describe('config', () => {
  it('validates RISK_PROFILE', () => {
    assert.equal(parseRiskProfile(undefined), 'moderate');
    assert.equal(parseRiskProfile('Aggressive'), 'aggressive');
    assert.throws(() => parseRiskProfile('yolo'), ConfigError);
    assert.throws(() => readConfig({ RISK_PROFILE: 'yolo' }), ConfigError);
  });

  it('reads env, applies profile default cap, rejects bad numbers', () => {
    const cfg = readConfig({ TOTAL_CAPITAL: '2500', RISK_PROFILE: 'conservative' });
    assert.equal(cfg.totalCapitalUsd, 2500);
    assert.equal(cfg.riskProfile, 'conservative');
    assert.equal(cfg.maxStrategyShare, 0.35);
    assert.equal(readConfig({ MAX_STRATEGY_SHARE: '0.4' }).maxStrategyShare, 0.4);
    assert.throws(() => readConfig({ TOTAL_CAPITAL: 'abc' }), ConfigError);
    assert.throws(() => readConfig({ MAX_STRATEGY_SHARE: '1.5' }), ConfigError);
    assert.throws(() => readConfig({ EXPLORATION_SHARE: '0.9' }), ConfigError);
    assert.equal(readConfig({}).syntheticDataWeight, 0.25);
    assert.throws(() => readConfig({ SYNTHETIC_DATA_WEIGHT: '2' }), ConfigError);
  });
});
