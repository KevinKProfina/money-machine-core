import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';
import { LiveExecutor, PaperExecutor, paperOptionsFromConfig, winProbability, type PaperExecutorOptions } from './executor.js';
import { evaluateGates } from './gates.js';
import { computeEconomics } from './math.js';
import { deriveSeed, mulberry32 } from './rng.js';
import { SimulatedSource } from './sources/simulated.js';
import type { Opportunity } from './types.js';

const opp: Opportunity = {
  position: {
    id: 'p',
    protocol: 'kamino',
    chain: 'solana',
    borrower: 'SIMx',
    collateralSymbol: 'SOL',
    debtSymbol: 'USDC',
    collateralUsd: 10_000,
    debtUsd: 8_500,
    liquidationThreshold: 0.825,
    liquidationBonus: 0.05,
    closeFactor: 0.5,
    gasCostUsd: 1,
    collateralVolatility: 0.9,
    observedAt: '2026-01-01T00:00:00Z',
    simulated: true,
  },
  economics: {
    healthFactor: 0.97,
    ltv: 0.85,
    liquidatable: true,
    repayUsd: 2_000,
    collateralSeizedUsd: 2_100,
    grossProfitUsd: 100,
    gasUsd: 1,
    slippageUsd: 6.3,
    flashLoanFeeUsd: 0,
    netProfitUsd: 92.7,
    netReturn: 0.046,
    gasShare: 0.01,
    riskScore: 40,
  },
};

const opts = (over: Partial<PaperExecutorOptions> = {}): PaperExecutorOptions => ({
  ...paperOptionsFromConfig(loadConfig({})),
  ...over,
});

const noFriction: Partial<PaperExecutorOptions> = {
  baseWinProbability: 1,
  competitionRefUsd: 1e12,
  competitionSizeRefUsd: 1e12,
  txFailureProbability: 0,
  maxAdverseSlippageBps: 0,
  maxGasSpikeMultiplier: 1,
  priceMoveHorizonSec: 0,
  adverseSelectionFraction: 0,
  tailLossProbability: 0,
};

test('paper executor: deterministic for a seed, never emits a tx signature', async () => {
  const run = async (seed: number) => {
    const ex = new PaperExecutor(mulberry32(seed), opts());
    const out = [];
    for (let i = 0; i < 50; i++) out.push(await ex.execute(opp));
    return out;
  };
  const a = await run(5);
  assert.deepEqual(a, await run(5));
  for (const o of a) assert.equal(o.txSignature, undefined);
});

test('win probability falls with net profit and size', () => {
  const o = opts();
  const small = winProbability(10, 500, o);
  assert.ok(small > winProbability(200, 500, o));
  assert.ok(small > winProbability(10, 50_000, o));
  assert.ok(small <= o.baseWinProbability);
  // large juicy opportunities are almost always taken by others
  assert.ok(winProbability(1_000, 50_000, o) < 0.03);
  assert.equal(winProbability(-5, 0, o), o.baseWinProbability);
});

test('paper executor: lost races cost gas; fills can lose money', async () => {
  const ex = new PaperExecutor(mulberry32(11), opts());
  const out = [];
  for (let i = 0; i < 2000; i++) out.push(await ex.execute(opp));
  const failed = out.filter((o) => o.status === 'failed');
  const filled = out.filter((o) => o.status === 'success');
  assert.ok(failed.length > filled.length, 'competition should win most races');
  assert.ok(filled.length > 0);
  for (const f of failed) {
    assert.ok(f.realizedPnlUsd < 0);
    assert.match(f.failureReason ?? '', /^simulated:/);
  }
  assert.ok(filled.some((s) => s.realizedPnlUsd < 0), 'some fills must lose money');
  assert.ok(filled.some((s) => /tail loss/.test(s.failureReason ?? '')), 'tail losses must occur');
});

test('paper executor: frictionless fill equals expected economics; always-lose pays gas', async () => {
  const never = new PaperExecutor(mulberry32(1), opts(noFriction));
  const r = await never.execute(opp);
  assert.equal(r.status, 'success');
  assert.ok(Math.abs(r.realizedPnlUsd - 92.7) < 1e-9);
  const lose = new PaperExecutor(mulberry32(1), opts({ ...noFriction, baseWinProbability: 0, revertGasFraction: 0.5 }));
  const l = await lose.execute(opp);
  assert.equal(l.status, 'failed');
  assert.ok(Math.abs(l.realizedPnlUsd + 0.5) < 1e-9);
});

test('calibration: 200 seeded cycles are roughly break-even, with losses', async () => {
  const config = loadConfig({});
  const source = new SimulatedSource(config.simSeed, config.simPositionsPerCycle);
  const limits = {
    minNetProfitUsd: config.minNetProfitUsd,
    sizeCapUsd: Math.min(config.maxLiquidationSizeUsd, config.startingCapitalUsd),
    maxGasShare: config.maxGasShare,
    maxRiskScore: config.maxRiskScore,
  };
  const returns: number[] = [];
  let losses = 0;
  for (let cycle = 1; cycle <= 200; cycle++) {
    const ex = new PaperExecutor(mulberry32(deriveSeed(config.simSeed, cycle, 0xe8ec)), paperOptionsFromConfig(config));
    const candidates = source
      .generate(cycle, new Date(0))
      .map((position) => ({
        position,
        economics: computeEconomics(position, {
          collateralSlippageBps: config.collateralSlippageBps,
          useFlashLoan: config.useFlashLoan,
          flashLoanFeeBps: config.flashLoanFeeBps,
          maxRepayUsd: limits.sizeCapUsd,
        }),
      }))
      .filter((o) => evaluateGates(o.economics, limits).passed)
      .sort((a, b) => b.economics.netProfitUsd - a.economics.netProfitUsd)
      .slice(0, config.maxExecutionsPerCycle);
    for (const c of candidates) {
      const out = await ex.execute(c);
      returns.push(out.realizedPnlUsd / c.economics.repayUsd);
      if (out.realizedPnlUsd < 0) losses++;
    }
  }
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  assert.ok(returns.length > 100, `attempts=${returns.length}`);
  assert.ok(meanReturn <= 0.003, `mean return per attempt ${meanReturn}`);
  assert.ok(meanReturn > -0.05, `mean return per attempt ${meanReturn} implausibly bad`);
  assert.ok(losses > returns.length / 2, `losses=${losses}/${returns.length}`);
  assert.ok(Math.min(...returns) < -0.03, 'expected at least one large loss');
});

test('live executor is not implemented', async () => {
  await assert.rejects(() => new LiveExecutor().execute(opp), /not implemented/);
});
