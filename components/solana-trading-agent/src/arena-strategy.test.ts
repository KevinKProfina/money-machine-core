import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GENES, GENOME_BOUNDS, LIQUIDITY_FLOOR_USD, mapGenomeToSettings, promotionsPath, resolveStrategy, validateGenome, type ArenaGenome } from './arena-strategy.js';
import { readConfig, resolveMode, LIVE_CONFIRM_PHRASE } from './config.js';
import { runCycle, type CycleDeps } from './cycle.js';
import { PaperExecutor } from './executor.js';
import { DexScreenerSource, normalizePair } from './market.js';
import { statePaths, writeJsonAtomic } from './mm-contract.js';
import { positionsPath } from './positions.js';
import { rankCandidates, riskGates } from './strategy.js';
import { FIXTURE_NOW, MINTS, fixtureFetch, loadFixture, makeToken, testConfig } from './testing/fixtures.js';

beforeEach(() => {
  process.env.MM_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-solana-trader-arena-'));
  delete process.env.MM_KILL;
});

const GENOME: ArenaGenome = {
  minLiquidityUsd: 50_000,
  minVolume24hUsd: 100_000,
  minAgeHours: 0,
  maxAgeHours: 1_000,
  minBuySellRatio: 1.1,
  minChangeM5: -20,
  minChangeH1: -50,
  maxChangeH1: 300,
  minChangeH24: -90,
  positionPct: 0.05,
  takeProfitPct: 20,
  stopLossPct: 10,
  trailingStopPct: 0,
  maxHoldCycles: 288,
  maxOpenPositions: 2,
  cooldownCycles: 0,
  rankBy: 3,
};

async function promote(genome: Record<string, unknown>, extra: Record<string, unknown> = {}, id = 'g-abc123def456') {
  await writeJsonAtomic(promotionsPath(), {
    schema: 'mm.arena-promotions/v1',
    timestamp: FIXTURE_NOW.toISOString(),
    cycleMinutes: 5,
    candidates: [],
    promoted: { genomeId: id, genome, promotedAt: FIXTURE_NOW.toISOString(), reason: 'test', score: 0.1, cycleMinutes: 5, ...extra },
    history: [],
  });
}

function deps(env: Record<string, string> = {}, hours = 0, prices?: Record<string, number>): CycleDeps {
  const cfg = testConfig(env);
  const at = new Date(FIXTURE_NOW.getTime() + hours * 3_600_000);
  return {
    cfg,
    market: new DexScreenerSource({ fetchImpl: fixtureFetch({ prices }), now: () => at.getTime(), retries: 0 }),
    executor: cfg.mode === 'dry-run' ? undefined : new PaperExecutor(cfg.paperSlippageBps, cfg.paperFeeBps),
    now: () => at,
  };
}

