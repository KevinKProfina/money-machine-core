import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeTargets, finalizeAllocations, proposalProblem } from './allocation.js';
import { ConfigError, readConfig } from './config.js';
import { decide, type DecisionInput } from './cycle.js';
import { assessStrategy } from './health.js';
import type { FinalAllocations } from './mm-contract.js';
import { applyProfitDelta, computeProfitDelta, emptyLedger, totalCapital } from './reinvestment.js';
import { initialState } from './state.js';
import { NOW, makeConfig, makeProposal, makeReport, makeRevenue } from './test/fixtures.js';

const sum = (r: Record<string, number>) => Object.values(r).reduce((s, v) => s + v, 0);

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    config: makeConfig(),
    reports: [makeReport({ name: 'a' }), makeReport({ name: 'b' })],
    proposal: makeProposal({ a: 600, b: 300 }),
    revenue: null,
    previous: null,
    state: initialState(),
    globalKill: false,
    now: NOW,
    ...overrides,
  };
}

function prevAlloc(allocations: Record<string, number>, extra: Partial<FinalAllocations> = {}): FinalAllocations {
  return {
    schema: 'mm.allocations/v1',
    timestamp: NOW.toISOString(),
    totalCapitalUsd: 1000,
    reserveUsd: 0,
    allocations,
    paused: [],
    killSwitch: false,
    reasons: {},
    ...extra,
  };
}

describe('config', () => {
  it('validates RISK_PROFILE and fractions', () => {
    assert.equal(readConfig({}).riskProfile, 'moderate');
    assert.throws(() => readConfig({ RISK_PROFILE: 'reckless' }), ConfigError);
    assert.equal(readConfig({ RESERVE_PCT: '20' }).reservePct, 0.2);
    assert.equal(readConfig({ RESERVE_PCT: '0.2' }).reservePct, 0.2);
    assert.throws(() => readConfig({ MAX_STRATEGY_EXPOSURE: '150' }), ConfigError);
    assert.throws(() => readConfig({ TOTAL_CAPITAL: '-5' }), ConfigError);
    assert.throws(() => readConfig({ STRATEGY_DRAWDOWN_REDUCE: '0.4', STRATEGY_DRAWDOWN_PAUSE: '0.3' }), ConfigError);
  });
});

describe('health gates', () => {
  const cfg = makeConfig();
  it('healthy strategy passes', () => {
    const a = assessStrategy(makeReport(), cfg, NOW);
    assert.equal(a.paused, false);
    assert.equal(a.exposureFactor, 1);
  });
  it('pauses failed, stale, low-health and deep-drawdown strategies', () => {
    assert.equal(assessStrategy(makeReport({ status: 'failed' }), cfg, NOW).paused, true);
    const old = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
    const stale = assessStrategy(makeReport({ lastUpdated: old }), cfg, NOW);
    assert.equal(stale.paused, true);
    assert.equal(stale.stale, true);
    assert.equal(assessStrategy(makeReport({ lastUpdated: 'garbage' }), cfg, NOW).paused, true);
    const sick = assessStrategy(makeReport({ totalReturn: -0.2, winRate: 0.2, sharpeRatio: -1 }), cfg, NOW);
    assert.ok(sick.health < 50);
    assert.equal(sick.paused, true);
    assert.equal(assessStrategy(makeReport({ maxDrawdown: 0.4 }), makeConfig({ minHealthScore: 0 }), NOW).paused, true);
    assert.equal(assessStrategy(makeReport({ winRate: Number.NaN }), cfg, NOW).paused, true);
  });
  it('reduces exposure linearly on drawdown', () => {
    const a = assessStrategy(makeReport({ maxDrawdown: 0.25 }), makeConfig({ minHealthScore: 0 }), NOW);
    assert.equal(a.paused, false);
    assert.ok(Math.abs(a.exposureFactor - 0.5) < 1e-9);
  });
});

