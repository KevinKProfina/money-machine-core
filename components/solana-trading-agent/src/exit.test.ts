import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideExit } from './exit.js';
import type { ExitRules } from './config.js';

const rules: ExitRules = { takeProfitPct: 25, stopLossPct: 10, trailingStopPct: 8, trailingActivationPct: 5, maxHoldHours: 48 };
const openedAt = '2026-10-01T00:00:00Z';
const at = (hours: number) => new Date(Date.parse(openedAt) + hours * 3_600_000);
const check = (current: number, highest = current, hours = 1) =>
  decideExit({ entryPriceUsd: 1, highestPriceUsd: highest, currentPriceUsd: current, openedAt, now: at(hours) }, rules);

test('take-profit at or above target', () => {
  assert.equal(check(1.25).reason, 'take-profit');
  assert.equal(check(1.24, 1.24).shouldExit, false);
});

test('stop-loss at or below limit', () => {
  assert.equal(check(0.9).reason, 'stop-loss');
  assert.equal(check(0.91).shouldExit, false);
});

test('trailing stop fires only after activation and a pullback from the high', () => {
  // up 20 %, then back to 1.10 (8.3 % below high) → trailing stop
  const d = check(1.1, 1.2);
  assert.equal(d.reason, 'trailing-stop');
  assert.ok(d.pnlPct > 0);
  // pullback < trailing distance → hold
  assert.equal(check(1.15, 1.2).shouldExit, false);
  // never armed: peak only +3 %, now -6 % from high but above stop-loss → hold
  assert.equal(check(0.97, 1.03).shouldExit, false);
});

test('max holding time closes stale positions', () => {
  assert.equal(check(1.01, 1.02, 47.9).shouldExit, false);
  const d = check(1.01, 1.02, 48);
  assert.equal(d.reason, 'max-hold');
});

test('stop-loss takes precedence over max-hold', () => {
  assert.equal(check(0.8, 1, 100).reason, 'stop-loss');
});

test('current price above recorded high is treated as the new high', () => {
  assert.equal(check(1.2, 1.0).shouldExit, false);
});