function events(): Array<{ type: string; data?: Record<string, unknown> }> {
  const f = statePaths.events();
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

test('defaults are unchanged: new knobs are off when no promoted strategy is used', () => {
  const cfg = readConfig({}, []);
  assert.equal(cfg.strategySource, 'static');
  assert.equal(cfg.entryCooldownHours, 0);
  assert.equal(cfg.strategy.maxAgeHours, Number.POSITIVE_INFINITY);
  assert.equal(cfg.strategy.minChangeM5, undefined);
  assert.equal(cfg.strategy.minChangeH1, undefined);
  assert.equal(cfg.strategy.maxChangeH1, undefined);
  assert.equal(cfg.strategy.minChangeH24, undefined);
  assert.equal(cfg.strategy.rankBy, 'score');
  // momentum data present but gates off → no extra failures
  const t = makeToken({ ageHours: 50_000, priceChange: { m5: -90, h1: -90, h24: -99 } });
  assert.deepEqual(riskGates(t, cfg.strategy), []);
  assert.equal(readConfig({ STRATEGY_SOURCE: 'nonsense' }, []).strategySource, 'static');
  assert.throws(() => readConfig({ RANK_BY: 'vibes' }, []), /RANK_BY/);
});

test('mapGenomeToSettings: every gene maps; risk caps and liquidity floor apply; trader-only gates stay static', () => {
  const base = readConfig({}, []);
  const s = mapGenomeToSettings({ ...GENOME, minLiquidityUsd: 2_000, positionPct: 0.4, maxOpenPositions: 8, cooldownCycles: 6, trailingStopPct: 12 }, base, 5);
  assert.equal(s.strategy.minLiquidityUsd, LIQUIDITY_FLOOR_USD);
  assert.equal(s.strategy.minVolume24hUsd, 100_000);
  assert.equal(s.strategy.minAgeHours, 0);
  assert.equal(s.strategy.maxAgeHours, 1_000);
  assert.equal(s.strategy.minBuySellRatio, 1.1);
  assert.equal(s.strategy.minChangeM5, -20);
  assert.equal(s.strategy.minChangeH1, -50);
  assert.equal(s.strategy.maxChangeH1, 300);
  assert.equal(s.strategy.minChangeH24, -90);
  assert.equal(s.strategy.rankBy, 'youngest');
  assert.equal(s.exits.takeProfitPct, 20);
  assert.equal(s.exits.stopLossPct, 10);
  assert.equal(s.exits.trailingStopPct, 12);
  assert.equal(s.exits.trailingActivationPct, 0);
  assert.equal(s.exits.maxHoldHours, 24, '288 cycles × 5 min');
  assert.equal(s.entryCooldownHours, 0.5);
  assert.equal(s.sizing.maxPositionPct, base.sizing.maxPositionPct, 'capped by MAX_POSITION_PCT');
  assert.equal(s.sizing.maxConcurrentPositions, base.sizing.maxConcurrentPositions, 'capped by MAX_CONCURRENT_POSITIONS');
  assert.equal(s.sizing.maxUsdPerTrade, base.sizing.maxUsdPerTrade);
  for (const k of ['minMarketCapUsd', 'maxMarketCapUsd', 'minTxns24h', 'minLiquidityToMcap', 'minScore'] as const) assert.equal(s.strategy[k], base.strategy[k], k);
  // smaller genome values pass through; 15-minute cycles scale the hours
  const t = mapGenomeToSettings({ ...GENOME, positionPct: 0.03, maxOpenPositions: 1, rankBy: 0 }, base, 15);
  assert.equal(t.sizing.maxPositionPct, 0.03);
  assert.equal(t.sizing.maxConcurrentPositions, 1);
  assert.equal(t.exits.maxHoldHours, 72);
  assert.equal(t.strategy.rankBy, 'h1-momentum');
  // every gene has bounds and is used
  assert.deepEqual(Object.keys(GENOME_BOUNDS).sort(), [...GENES].sort());
});

test('validateGenome: rejects missing / non-finite genes, clamps out-of-bounds values, repairs windows', () => {
  assert.equal(validateGenome(null).ok, false);
  const { takeProfitPct: _drop, ...missing } = GENOME;
  assert.match((validateGenome(missing) as { error: string }).error, /takeProfitPct/);
  assert.equal(validateGenome({ ...GENOME, stopLossPct: Number.NaN }).ok, false);
  assert.equal(validateGenome({ ...GENOME, stopLossPct: '10' }).ok, false);
  const v = validateGenome({ ...GENOME, stopLossPct: 500, positionPct: 9, maxHoldCycles: 12.6, minAgeHours: 100, maxAgeHours: 5, minChangeH1: 20, maxChangeH1: 0 });
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.genome.stopLossPct, 90);
    assert.equal(v.genome.positionPct, 0.5);
    assert.equal(v.genome.maxHoldCycles, 13);
    assert.equal(v.genome.maxAgeHours, 101);
    assert.equal(v.genome.maxChangeH1, 20);
    assert.ok(['stopLossPct', 'positionPct', 'maxHoldCycles', 'maxAgeHours', 'maxChangeH1'].every((k) => v.clamped.includes(k)));
  }
});

test('momentum gates and arena rankings in the trader strategy', () => {
  const rules = { ...readConfig({}, []).strategy, minChangeH1: 0, maxChangeH1: 50, minChangeM5: -2, minChangeH24: -10, maxAgeHours: 500 };
  assert.deepEqual(riskGates(makeToken({ priceChange: { m5: 1, h1: 10, h24: 5 } }), rules), []);
  assert.ok(riskGates(makeToken({ priceChange: { h1: -1 } }), rules).some((f) => f.startsWith('1h change')));
  assert.ok(riskGates(makeToken({ priceChange: { h1: 80 } }), rules).some((f) => f.includes('> 50%')));
  assert.ok(riskGates(makeToken({ priceChange: { m5: -5 } }), rules).some((f) => f.startsWith('5m change')));
  assert.ok(riskGates(makeToken({ priceChange: { h24: -50 } }), rules).some((f) => f.startsWith('24h change')));
  assert.ok(riskGates(makeToken({ ageHours: 900 }), rules).some((f) => f.includes('> 500h')));
  assert.deepEqual(riskGates(makeToken({ priceChange: {} }), rules), [], 'absent fields skip the gate');
  const young = makeToken({ mint: 'Y', ageHours: 30 });
  const old = makeToken({ mint: 'O', ageHours: 300, liquidityUsd: 2_000_000 });
  assert.equal(rankCandidates([old, young], { ...rules, rankBy: 'youngest' })[0]!.token.mint, 'Y');
  assert.equal(rankCandidates([young, old], { ...rules, rankBy: 'score' })[0]!.token.mint, 'O');
  const p = normalizePair({ chainId: 'solana', pairAddress: 'P', baseToken: { address: 'M' }, priceUsd: '1', priceChange: { m5: '1.5', h1: -2, h24: '' } });
  assert.deepEqual(p!.priceChange, { m5: 1.5, h1: -2 });
});

