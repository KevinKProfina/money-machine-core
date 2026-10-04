import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerceGenome, isWithinBounds, mutateGene } from './genome.js';
import { Rng } from './rng.js';
import { TRADER_GENOME, traderSpecies } from './species/trader.js';

test('random trader genomes are within bounds and consistent', () => {
  const rng = new Rng(1);
  for (let i = 0; i < 2000; i++) {
    const g = traderSpecies.randomGenome(rng);
    assert.ok(isWithinBounds(TRADER_GENOME, g), JSON.stringify(g));
    assert.ok(g.maxAgeHours! >= g.minAgeHours! + 1 - 1e-9);
    assert.ok(g.maxChangeH1! >= g.minChangeH1!);
    assert.ok(Number.isInteger(g.maxOpenPositions) && Number.isInteger(g.rankBy) && Number.isInteger(g.maxHoldCycles));
  }
});

test('mutation stays within bounds even at rate 1 over many generations', () => {
  const rng = new Rng(2);
  let g = traderSpecies.randomGenome(rng);
  for (let i = 0; i < 5000; i++) {
    g = traderSpecies.mutate(g, rng, 1);
    assert.ok(isWithinBounds(TRADER_GENOME, g), `gen ${i}: ${JSON.stringify(g)}`);
  }
});

test('mutation rate 0 keeps the genome; rate > 0 changes it', () => {
  const rng = new Rng(3);
  const g = traderSpecies.randomGenome(rng);
  assert.deepEqual(traderSpecies.mutate(g, rng, 0), g);
  const m = traderSpecies.mutate(g, rng, 0.5);
  assert.notDeepEqual(m, g);
});

test('integer genes always move by at least one step when mutated', () => {
  const rng = new Rng(4);
  const spec = TRADER_GENOME.maxOpenPositions!;
  for (let i = 0; i < 200; i++) {
    const v = mutateGene(spec, 5, rng, 0.0001);
    assert.ok(Number.isInteger(v) && v !== 5);
  }
});

test('crossover only uses parent values', () => {
  const rng = new Rng(5);
  const a = traderSpecies.randomGenome(rng);
  const b = traderSpecies.randomGenome(rng);
  const c = traderSpecies.crossover!(a, b, rng);
  for (const k of Object.keys(TRADER_GENOME)) {
    if (k === 'maxAgeHours' || k === 'maxChangeH1') continue; // may be repaired
    assert.ok(c[k] === a[k] || c[k] === b[k], k);
  }
});

test('validate clamps out-of-range values, fills missing genes and repairs inconsistencies', () => {
  const fill = traderSpecies.randomGenome(new Rng(6));
  const res = traderSpecies.validate({ positionPct: 5, stopLossPct: -3, minAgeHours: 100, maxAgeHours: 10, rankBy: 2.7, minLiquidityUsd: '20000' }, fill);
  assert.equal(res.genome.positionPct, 0.5);
  assert.equal(res.genome.stopLossPct, 1);
  assert.equal(res.genome.rankBy, 3);
  assert.equal(res.genome.minLiquidityUsd, 20000);
  assert.ok(res.genome.maxAgeHours! >= 101);
  assert.ok(res.clamped.includes('positionPct') && res.clamped.includes('maxAgeHours'));
  assert.ok(res.missing.includes('takeProfitPct'));
  assert.equal(res.genome.takeProfitPct, fill.takeProfitPct);
  assert.ok(isWithinBounds(TRADER_GENOME, res.genome));
});

test('coerceGenome treats non-objects as all-missing', () => {
  const r = coerceGenome(TRADER_GENOME, 'nope', {});
  assert.equal(r.missing.length, Object.keys(TRADER_GENOME).length);
  assert.ok(isWithinBounds(TRADER_GENOME, r.genome));
});

test('rng is deterministic per seed and state round-trips', () => {
  const a = new Rng('x');
  const b = new Rng('x');
  const seq = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(seq, Array.from({ length: 5 }, () => b.next()));
  const c = new Rng(a.state);
  assert.equal(c.next(), a.next());
});
