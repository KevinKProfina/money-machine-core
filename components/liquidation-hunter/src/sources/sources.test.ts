import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertRunnable, ConfigError, loadConfig } from '../config.js';
import { healthFactor } from '../math.js';
import { createSource } from './index.js';
import { AaveV3Source, KaminoSource, MarginFiSource, SaveSource } from './real-stubs.js';
import { SimulatedSource } from './simulated.js';
import { NotImplementedError } from './types.js';

const now = new Date('2026-01-01T00:00:00Z');

test('SimulatedSource is deterministic for (seed, cycle)', () => {
  const a = new SimulatedSource(7, 20).generate(3, now);
  const b = new SimulatedSource(7, 20).generate(3, now);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, new SimulatedSource(8, 20).generate(3, now));
  assert.notDeepEqual(a, new SimulatedSource(7, 20).generate(4, now));
});

test('SimulatedSource positions are labelled and have sane parameters', () => {
  const ps = new SimulatedSource(1, 200).generate(1, now);
  assert.equal(ps.length, 200);
  let liquidatable = 0;
  for (const p of ps) {
    assert.equal(p.simulated, true);
    assert.ok(p.debtUsd > 0 && p.collateralUsd > 0);
    assert.ok(p.liquidationThreshold > 0.5 && p.liquidationThreshold < 1);
    assert.ok(p.liquidationBonus > 0 && p.liquidationBonus <= 0.15);
    assert.ok(p.closeFactor > 0 && p.closeFactor <= 1);
    assert.ok(p.gasCostUsd >= 0);
    assert.ok(p.collateralVolatility > 0);
    if (healthFactor(p.collateralUsd, p.debtUsd, p.liquidationThreshold) < 1) liquidatable++;
  }
  // Mostly healthy positions, some liquidatable.
  assert.ok(liquidatable > 10 && liquidatable < 100, `liquidatable=${liquidatable}`);
  assert.equal(new Set(ps.map((p) => p.protocol)).size, 4);
});

test('real sources are stubs that throw and cannot be selected', async () => {
  for (const S of [KaminoSource, MarginFiSource, SaveSource, AaveV3Source]) {
    const s = new S();
    assert.equal(s.implemented, false);
    assert.equal(s.simulated, false);
    await assert.rejects(() => s.scan({ cycle: 1, now }), NotImplementedError);
  }
  for (const src of ['kamino', 'marginfi', 'save', 'aave-v3']) {
    const cfg = loadConfig({ OPPORTUNITY_SOURCE: src });
    assert.equal(createSource(cfg).implemented, false);
    assert.throws(() => assertRunnable(cfg), ConfigError);
    assert.throws(() => assertRunnable({ ...cfg, mode: 'live', liveConfirmed: true }), ConfigError);
  }
});

test('config: defaults are safe; live is refused even when confirmed', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.mode, 'paper');
  assert.equal(cfg.source, 'simulated');
  assert.equal(cfg.claudeGateEnabled, false);
  assert.doesNotThrow(() => assertRunnable(cfg));
  assert.throws(() => assertRunnable(loadConfig({ MODE: 'live' })), /not supported/);
  assert.throws(
    () => assertRunnable(loadConfig({ MODE: 'live', LIVE_TRADING_CONFIRM: 'I_UNDERSTAND_REAL_MONEY_RISK' })),
    /not supported/,
  );
  assert.throws(() => loadConfig({ MODE: 'yolo' }), ConfigError);
  assert.throws(() => loadConfig({ MAX_GAS_SHARE: 'abc' }), ConfigError);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: 'k' }).claudeGateEnabled, true);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: 'k', CLAUDE_GATE: 'off' }).claudeGateEnabled, false);
});
