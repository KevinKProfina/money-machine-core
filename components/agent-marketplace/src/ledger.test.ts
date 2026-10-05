import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentAccount,
  balanceOf,
  checkInvariants,
  computeSettlement,
  deposit,
  ESCROW,
  EXTERNAL,
  holdEscrow,
  LedgerError,
  PLATFORM,
  refund,
  settleSuccess,
  transfer,
  validateSplits,
} from './ledger.ts';
import { emptyState, type Job } from './types.ts';

function job(id: string, requester: string, provider: string, priceUsd: number): Job {
  return { id, serviceId: 'svc', requesterAgentId: requester, providerAgentId: provider, input: null, status: 'queued', priceUsd, timings: { createdAt: new Date().toISOString() } };
}

function totalInternal(state: ReturnType<typeof emptyState>): number {
  return Object.entries(state.balances).filter(([k]) => k !== EXTERNAL).reduce((a, [, v]) => a + v, 0);
}

test('deposits create money only against the external account', () => {
  const s = emptyState();
  deposit(s, 'a', 5_000_000);
  deposit(s, 'b', 2_500_000);
  assert.equal(balanceOf(s, agentAccount('a')), 5_000_000);
  assert.equal(balanceOf(s, EXTERNAL), -7_500_000);
  assert.deepEqual(checkInvariants(s), []);
});

test('transfer rejects overdraft and invalid amounts', () => {
  const s = emptyState();
  deposit(s, 'a', 1_000);
  assert.throws(() => transfer(s, 'escrow_hold', agentAccount('a'), ESCROW, 1_001), (e: unknown) => e instanceof LedgerError && e.code === 'insufficient_funds');
  assert.throws(() => transfer(s, 'escrow_hold', agentAccount('a'), ESCROW, 1.5), LedgerError);
  assert.throws(() => transfer(s, 'escrow_hold', agentAccount('a'), ESCROW, -1), LedgerError);
  assert.equal(balanceOf(s, agentAccount('a')), 1_000);
});

test('escrow success: fee to platform, rest to provider, total conserved', () => {
  const s = emptyState();
  deposit(s, 'buyer', 10_000_000);
  const j = job('j1', 'buyer', 'seller', 1.23);
  holdEscrow(s, j);
  s.jobs[j.id] = j;
  assert.equal(balanceOf(s, ESCROW), 1_230_000);
  assert.deepEqual(checkInvariants(s), []);
  const before = totalInternal(s);
  j.status = 'completed';
  const st = settleSuccess(s, j, 10, []);
  assert.equal(st.feeMicros, 123_000);
  assert.equal(balanceOf(s, PLATFORM), 123_000);
  assert.equal(balanceOf(s, agentAccount('seller')), 1_107_000);
  assert.equal(balanceOf(s, ESCROW), 0);
  assert.equal(balanceOf(s, agentAccount('buyer')), 8_770_000);
  assert.equal(totalInternal(s), before);
  assert.deepEqual(checkInvariants(s), []);
});

test('escrow failure: full refund to requester', () => {
  const s = emptyState();
  deposit(s, 'buyer', 2_000_000);
  const j = job('j2', 'buyer', 'seller', 2);
  holdEscrow(s, j);
  s.jobs[j.id] = j;
  assert.equal(balanceOf(s, agentAccount('buyer')), 0);
  refund(s, j);
  j.status = 'refunded';
  assert.equal(balanceOf(s, agentAccount('buyer')), 2_000_000);
  assert.equal(balanceOf(s, agentAccount('seller')), 0);
  assert.equal(balanceOf(s, PLATFORM), 0);
  assert.deepEqual(checkInvariants(s), []);
  assert.deepEqual(s.ledger.map((e) => e.type), ['deposit', 'escrow_hold', 'refund']);
});

test('invariant checker detects tampering and stray escrow', () => {
  const s = emptyState();
  deposit(s, 'a', 100);
  s.balances[agentAccount('a')] = 200;
  assert.ok(checkInvariants(s).some((p) => p.includes('mismatch')));
  const s2 = emptyState();
  deposit(s2, 'a', 100);
  transfer(s2, 'escrow_hold', agentAccount('a'), ESCROW, 50); // no job backs it
  assert.ok(checkInvariants(s2).some((p) => p.startsWith('escrow')));
});

test('revenue splits: fee first, splits of net, provider keeps remainder exactly', () => {
  const st = computeSettlement(1_000_000, 10, [
    { agentId: 'ref', pct: 10 },
    { agentId: 'up', pct: 25 },
  ]);
  assert.equal(st.feeMicros, 100_000);
  assert.deepEqual(st.splits, [
    { agentId: 'ref', micros: 90_000 },
    { agentId: 'up', micros: 225_000 },
  ]);
  assert.equal(st.providerMicros, 585_000);
  assert.equal(st.feeMicros + st.providerMicros + st.splits.reduce((a, p) => a + p.micros, 0), 1_000_000);

  // rounding dust goes to the provider, sum always exact
  const odd = computeSettlement(7, 33.33, [{ agentId: 'x', pct: 33.33 }, { agentId: 'y', pct: 33.33 }]);
  assert.equal(odd.feeMicros + odd.providerMicros + odd.splits.reduce((a, p) => a + p.micros, 0), 7);
});

test('revenue splits settle through the ledger and conserve money', () => {
  const s = emptyState();
  deposit(s, 'buyer', 5_000_000);
  const j = job('j3', 'buyer', 'seller', 1);
  holdEscrow(s, j);
  s.jobs[j.id] = j;
  j.status = 'completed';
  settleSuccess(s, j, 10, [{ agentId: 'ref', pct: 20 }]);
  assert.equal(balanceOf(s, agentAccount('ref')), 180_000);
  assert.equal(balanceOf(s, agentAccount('seller')), 720_000);
  assert.equal(balanceOf(s, PLATFORM), 100_000);
  assert.deepEqual(checkInvariants(s), []);
});

test('split validation: sum <= 100, positive, unique, bounded count', () => {
  assert.doesNotThrow(() => validateSplits([{ agentId: 'a', pct: 60 }, { agentId: 'b', pct: 40 }]));
  assert.throws(() => validateSplits([{ agentId: 'a', pct: 60 }, { agentId: 'b', pct: 40.01 }]), /more than 100/);
  assert.throws(() => validateSplits([{ agentId: 'a', pct: 0 }]), LedgerError);
  assert.throws(() => validateSplits([{ agentId: 'a', pct: 10 }, { agentId: 'a', pct: 10 }]), /duplicate/);
  assert.throws(() => validateSplits(Array.from({ length: 6 }, (_, i) => ({ agentId: `a${i}`, pct: 1 }))), /at most/);
});

test('randomized escrow sequences keep invariants', () => {
  const s = emptyState();
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const agents = ['a', 'b', 'c', 'd'];
  for (const a of agents) deposit(s, a, 3_000_000);
  for (let i = 0; i < 300; i++) {
    const req = agents[Math.floor(rnd() * 4)]!;
    const prov = agents[Math.floor(rnd() * 4)]!;
    const j = job(`r${i}`, req, prov, Math.round(rnd() * 100) / 100);
    try {
      holdEscrow(s, j);
    } catch {
      continue;
    }
    s.jobs[j.id] = j;
    if (rnd() < 0.7) {
      j.status = 'completed';
      settleSuccess(s, j, 10, rnd() < 0.5 ? [{ agentId: 'ref', pct: 15 }] : []);
    } else {
      j.status = 'refunded';
      refund(s, j);
    }
  }
  assert.deepEqual(checkInvariants(s), []);
  assert.equal(totalInternal(s), 12_000_000);
});
