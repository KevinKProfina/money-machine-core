import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exitReason, passesFilters, rankScore, traderSpecies } from './trader.js';
import { easyGenome, token } from '../testing/helpers.js';
import type { Agent, Position } from '../types.js';
import type { MarketSnapshot } from '../market.js';

function agent(genomeOverrides = {}, positions: Position[] = []): Agent {
  return {
    id: 'a1',
    species: 'trader',
    genome: easyGenome(genomeOverrides),
    origin: 'genesis',
    parentId: null,
    generation: 0,
    bornCycle: 0,
    bornAt: '',
    birthCapitalUsd: 10,
    cashUsd: 10,
    debtUsd: 0,
    givenUsd: 0,
    peakBalanceUsd: 10,
    positions,
    cooldownUntil: 0,
    children: 0,
    stats: { trades: 0, wins: 0, realizedPnlUsd: 0, upkeepPaidUsd: 0, feesPaidUsd: 0 },
  };
}

function pos(o: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    mint: 'm',
    symbol: 'M',
    quantity: 10,
    sizeUsd: 10,
    costBasisUsd: 9.97,
    entryPriceUsd: 1,
    lastPriceUsd: 1,
    peakPriceUsd: 1,
    lastLiquidityUsd: 1e6,
    openedCycle: 1,
    lastPricedCycle: 5,
    ...o,
  };
}

function snap(...tokens: ReturnType<typeof token>[]): MarketSnapshot {
  return { source: 'synthetic', ok: true, fetchedAt: '', candidates: tokens, tokens: new Map(tokens.map((t) => [t.mint, t])) };
}

test('filters: liquidity, volume, age, buy/sell ratio and momentum windows', () => {
  const g = easyGenome({ minLiquidityUsd: 50_000, minVolume24hUsd: 100_000, minAgeHours: 24, maxAgeHours: 500, minBuySellRatio: 1, minChangeM5: 0, minChangeH1: 2, maxChangeH1: 40, minChangeH24: -10 });
  assert.ok(passesFilters(g, token('ok')));
  assert.ok(!passesFilters(g, token('x', { liquidityUsd: 10_000 })));
  assert.ok(!passesFilters(g, token('x', { volume24hUsd: 50_000 })));
  assert.ok(!passesFilters(g, token('x', { ageHours: 10 })));
  assert.ok(!passesFilters(g, token('x', { ageHours: 900 })));
  assert.ok(!passesFilters(g, token('x', { ageHours: Number.NaN })), 'unknown age fails when minAge > 0');
  assert.ok(!passesFilters(g, token('x', { buys24h: 900, sells24h: 1000 })));
  assert.ok(!passesFilters(g, token('x', { priceChange: { m5: -1, h1: 5, h24: 0 } })));
  assert.ok(!passesFilters(g, token('x', { priceChange: { m5: 1, h1: 1, h24: 0 } })));
  assert.ok(!passesFilters(g, token('x', { priceChange: { m5: 1, h1: 80, h24: 0 } })));
  assert.ok(!passesFilters(g, token('x', { priceChange: { m5: 1, h1: 5, h24: -20 } })));
  assert.ok(passesFilters(g, token('x', { priceChange: {} })), 'missing price changes are not filtered');
});

test('act: buys the best-ranked passing candidate, sized from balance', () => {
  const a = agent({ positionPct: 0.2, rankBy: 0 });
  const intents = traderSpecies.act(a, { cycle: 5, snapshot: snap(token('a', { priceChange: { h1: 3 } }), token('b', { priceChange: { h1: 9 } })), allowEntries: true, balanceUsd: 10, minTradeUsd: 0.25 });
  assert.deepEqual(intents.map((i) => i.kind), ['buy']);
  assert.equal(intents[0]!.kind === 'buy' && intents[0]!.mint, 'b');
  assert.equal(intents[0]!.kind === 'buy' && intents[0]!.sizeUsd, 2);
});

test('act: rank genes change the choice', () => {
  const young = token('young', { ageHours: 2, priceChange: { h1: 1 } });
  const old = token('old', { ageHours: 900, priceChange: { h1: 10 } });
  assert.ok(rankScore(easyGenome({ rankBy: 3 }), young) > rankScore(easyGenome({ rankBy: 3 }), old));
  const intents = traderSpecies.act(agent({ rankBy: 3 }), { cycle: 1, snapshot: snap(young, old), allowEntries: true, balanceUsd: 10, minTradeUsd: 0.25 });
  assert.equal(intents[0]!.kind === 'buy' && intents[0]!.mint, 'young');
});

test('act: no entries when not allowed, in cooldown, at max positions, already held or too small', () => {
  const s = snap(token('a'));
  const base = { cycle: 5, snapshot: s, balanceUsd: 10, minTradeUsd: 0.25 };
  assert.equal(traderSpecies.act(agent(), { ...base, allowEntries: false }).length, 0);
  const cooling = agent();
  cooling.cooldownUntil = 6;
  assert.equal(traderSpecies.act(cooling, { ...base, allowEntries: true }).length, 0);
  const full = agent({ maxOpenPositions: 1 }, [pos({ mint: 'other', lastPricedCycle: 5 })]);
  assert.equal(traderSpecies.act(full, { ...base, allowEntries: true }).length, 0);
  const held = agent({ maxOpenPositions: 3 }, [pos({ mint: 'a' })]);
  assert.equal(traderSpecies.act(held, { ...base, allowEntries: true }).filter((i) => i.kind === 'buy').length, 0);
  assert.equal(traderSpecies.act(agent({ positionPct: 0.02 }), { ...base, balanceUsd: 1, allowEntries: true }).length, 0);
});

test('exits: take profit, stop loss, trailing stop, max hold; no exit without a fresh price', () => {
  const g = easyGenome({ takeProfitPct: 20, stopLossPct: 10, trailingStopPct: 15, maxHoldCycles: 50 });
  assert.equal(exitReason(g, pos({ lastPriceUsd: 1.25 }), 5), 'take-profit');
  assert.equal(exitReason(g, pos({ lastPriceUsd: 0.85 }), 5), 'stop-loss');
  assert.equal(exitReason(g, pos({ lastPriceUsd: 1.0, peakPriceUsd: 1.19 }), 5), 'trailing-stop');
  assert.equal(exitReason(g, pos({ lastPriceUsd: 1.05, peakPriceUsd: 1.1 }), 5), undefined);
  assert.equal(exitReason(g, pos({ openedCycle: 1, lastPricedCycle: 60 }), 60), 'max-hold');
  assert.equal(exitReason(g, pos({ lastPriceUsd: 0.5, lastPricedCycle: 4 }), 5), undefined, 'stale mark: hold');
  const noTrail = easyGenome({ trailingStopPct: 0, takeProfitPct: 500, stopLossPct: 90 });
  assert.equal(exitReason(noTrail, pos({ lastPriceUsd: 1.0, peakPriceUsd: 3 }), 5), undefined);
});

test('act: exit frees a slot for a new entry in the same cycle', () => {
  const a = agent({ maxOpenPositions: 1, takeProfitPct: 10 }, [pos({ mint: 'old', lastPriceUsd: 1.5, lastPricedCycle: 5 })]);
  const intents = traderSpecies.act(a, { cycle: 5, snapshot: snap(token('a')), allowEntries: true, balanceUsd: 10, minTradeUsd: 0.25 });
  assert.deepEqual(intents.map((i) => i.kind), ['sell', 'buy']);
});
