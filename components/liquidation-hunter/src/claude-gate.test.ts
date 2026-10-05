import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeGate, parseVerdict, type BetaMessagesClient } from './claude-gate.js';
import type { Opportunity } from './types.js';

const opp = {
  position: {
    id: 'p',
    protocol: 'save',
    chain: 'solana',
    borrower: 'SIMx',
    collateralSymbol: 'SOL',
    debtSymbol: 'USDC',
    collateralUsd: 1000,
    debtUsd: 900,
    liquidationThreshold: 0.85,
    liquidationBonus: 0.05,
    closeFactor: 0.2,
    gasCostUsd: 0.1,
    collateralVolatility: 0.9,
    observedAt: '2026-01-01T00:00:00Z',
    simulated: true,
  },
  economics: {
    healthFactor: 0.944,
    ltv: 0.9,
    liquidatable: true,
    repayUsd: 180,
    collateralSeizedUsd: 189,
    grossProfitUsd: 9,
    gasUsd: 0.1,
    slippageUsd: 0.57,
    flashLoanFeeUsd: 0,
    netProfitUsd: 8.33,
    netReturn: 0.046,
    gasShare: 0.011,
    riskScore: 30,
  },
} satisfies Opportunity;

const fake = (response: unknown, capture?: (p: any) => void): BetaMessagesClient => ({
  beta: {
    messages: {
      create: async (p: any) => {
        capture?.(p);
        if (response instanceof Error) throw response;
        return response;
      },
    },
  },
});

test('parseVerdict is strict', () => {
  assert.equal(parseVerdict('EXECUTE: fine').decision, 'execute');
  assert.equal(parseVerdict('execute: fine').decision, 'execute');
  assert.equal(parseVerdict('"EXECUTE: ok"').decision, 'execute');
  assert.equal(parseVerdict('SKIP: too risky').decision, 'skip');
  assert.equal(parseVerdict('').decision, 'skip');
  assert.equal(parseVerdict('Maybe EXECUTE').decision, 'skip');
  assert.equal(parseVerdict('EXECUTE: a\nSKIP: b').decision, 'skip');
  assert.equal(parseVerdict('I think you should EXECUTE: yes').decision, 'skip');
});

test('ClaudeGate sends the brief-mandated request and reads text blocks', async () => {
  let params: any;
  const gate = new ClaudeGate(
    fake({ stop_reason: 'end_turn', content: [{ type: 'thinking' }, { type: 'text', text: 'EXECUTE: margin ok' }] }, (p) => (params = p)),
  );
  const v = await gate.review(opp);
  assert.equal(v.decision, 'execute');
  assert.equal(params.model, 'claude-opus-5-5');
  assert.equal(params.max_tokens, 2000);
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.output_config, { effort: 'low' });
});

test('ClaudeGate: refusal, errors and garbage are SKIP', async () => {
  assert.equal((await new ClaudeGate(fake({ stop_reason: 'refusal', content: [{ type: 'text', text: 'EXECUTE: x' }] })).review(opp)).decision, 'skip');
  assert.equal((await new ClaudeGate(fake(new Error('timeout'))).review(opp)).decision, 'skip');
  assert.equal((await new ClaudeGate(fake({ stop_reason: 'end_turn', content: [] })).review(opp)).decision, 'skip');
  assert.equal((await new ClaudeGate(fake(null)).review(opp)).decision, 'skip');
});