describe('allocation', () => {
  const healthy = (name: string, exposureFactor = 1) => ({ name, health: 90, paused: false, exposureFactor, stale: false, reasons: [] });

  it('scales proposal shares to deployable capital', () => {
    const t = computeTargets([healthy('a'), healthy('b')], makeProposal({ a: 500, b: 250 }), null, 900);
    assert.equal(t.source, 'proposal');
    assert.equal(t.targets.a, 450);
    assert.equal(t.targets.b, 225);
  });

  it('honours the allocator risk gate and missing entries', () => {
    const p = makeProposal({ a: 500, b: 0 });
    p.scores.a!.riskGateAllowed = false;
    const t = computeTargets([healthy('a'), healthy('b'), healthy('c')], p, null, 900);
    assert.deepEqual(t.targets, { a: 0, b: 0, c: 0 });
  });

  it('falls back to equal split without a usable proposal', () => {
    assert.equal(proposalProblem(null, NOW, 1000), 'no allocation proposal');
    const old = makeProposal({ a: 1 }, 1000, { timestamp: '2020-01-01T00:00:00Z' });
    assert.equal(proposalProblem(old, NOW, 1000), 'proposal is stale');
    const t = computeTargets([healthy('a'), healthy('b'), { ...healthy('c'), paused: true }], null, 'no allocation proposal', 900);
    assert.equal(t.source, 'equal-split');
    assert.deepEqual(t.targets, { a: 450, b: 450, c: 0 });
  });

  it('smoothing: moves at most one step toward target; pausing goes to 0 at once', () => {
    const out = finalizeAllocations(
      { a: 450, b: 0, c: 300 },
      { previous: { a: 100, b: 400, c: 400 }, paused: new Set(['c']), maxStepUsd: 100, capUsd: 500, deployableUsd: 900 },
    );
    assert.deepEqual(out, { a: 200, b: 300, c: 0 });
  });

  it('enforces the per-strategy cap and total <= deployable', () => {
    const out = finalizeAllocations({ a: 900, b: 600 }, { previous: null, paused: new Set(), maxStepUsd: 100, capUsd: 500, deployableUsd: 800 });
    assert.ok(out.a! <= 500 && out.b! <= 500);
    assert.ok(sum(out) <= 800);
  });
});

