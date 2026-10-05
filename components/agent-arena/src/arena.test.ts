import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Arena, InvariantError, conservation, arenaEquity, createGenesisState } from './arena.js';
import { SyntheticMarket } from './synthetic-market.js';
import { FakeMarket, easyGenome, makeArena, tempStateDir, testConfig, token } from './testing/helpers.js';
import { agentBalance } from './types.js';
import { buildStrategyReport } from './report.js';

beforeEach(() => {
  tempStateDir();
});

const quiet = { ARENA_IMMIGRANTS_PER_CYCLE: '0' };
const run = { paused: false };

test('genesis spawns the min population from the treasury', () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '20' });
  const { arena, state } = makeArena(cfg, new FakeMarket());
  arena.genesis();
  assert.equal(state.agents.length, 20);
  assert.equal(state.treasuryUsd, 500 - 20 * 5);
  assert.ok(state.agents.every((a) => a.origin === 'genesis' && a.generation === 0 && a.cashUsd === 5));
  arena.checkInvariant();
});

test('death: balance below ARENA_DEATH_USD kills the agent and returns dust to the treasury', async () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '0', ARENA_UPKEEP_USD: '1.6' });
  const { arena, state } = makeArena(cfg, new FakeMarket());
  arena.spawnFromTreasury('spawn');
  const treasuryAfterSpawn = state.treasuryUsd;
  for (let i = 0; i < 3; i++) await arena.runCycle(run);
  assert.equal(state.agents.length, 0);
  assert.equal(state.deathsTotal, 1);
  assert.ok(Math.abs(state.treasuryUsd - (treasuryAfterSpawn + 0.2)) < 1e-9, String(state.treasuryUsd));
  const dead = arena.graveyard.recent[0]!;
  assert.equal(dead.cause, 'bankrupt');
  assert.equal(dead.diedCycle, 3);
  assert.ok(Math.abs(dead.returnedUsd - 0.2) < 1e-9);
  assert.equal(arena.graveyard.aggregate.byCause.bankrupt, 1);
  assert.ok(Math.abs(state.ledger.upkeepUsd - 4.8) < 1e-9);
});

test('dying agent with an open position is liquidated at the current price', async () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '0', ARENA_UPKEEP_USD: '0', ARENA_DEATH_USD: '3' });
  const market = new FakeMarket();
  market.set(token('a'));
  const { arena, state } = makeArena(cfg, market);
  const a = arena.spawnFromTreasury('spawn', easyGenome({ positionPct: 0.5, stopLossPct: 90 }))!;
  await arena.runCycle(run);
  assert.equal(a.positions.length, 1);
  market.price('a', 0.2); // balance ≈ 2.5 cash + 0.5 marked < 3 → dies, position sold at 0.2
  market.candidates = [];
  await arena.runCycle(run);
  assert.equal(state.agents.length, 0);
  const returned = arena.graveyard.recent[0]!.returnedUsd;
  assert.ok(returned > 2.5 && returned < 3, String(returned));
  assert.equal(state.trades.count, 1);
  arena.checkInvariant();
});

test('reproduction: child gets ARENA_REPRO_SHARE of the balance, a mutated genome and generation + 1', async () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '0', ARENA_UPKEEP_USD: '0', ARENA_REPRO_MIN_AGE: '1', ARENA_MUTATION_RATE: '1' });
  const market = new FakeMarket();
  market.set(token('a'));
  const { arena, state } = makeArena(cfg, market);
  const parent = arena.spawnFromTreasury('spawn', easyGenome({ positionPct: 0.5, takeProfitPct: 50 }))!;
  await arena.runCycle(run);
  assert.equal(parent.positions.length, 1);
  market.price('a', 5);
  market.candidates = [];
  await arena.runCycle(run);
  assert.equal(parent.positions.length, 0, 'take profit');
  assert.equal(state.agents.length, 2);
  const child = state.agents[1]!;
  assert.equal(child.origin, 'birth');
  assert.equal(child.parentId, parent.id);
  assert.equal(child.generation, 1);
  assert.notDeepEqual(child.genome, parent.genome);
  assert.ok(Math.abs(child.cashUsd - parent.givenUsd) < 1e-12);
  assert.ok(Math.abs(child.birthCapitalUsd - (child.cashUsd + parent.cashUsd) * 0.5) < 1e-9);
  assert.equal(parent.children, 1);
  assert.equal(state.births.birth, 1);
  arena.checkInvariant();
});