test('resolveStrategy: static by default; arena falls back to static on missing / invalid files', async () => {
  const s = await resolveStrategy(testConfig());
  assert.equal(s.id, 'static');
  await promote(GENOME);
  assert.equal((await resolveStrategy(testConfig())).id, 'static', 'file ignored unless STRATEGY_SOURCE=arena');

  const arena = testConfig({ STRATEGY_SOURCE: 'arena' });
  const ok = await resolveStrategy(arena);
  assert.equal(ok.id, 'g-abc123def456');
  assert.equal(ok.source, 'arena');
  assert.equal(ok.exits.takeProfitPct, 20);

  fs.writeFileSync(promotionsPath(), '{ not json');
  const bad = await resolveStrategy(arena);
  assert.equal(bad.id, 'static');
  assert.ok(bad.notes[0]!.includes('missing or unreadable'));

  await writeJsonAtomic(promotionsPath(), { schema: 'something/v9' });
  assert.match((await resolveStrategy(arena)).notes[0]!, /unknown schema/);
  await writeJsonAtomic(promotionsPath(), { schema: 'mm.arena-promotions/v1', candidates: [] });
  assert.match((await resolveStrategy(arena)).notes[0]!, /no strategy is promoted/);
  await promote({ ...GENOME, stopLossPct: 'x' });
  assert.match((await resolveStrategy(arena)).notes[0]!, /invalid/);
  await promote(GENOME, {}, '../../etc');
  assert.match((await resolveStrategy(arena)).notes[0]!, /genomeId is invalid/);
  fs.rmSync(promotionsPath());
  assert.match((await resolveStrategy(arena)).notes[0]!, /missing/);
});

test('cycle with STRATEGY_SOURCE=arena applies the mapped genome, records it on positions, logs the switch', async () => {
  await promote(GENOME);
  const { report, opened } = await runCycle(deps({ STRATEGY_SOURCE: 'arena' }));
  assert.equal(report.mode, 'paper');
  assert.ok(report.notes!.includes('strategy: g-abc123def456'));
  // genome admits the 2h-old NEWB (static MIN_AGE_HOURS=24 would not) and ranks youngest first
  assert.deepEqual(opened.map((p) => p.mint), [MINTS.NEWB, MINTS.GOOD2]);
  assert.ok(opened.every((p) => p.strategyId === 'g-abc123def456' && p.exitRules?.takeProfitPct === 20 && p.exitRules.maxHoldHours === 24));
  assert.ok(opened.every((p) => p.sizeUsd === 50));
  const sw = events().filter((e) => e.type === 'strategy.switched');
  assert.equal(sw.length, 1);
  assert.deepEqual([sw[0]!.data!.from, sw[0]!.data!.to], ['static', 'g-abc123def456']);

  // static run for comparison: unchanged behaviour, positions tagged static, no frozen exits
  process.env.MM_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-solana-trader-static-'));
  const st = await runCycle(deps());
  assert.deepEqual(st.opened.map((p) => p.mint), [MINTS.GOOD1, MINTS.GOOD2]);
  assert.ok(st.opened.every((p) => p.strategyId === 'static' && p.exitRules === undefined));
  assert.ok(st.report.notes!.includes('strategy: static'));
  assert.equal(events().filter((e) => e.type === 'strategy.switched').length, 0);
});

