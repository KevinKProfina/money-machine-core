import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate, herfindahl } from './aggregate.js';
import { ev } from './test-utils.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400000).toISOString();

test('herfindahl: single stream = 1, equal split = 1/n, ignores non-positive', () => {
  assert.equal(herfindahl([100]), 1);
  assert.ok(Math.abs(herfindahl([50, 50]) - 0.5) < 1e-12);
  assert.ok(Math.abs(herfindahl([25, 25, 25, 25]) - 0.25) < 1e-12);
  assert.ok(Math.abs(herfindahl([75, 25, -40, 0]) - (0.75 ** 2 + 0.25 ** 2)) < 1e-12);
  assert.equal(herfindahl([]), 0);
  assert.equal(herfindahl([-5, 0]), 0);
});

test('aggregate: totals per stream and 7d/30d windows', () => {
  const r = aggregate(
    [
      ev({ id: 'a', stream: 'stripe', kind: 'saas', amountUsd: 100, timestamp: daysAgo(1) }),
      ev({ id: 'b', stream: 'stripe', kind: 'saas', amountUsd: -10, timestamp: daysAgo(8) }),
      ev({ id: 'c', stream: 'stripe', kind: 'saas', amountUsd: 50, timestamp: daysAgo(40) }),
      ev({ id: 'd', stream: 'affiliate', kind: 'affiliate', amountUsd: 20, timestamp: daysAgo(6.9) }),
      ev({ id: 'e', stream: 'solana-trader', kind: 'trading', amountUsd: 30, timestamp: daysAgo(29), simulated: true }),
      ev({ id: 'f', stream: 'affiliate', kind: 'affiliate', amountUsd: 5, timestamp: daysAgo(-1) }), // future: total only
    ],
    NOW,
  );
  assert.equal(r.schema, 'mm.revenue/v1');
  assert.equal(r.totalUsd, 195);
  assert.equal(r.last7dUsd, 120);
  assert.equal(r.last30dUsd, 140);
  assert.deepEqual(r.streams.stripe, { kind: 'saas', totalUsd: 140, last7dUsd: 100, last30dUsd: 90, simulated: false });
  assert.equal(r.streams.affiliate.totalUsd, 25);
  assert.equal(r.streams['solana-trader'].simulated, true);
  assert.equal(r.simulatedTotalUsd, 30);
  assert.equal(r.realTotalUsd, 165);
  const expectedHhi = (140 / 195) ** 2 + (25 / 195) ** 2 + (30 / 195) ** 2;
  assert.ok(Math.abs(r.concentration - expectedHhi) < 1e-6);
  assert.equal(r.positiveStreams, 3);
});

test('aggregate: window boundaries are (now-7d, now]', () => {
  const r = aggregate(
    [
      ev({ id: 'x', amountUsd: 1, timestamp: daysAgo(7) }),
      ev({ id: 'y', amountUsd: 2, timestamp: daysAgo(30) }),
      ev({ id: 'z', amountUsd: 4, timestamp: NOW.toISOString() }),
    ],
    NOW,
  );
  assert.equal(r.last7dUsd, 4);
  assert.equal(r.last30dUsd, 5);
  assert.equal(r.totalUsd, 7);
});

test('recommendations: dominant stream (> 60 %) suggests other kinds to grow', () => {
  const r = aggregate(
    [
      ev({ id: '1', stream: 'solana-trader', kind: 'trading', amountUsd: 900, timestamp: daysAgo(1) }),
      ev({ id: '2', stream: 'affiliate', kind: 'affiliate', amountUsd: 100, timestamp: daysAgo(1) }),
    ],
    NOW,
  );
  const dominant = r.recommendations.find((x) => x.includes('solana-trader'));
  assert.ok(dominant, r.recommendations.join('\n'));
  assert.match(dominant, /90%/);
  assert.match(dominant, /Consider growing: /);
  assert.doesNotMatch(dominant.split('Consider growing:')[1], /\btrading\b/);
  assert.ok(r.recommendations.some((x) => x.includes('highly concentrated')));
});

test('recommendations: no revenue and negative 30d streams', () => {
  assert.match(aggregate([], NOW).recommendations[0], /No positive revenue/);
  assert.equal(aggregate([], NOW).concentration, 0);
  const r = aggregate(
    [
      ev({ id: '1', stream: 'a', kind: 'saas', amountUsd: 100, timestamp: daysAgo(60) }),
      ev({ id: '2', stream: 'a', kind: 'saas', amountUsd: -20, timestamp: daysAgo(2) }),
      ev({ id: '3', stream: 'b', kind: 'affiliate', amountUsd: 90, timestamp: daysAgo(2) }),
    ],
    NOW,
  );
  assert.ok(r.recommendations.some((x) => x.includes('"a" is net negative')));
  assert.ok(!r.recommendations.some((x) => x.includes('Consider growing')));
});