describe('reinvestment', () => {
  it('does not double-count trading revenue that revenue-engine also reports', () => {
    const reports = [makeReport({ name: 'solana-trader', realizedPnlUsd: 150 })];
    const revenue = makeRevenue({
      'solana-trader': { kind: 'trading', totalUsd: 150, last7dUsd: 0, last30dUsd: 0, simulated: true },
      'liquidation-hunter': { kind: 'liquidation', totalUsd: 999, last7dUsd: 0, last30dUsd: 0, simulated: true },
      'ai-services': { kind: 'ai-services', totalUsd: 80, last7dUsd: 0, last30dUsd: 0, simulated: false },
    });
    const d = computeProfitDelta(reports, revenue, { 'solana-trader:paper': 100 }, { 'ai-services': 50, 'solana-trader': 100 });
    assert.equal(d.tradingDeltaUsd, 50);
    assert.equal(d.nonTradingDeltaUsd, 30);
    assert.equal(d.deltaUsd, 80);
    assert.equal(d.nextRevenueByStream['liquidation-hunter'], undefined);
    assert.equal(d.nextRevenueByStream['solana-trader'], 100); // untouched baseline: trading stream ignored
  });

  it('splits real (live / non-simulated) from simulated (paper / simulated streams) profit', () => {
    const reports = [
      makeReport({ name: 'live', mode: 'live', realizedPnlUsd: 30 }),
      makeReport({ name: 'paper', mode: 'paper', realizedPnlUsd: 100 }),
    ];
    const revenue = makeRevenue({
      saas: { kind: 'saas', totalUsd: 15, last7dUsd: 0, last30dUsd: 0, simulated: false },
      aff: { kind: 'affiliate', totalUsd: 40, last7dUsd: 0, last30dUsd: 0, simulated: true },
    });
    const d = computeProfitDelta(reports, revenue, { 'live:live': 0, 'paper:paper': 0 }, { saas: 5, aff: 0 });
    assert.equal(d.realDeltaUsd, 40);
    assert.equal(d.simulatedDeltaUsd, 140);
  });

  it('first sighting: profit only sets a baseline, loss is booked', () => {
    const d = computeProfitDelta([makeReport({ name: 'x', realizedPnlUsd: 500 })], null, {}, {});
    assert.equal(d.deltaUsd, 0);
    assert.equal(d.nextRealizedByStrategy['x:paper'], 500);
    const l = computeProfitDelta([makeReport({ name: 'y', realizedPnlUsd: -40 })], null, {}, {});
    assert.equal(l.deltaUsd, -40);
    assert.equal(l.nextRealizedByStrategy['y:paper'], -40);
  });

  it('decide(): a loss on the very first cycle shows up as drawdown', () => {
    const d = decide(input({ state: initialState(), reports: [makeReport({ name: 'a', realizedPnlUsd: -50 }), makeReport({ name: 'b' })] }));
    assert.ok(d.portfolio.maxDrawdown > 0.04, `drawdown ${d.portfolio.maxDrawdown}`);
  });

  it('a paper→live switch starts a fresh real baseline instead of mixing counters', () => {
    const d = computeProfitDelta([makeReport({ name: 'x', mode: 'live', realizedPnlUsd: 3 })], null, { 'x:paper': 900 }, {});
    assert.equal(d.realDeltaUsd, 0);
    assert.equal(d.simulatedDeltaUsd, 0);
  });

  it('reinvests a share of profit, repays losses first, blocks on drawdown', () => {
    const zero = emptyLedger();
    const r1 = applyProfitDelta(zero, 100, 0.6, true);
    assert.equal(r1.reinvestedNowUsd, 60);
    assert.equal(r1.retainedNowUsd, 40);
    assert.equal(totalCapital(1000, r1, zero, false), 1060);
    const loss = applyProfitDelta(r1, -80, 0.6, true);
    assert.equal(loss.lossCarryforwardUsd, 80);
    assert.equal(totalCapital(1000, loss, zero, false), 980);
    const recover = applyProfitDelta(loss, 100, 0.5, true);
    assert.equal(recover.lossCarryforwardUsd, 0);
    assert.equal(recover.reinvestedNowUsd, 10);
    const blocked = applyProfitDelta(zero, 100, 0.6, false);
    assert.equal(blocked.reinvestedNowUsd, 0);
    assert.equal(blocked.retainedNowUsd, 100);
    // simulated ledger never counts once anything is live
    assert.equal(totalCapital(1000, zero, r1, true), 1000);
  });

  it('decide(): all-paper loop reinvests simulated profit (notional capital)', () => {
    const state = { ...initialState(), lastRealizedPnlByStrategy: { 'a:paper': 0, 'b:paper': 0 } };
    const d = decide(input({ state, reports: [makeReport({ name: 'a', realizedPnlUsd: 200 }), makeReport({ name: 'b' })] }));
    assert.equal(d.allocations.totalCapitalUsd, 1100);
    assert.equal(d.portfolio.reinvestedUsd, 100);
    assert.equal(d.portfolio.simulatedProfitUsd, 200);
    assert.equal(d.portfolio.realProfitUsd, 0);
    assert.equal(d.state.simulated.retainedProfitUsd, 100);
  });

  it('decide(): with a live strategy, simulated profit never increases capital', () => {
    const state = { ...initialState(), lastRealizedPnlByStrategy: { 'a:live': 0, 'b:paper': 0 }, lastRevenueByStream: { aff: 0 } };
    const reports = [
      makeReport({ name: 'a', mode: 'live', realizedPnlUsd: 20 }),
      makeReport({ name: 'b', mode: 'paper', realizedPnlUsd: 500 }),
    ];
    const revenue = makeRevenue({ aff: { kind: 'affiliate', totalUsd: 300, last7dUsd: 0, last30dUsd: 0, simulated: true } });
    const d = decide(input({ state, reports, revenue }));
    assert.equal(d.portfolio.anyLive, true);
    assert.equal(d.allocations.totalCapitalUsd, 1010); // only 50 % of the real $20
    assert.equal(d.state.simulated.reinvestedUsd, 0);
    assert.equal(d.state.simulated.retainedProfitUsd, 800);
    assert.equal(d.portfolio.realProfitUsd, 20);
    assert.equal(d.portfolio.simulatedProfitUsd, 800);
    assert.ok(d.portfolio.notes.some((n) => n.includes('real profit only')));
    // simulated profit reinvested earlier is dropped from capital once a strategy goes live
    const earlier = { ...initialState(), simulated: { reinvestedUsd: 400, retainedProfitUsd: 400, lossCarryforwardUsd: 0 } };
    const live = decide(input({ state: earlier, reports: [makeReport({ name: 'a', mode: 'live' })] }));
    assert.equal(live.allocations.totalCapitalUsd, 1000);
  });

  it('decide(): synthetic-data strategies get 0 only when something runs live', () => {
    const synth = makeReport({ name: 'b', notes: ['synthetic-market-data: SimulatedSource'] });
    const paperOnly = decide(input({ reports: [makeReport({ name: 'a' }), synth] }));
    assert.ok(paperOnly.allocations.allocations.b! > 0);
    const withLive = decide(input({ reports: [makeReport({ name: 'a', mode: 'live' }), synth] }));
    assert.equal(withLive.allocations.allocations.b, 0);
    assert.ok(withLive.allocations.paused.includes('b'));
    assert.match(withLive.allocations.reasons.b!, /synthetic market data/);
  });
});