test('reproduction requires the minimum age', async () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '0', ARENA_UPKEEP_USD: '0', ARENA_REPRO_MIN_AGE: '100' });
  const market = new FakeMarket();
  market.set(token('a'));
  const { arena, state } = makeArena(cfg, market);
  arena.spawnFromTreasury('spawn', easyGenome({ takeProfitPct: 50 }));
  await arena.runCycle(run);
  market.price('a', 5);
  await arena.runCycle(run);
  assert.equal(state.agents.length, 1);
});

test('min population is refilled from the treasury while it can pay', async () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '3', ARENA_STARTING_CAPITAL_USD: '12' });
  const { arena, state } = makeArena(cfg, new FakeMarket());
  arena.genesis();
  assert.equal(state.agents.length, 2, 'treasury only affords 2 seeds');
  await arena.runCycle(run);
  assert.equal(state.agents.length, 2);
  const cfg2 = testConfig({ ...quiet, ARENA_MIN_POPULATION: '5' });
  const { arena: arena2, state: state2 } = makeArena(cfg2, new FakeMarket());
  arena2.genesis();
  cfg2.minPopulation = 8;
  await arena2.runCycle(run);
  assert.equal(state2.agents.length, 8);
  assert.equal(state2.births.spawn, 3);
});

test('max population caps births, spawns and immigrants', async () => {
  const cfg = testConfig({ ARENA_MIN_POPULATION: '3', ARENA_MAX_POPULATION: '3', ARENA_IMMIGRANTS_PER_CYCLE: '10', ARENA_UPKEEP_USD: '0', ARENA_REPRO_MIN_AGE: '0' });
  const market = new FakeMarket();
  market.set(token('a'));
  const { arena, state } = makeArena(cfg, market);
  arena.genesis();
  for (const a of state.agents) a.genome = easyGenome({ takeProfitPct: 50 });
  await arena.runCycle(run);
  market.price('a', 5);
  await arena.runCycle(run);
  assert.equal(state.agents.length, 3);
  assert.equal(state.births.birth, 0);
  arena.checkInvariant();
});

test('kill switch / pause: no entries, no births, exits still run', async () => {
  const cfg = testConfig({ ARENA_MIN_POPULATION: '0', ARENA_IMMIGRANTS_PER_CYCLE: '2', ARENA_UPKEEP_USD: '0', ARENA_REPRO_MIN_AGE: '0' });
  const market = new FakeMarket();
  market.set(token('a'), token('b', { priceChange: { h1: 1 } }));
  const { arena, state } = makeArena(cfg, market);
  const a = arena.spawnFromTreasury('spawn', easyGenome({ takeProfitPct: 50, maxOpenPositions: 1 }))!;
  await arena.runCycle(run);
  const population = state.agents.length;
  assert.equal(a.positions[0]!.mint, 'a');
  market.price('a', 5);
  await arena.runCycle({ paused: true, pauseReason: 'kill switch active' });
  assert.equal(a.positions.length, 0, 'take-profit exit ran while paused');
  assert.equal(state.lastCycle.exits, 1);
  assert.equal(state.lastCycle.entries, 0, 'no new entry into b');
  assert.equal(state.lastCycle.births, 0, 'no reproduction, no immigrants');
  assert.equal(state.agents.length, population);
  const report = buildStrategyReport(state, cfg, new Date());
  assert.equal(report.status, 'paused');
  await arena.runCycle(run);
  assert.ok(state.lastCycle.entries > 0 || state.lastCycle.births > 0);
});

