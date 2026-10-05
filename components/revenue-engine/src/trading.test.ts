import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeTradingDeltas } from './sources/trading.js';
import { strategyReport } from './test-utils.js';

test('first snapshot books full realized PnL; unchanged report books nothing', () => {
  const r1 = computeTradingDeltas([strategyReport({ name: 'solana-trader', realizedPnlUsd: 12.5, unrealizedPnlUsd: 100 })], {});
  assert.equal(r1.events.length, 1);
  assert.equal(r1.events[0].amountUsd, 12.5);
  assert.equal(r1.events[0].kind, 'trading');
  assert.equal(r1.events[0].simulated, true);
  const r2 = computeTradingDeltas([strategyReport({ name: 'solana-trader', realizedPnlUsd: 12.5 })], r1.nextLastSeen);
  assert.equal(r2.events.length, 0);
});

test('deltas: gains positive, losses negative, kind from report kind, live = not simulated', () => {
  const seen = {
    'solana-trader:live': { realizedPnlUsd: 10, lastUpdated: '2026-10-01T00:00:00.000Z' },
    'liquidation-hunter:paper': { realizedPnlUsd: 5, lastUpdated: '2026-10-01T00:00:00.000Z' },
  };
  const { events, nextLastSeen } = computeTradingDeltas(
    [
      strategyReport({ name: 'solana-trader', mode: 'live', realizedPnlUsd: 10.3, lastUpdated: '2026-10-02T00:00:00.000Z' }),
      strategyReport({ name: 'liquidation-hunter', kind: 'liquidation', realizedPnlUsd: 2, lastUpdated: '2026-10-02T00:00:00.000Z' }),
    ],
    seen,
  );
  const st = events.find((e) => e.stream === 'solana-trader')!;
  assert.equal(st.amountUsd, 0.3);
  assert.equal(st.simulated, false);
  assert.equal(st.timestamp, '2026-10-02T00:00:00.000Z');
  const lh = events.find((e) => e.stream === 'liquidation-hunter')!;
  assert.equal(lh.amountUsd, -3);
  assert.equal(lh.kind, 'liquidation');
  assert.equal(lh.simulated, true);
  assert.equal(nextLastSeen['liquidation-hunter:paper'].realizedPnlUsd, 2);
});

test('mode switch starts a fresh baseline instead of booking a cross-mode jump', () => {
  const seen = { 'solana-trader:paper': { realizedPnlUsd: 500, lastUpdated: '2026-10-01T00:00:00.000Z' } };
  const { events } = computeTradingDeltas([strategyReport({ name: 'solana-trader', mode: 'live', realizedPnlUsd: 4 })], seen);
  assert.equal(events.length, 1);
  assert.equal(events[0].amountUsd, 4);
  assert.equal(events[0].simulated, false);
});

test('ids are stable for the same snapshot and skip non-finite PnL', () => {
  const rep = strategyReport({ name: 'x', realizedPnlUsd: 3 });
  assert.equal(computeTradingDeltas([rep], {}).events[0].id, computeTradingDeltas([rep], {}).events[0].id);
  assert.equal(computeTradingDeltas([strategyReport({ name: 'y', realizedPnlUsd: Number.NaN })], {}).events.length, 0);
});