describe('decide()', () => {
  it('keeps the reserve, caps exposure, sums <= total', () => {
    const d = decide(input());
    const a = d.allocations;
    assert.equal(a.killSwitch, false);
    assert.equal(a.allocations.a, 500); // 0.6 * 900 = 540 -> capped at 50 % of 1000
    assert.equal(a.allocations.b, 270);
    assert.ok(sum(a.allocations) <= a.totalCapitalUsd * 0.9 + 1e-9);
    assert.equal(a.reserveUsd, 230);
    assert.deepEqual(d.portfolio.activeStrategies, ['a', 'b']);
  });

  it('pauses unhealthy strategies, emits an event once', () => {
    const reports = [makeReport({ name: 'a' }), makeReport({ name: 'b', status: 'failed' })];
    const d = decide(input({ reports, previous: prevAlloc({ a: 300, b: 300 }) }));
    assert.equal(d.allocations.allocations.b, 0);
    assert.deepEqual(d.allocations.paused, ['b']);
    assert.equal(d.events.filter((e) => e.type === 'strategy-paused').length, 1);
    const again = decide(input({ reports, previous: d.allocations }));
    assert.equal(again.events.length, 0);
  });

  it('smooths toward the proposal from previous allocations', () => {
    const d = decide(input({ previous: prevAlloc({ a: 100, b: 100 }) }));
    assert.equal(d.allocations.allocations.a, 200);
    assert.equal(d.allocations.allocations.b, 200);
  });

  it('trips and latches the kill switch on portfolio drawdown', () => {
    const state = { ...initialState(), highWaterMarkUsd: { combined: 1000, real: 0 } };
    const reports = [makeReport({ name: 'a', unrealizedPnlUsd: -300 }), makeReport({ name: 'b' })];
    const d = decide(input({ state, reports, previous: prevAlloc({ a: 400, b: 400 }) }));
    assert.equal(d.allocations.killSwitch, true);
    assert.equal(sum(d.allocations.allocations), 0);
    assert.equal(d.state.killSwitch.tripped, true);
    assert.ok(d.events.some((e) => e.level === 'error' && e.type === 'kill-switch-tripped'));
    assert.equal(d.portfolio.riskScore, 100);
    // recovered equity: still latched until operator reset
    const next = decide(input({ state: d.state, previous: d.allocations }));
    assert.equal(next.allocations.killSwitch, true);
    assert.equal(sum(next.allocations.allocations), 0);
    assert.equal(next.events.length, 0);
  });

  it('honours the global kill switch without latching', () => {
    const d = decide(input({ globalKill: true }));
    assert.equal(d.allocations.killSwitch, true);
    assert.equal(sum(d.allocations.allocations), 0);
    assert.equal(d.state.killSwitch.tripped, false);
    // after the kill clears, ramp back up from 0 with smoothing
    const after = decide(input({ previous: d.allocations }));
    assert.equal(after.allocations.allocations.a, 100);
  });

  it('reduces exposure when portfolio drawdown approaches the limit', () => {
    const state = { ...initialState(), highWaterMarkUsd: { combined: 1000, real: 0 } };
    const reports = [makeReport({ name: 'a', unrealizedPnlUsd: -200 }), makeReport({ name: 'b' })];
    const d = decide(input({ state, reports })); // dd 0.2, half-limit 0.125 -> scale 0.4
    assert.equal(d.allocations.killSwitch, false);
    assert.ok(sum(d.allocations.allocations) <= 0.4 * 900 + 1e-6);
  });
});