test('market failure: no entries, upkeep still paid, positions keep their last mark, deaths deferred', async () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '0', ARENA_UPKEEP_USD: '0.01' });
  const market = new FakeMarket();
  market.set(token('a'), token('b'));
  const { arena, state } = makeArena(cfg, market);
  const a = arena.spawnFromTreasury('spawn', easyGenome({ maxOpenPositions: 2, positionPct: 0.3 }))!;
  await arena.runCycle(run);
  assert.equal(a.positions.length, 1);
  const mark = a.positions[0]!.lastPriceUsd;
  const upkeepBefore = state.ledger.upkeepUsd;
  market.ok = false;
  await arena.runCycle(run);
  assert.equal(state.lastCycle.marketOk, false);
  assert.equal(state.lastCycle.entries, 0);
  assert.equal(a.positions.length, 1);
  assert.equal(a.positions[0]!.lastPriceUsd, mark);
  assert.equal(a.positions[0]!.lastPricedCycle, 1);
  assert.ok(Math.abs(state.ledger.upkeepUsd - upkeepBefore - 0.01) < 1e-12);
  assert.deepEqual(market.calls[1], ['a'], 'held mints are requested');
});

test('positions without a price for ARENA_STALE_WRITE_OFF_CYCLES are written off at zero', async () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '0', ARENA_UPKEEP_USD: '0', ARENA_STALE_WRITE_OFF_CYCLES: '3' });
  const market = new FakeMarket();
  market.set(token('a'));
  const { arena, state } = makeArena(cfg, market);
  const a = arena.spawnFromTreasury('spawn', easyGenome())!;
  await arena.runCycle(run);
  const cost = a.positions[0]!.costBasisUsd;
  market.set(); // token delisted
  for (let i = 0; i < 3; i++) await arena.runCycle(run);
  assert.equal(a.positions.length, 0);
  assert.equal(state.lastCycle.writeOffs, 1);
  assert.ok(state.ledger.realizedLossUsd >= cost - 1e-12);
  arena.checkInvariant();
});

test('budget following: equity target follows the orchestrator budget via the treasury, then levies cash', async () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '20', ARENA_UPKEEP_USD: '0' });
  const { arena, state } = makeArena(cfg, new FakeMarket());
  arena.genesis();
  await arena.runCycle({ paused: false, budgetUsd: 800 });
  assert.ok(Math.abs(arenaEquity(state) - 800) < 1e-9);
  assert.ok(Math.abs(state.ledger.adjustmentsUsd - 300) < 1e-9);
  await arena.runCycle({ paused: false, budgetUsd: 50 });
  assert.ok(Math.abs(arenaEquity(state) - 50) < 1e-9);
  assert.equal(state.treasuryUsd, 0);
  for (const a of state.agents) assert.ok(Math.abs(a.cashUsd - 2.5) < 1e-9);
  assert.ok(state.agents.reduce((s, a) => s + agentBalance(a), 0) <= arenaEquity(state) + 1e-9);
  // paused: budget is not followed
  await arena.runCycle({ paused: true, budgetUsd: 1000 });
  assert.ok(Math.abs(arenaEquity(state) - 50) < 1e-9);
  const report = buildStrategyReport(state, cfg, new Date());
  assert.equal(report.capitalUsd, 50);
  assert.equal(report.realizedPnlUsd, 0, 'budget flows are not PnL');
  arena.checkInvariant();
});

test('budget levy that bankrupts agents records cause budget-levy', async () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '4', ARENA_UPKEEP_USD: '0' });
  const { arena, state } = makeArena(cfg, new FakeMarket());
  arena.genesis();
  await arena.runCycle({ paused: false, budgetUsd: 1 });
  assert.equal(state.agents.length, 0, 'levied below the death line; treasury cannot respawn');
  assert.equal(arena.graveyard.aggregate.byCause['budget-levy'], 4);
  assert.ok(Math.abs(arenaEquity(state) - 1) < 1e-9, 'dust returned to treasury');
  arena.checkInvariant();
});