test('a strategy switch never changes the exit rules of open positions', async () => {
  await promote(GENOME);
  await runCycle(deps({ STRATEGY_SOURCE: 'arena' }));
  // new promoted genome with a far take-profit; GOOD2 +30 % must still close at the frozen TP 20 %
  await promote({ ...GENOME, takeProfitPct: 400 }, {}, 'g-000000000002');
  const r = await runCycle(deps({ STRATEGY_SOURCE: 'arena' }, 1, { [MINTS.GOOD2]: 0.84 * 1.3 }));
  assert.deepEqual(r.closed.map((p) => [p.mint, p.exitReason]), [[MINTS.GOOD2, 'take-profit']]);
  assert.ok(r.report.notes!.includes('strategy: g-000000000002'));
  assert.equal(events().filter((e) => e.type === 'strategy.switched').length, 2);
  assert.deepEqual(r.opened.map((p) => [p.mint, p.strategyId]), [[MINTS.GOOD1, 'g-000000000002']], 'freed slot filled by the new strategy');
  // switching back to static: arena-opened positions keep their frozen 24h max-hold (static would be 48h)
  const back = await runCycle(deps({}, 25));
  assert.deepEqual(back.closed.map((p) => [p.mint, p.exitReason]), [[MINTS.NEWB, 'max-hold'], [MINTS.GOOD1, 'max-hold']]);
  assert.ok(back.report.notes!.includes('strategy: static'));
});

test('falls back to static on a bad promotions file and still trades with the static rules', async () => {
  fs.mkdirSync(path.dirname(promotionsPath()), { recursive: true });
  fs.writeFileSync(promotionsPath(), '{"schema":"mm.arena-promotions/v1","promoted":{"genomeId":"g-1","genome":{"rankBy":1}}}');
  const { report, opened } = await runCycle(deps({ STRATEGY_SOURCE: 'arena' }));
  assert.ok(report.notes!.includes('strategy: static'));
  assert.ok(report.notes!.some((n) => n.includes('using the static strategy')));
  assert.deepEqual(opened.map((p) => p.mint), [MINTS.GOOD1, MINTS.GOOD2]);
});

test('entry cooldown (from cooldownCycles) blocks new entries after a close', async () => {
  await promote({ ...GENOME, cooldownCycles: 24 }); // 2 h
  await runCycle(deps({ STRATEGY_SOURCE: 'arena' }));
  const r = await runCycle(deps({ STRATEGY_SOURCE: 'arena' }, 1, { [MINTS.GOOD2]: 0.84 * 0.8 }));
  assert.equal(r.closed.length, 1);
  assert.equal(r.opened.length, 0);
  assert.ok(r.report.notes!.some((n) => n.startsWith('entry cooldown')));
});

test('PROMOTION NEVER ENABLES LIVE TRADING: STRATEGY_SOURCE=arena cannot change the mode', async () => {
  // a promotions file that tries to smuggle mode settings in
  await promote(GENOME, { mode: 'live', MODE: 'live', LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE });
  for (const env of [{}, { MODE: 'live' }, { MODE: 'paper' }, { MODE: 'dry-run' }, { LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE }] as Array<Record<string, string>>) {
    const withArena = resolveMode({ ...env, STRATEGY_SOURCE: 'arena' }, []);
    assert.deepEqual(withArena, resolveMode(env, []), JSON.stringify(env));
    assert.equal(readConfig({ ...env, STRATEGY_SOURCE: 'arena' }, []).mode, readConfig(env, []).mode);
  }
  assert.equal(readConfig({ STRATEGY_SOURCE: 'arena' }, []).mode, 'paper');
  // and through a full cycle: still paper, paper fills, never the live positions file
  const { report, opened } = await runCycle(deps({ STRATEGY_SOURCE: 'arena', MODE: 'live' }));
  assert.equal(report.mode, 'paper');
  assert.ok(opened.length > 0 && opened.every((p) => p.simulated && p.mode === 'paper'));
  assert.ok(fs.existsSync(positionsPath('paper')));
  assert.equal(fs.existsSync(positionsPath('live')), false);
  const dry = await runCycle(deps({ STRATEGY_SOURCE: 'arena', MODE: 'dry-run' }));
  assert.equal(dry.report.mode, 'dry-run');
  assert.equal(dry.opened.length, 0);
});

test('contract: a promotions.json produced by agent-arena (fixtures/arena-promotions.json) is accepted unchanged', async () => {
  const file = loadFixture<{ promoted: { genomeId: string; genome: Record<string, number> } }>('arena-promotions.json');
  await writeJsonAtomic(promotionsPath(), file);
  const s = await resolveStrategy(testConfig({ STRATEGY_SOURCE: 'arena' }));
  assert.equal(s.source, 'arena');
  assert.equal(s.id, file.promoted.genomeId);
  assert.equal(s.exits.takeProfitPct, file.promoted.genome.takeProfitPct);
  assert.ok(!s.notes.some((n) => n.includes('clamped')), 'arena genomes are already within bounds');
});