test('money conservation holds over 300 seeded synthetic cycles with births, deaths and budget changes', async () => {
  const cfg = testConfig({ ARENA_REPRO_MULTIPLE: '1.3', ARENA_REPRO_MIN_AGE: '5', ARENA_UPKEEP_USD: '0.003', ARENA_IMMIGRANTS_PER_CYCLE: '2', ARENA_SLIPPAGE_BPS: '30' });
  const market = new SyntheticMarket({ seed: 'conservation' });
  const { arena, state, events } = makeArena(cfg, market);
  arena.genesis();
  let maxAbsDiff = 0;
  for (let i = 1; i <= 300; i++) {
    const budgetUsd = i < 100 ? undefined : i < 200 ? 650 : 300;
    await arena.runCycle({ paused: i >= 280 && i < 290, ...(budgetUsd !== undefined ? { budgetUsd } : {}) });
    maxAbsDiff = Math.max(maxAbsDiff, Math.abs(conservation(state).diff));
    assert.ok(state.treasuryUsd >= -1e-9);
    assert.ok(state.agents.every((a) => a.cashUsd >= -1e-9));
  }
  assert.ok(maxAbsDiff < 1e-6, String(maxAbsDiff));
  assert.ok(state.births.total > 20, `births ${state.births.total}`);
  assert.ok(state.trades.count > 50, `trades ${state.trades.count}`);
  assert.ok(Math.abs(state.ledger.adjustmentsUsd) > 0);
  assert.ok(!events.some((e) => e.type === 'arena.invariant-violated'));
});

test('invariant violation throws and emits an error event', async () => {
  const cfg = testConfig({ ...quiet });
  const { arena, state, events } = makeArena(cfg, new FakeMarket());
  arena.genesis();
  state.agents[0]!.cashUsd += 1; // money from nowhere
  await assert.rejects(arena.runCycle(run), InvariantError);
  assert.ok(events.some((e) => e.type === 'arena.invariant-violated' && e.level === 'error'));
});

test('mass extinction (> 50 % deaths in one cycle) emits an event', async () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '10', ARENA_UPKEEP_USD: '4.8' });
  const { arena, events } = makeArena(cfg, new FakeMarket());
  arena.genesis();
  cfg.minPopulation = 0;
  await arena.runCycle(run);
  assert.ok(events.some((e) => e.type === 'arena.mass-extinction'));
});

test('generation milestone event fires once', async () => {
  const cfg = testConfig({ ...quiet, ARENA_MIN_POPULATION: '0', ARENA_UPKEEP_USD: '0', ARENA_REPRO_MIN_AGE: '0', ARENA_REPRO_MULTIPLE: '1.01', ARENA_REPRO_SHARE: '0.3', ARENA_DEATH_USD: '0.05', ARENA_MUTATION_RATE: '0' });
  const market = new FakeMarket();
  market.set(token('a'));
  const { arena, state, events } = makeArena(cfg, market);
  arena.spawnFromTreasury('spawn', easyGenome({ takeProfitPct: 1 }));
  for (let i = 0; i < 12; i++) {
    market.price('a', 1 + (i + 1) * 0.5);
    await arena.runCycle(run);
  }
  assert.ok(state.maxGeneration >= 2, `max gen ${state.maxGeneration}`);
  assert.equal(events.filter((e) => e.type === 'arena.generation-milestone' && (e.data as { generation: number }).generation === 2).length, 1);
});

test('determinism: same seed → identical state; different seed → different', async () => {
  async function runSeed(seed: string) {
    const cfg = testConfig({ ARENA_SEED: seed, ARENA_REPRO_MULTIPLE: '1.3' });
    const state = createGenesisState(cfg, new Date('2026-01-01T00:00:00Z'), seed);
    const arena = new Arena(cfg, state, undefined, { market: new SyntheticMarket({ seed, now: () => new Date(0) }), now: () => new Date(0), emit: async () => {} });
    arena.genesis();
    for (let i = 0; i < 150; i++) await arena.runCycle(run);
    return JSON.stringify({ state, g: arena.graveyard });
  }
  const a = await runSeed('42');
  const b = await runSeed('42');
  const c = await runSeed('43');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('performance: 2000 agents per cycle in well under a few seconds', async () => {
  const cfg = testConfig({ ARENA_MIN_POPULATION: '2000', ARENA_STARTING_CAPITAL_USD: '20000', ARENA_SYNTHETIC_TOKENS: '80' });
  const { arena, state } = makeArena(cfg, new SyntheticMarket({ seed: 'perf', tokens: 80 }));
  arena.genesis();
  assert.equal(state.agents.length, 2000);
  let worst = 0;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await arena.runCycle(run);
    worst = Math.max(worst, performance.now() - t0);
  }
  assert.ok(state.agents.length >= 1990);
  assert.ok(worst < 1500, `worst cycle ${worst.toFixed(0)} ms`);
});
