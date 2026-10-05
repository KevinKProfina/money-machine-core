import type { Config } from './config.js';
import type { Rng } from './rng.js';
import type { Opportunity } from './types.js';

export type ExecutionOutcome = {
  status: 'success' | 'failed';
  realizedPnlUsd: number;
  gasPaidUsd: number;
  adverseSlippageBps: number;
  failureReason?: string;
  /** Only a live executor may set this, from a confirmed on-chain transaction. */
  txSignature?: string;
};

export interface Executor {
  readonly id: string;
  readonly simulated: boolean;
  execute(opp: Opportunity): Promise<ExecutionOutcome>;
}

export type PaperExecutorOptions = {
  /** Win probability against competing searchers for a tiny opportunity. */
  baseWinProbability: number;
  /** pWin = base / (1 + netProfit / competitionRefUsd + repay / competitionSizeRefUsd). */
  competitionRefUsd: number;
  competitionSizeRefUsd: number;
  /** Probability our tx fails even when nobody beats us (revert, dropped, healed). */
  txFailureProbability: number;
  /** Fraction of the gas estimate paid by a reverted / losing tx. */
  revertGasFraction: number;
  /** Gas actually paid = estimate * uniform(1, max). */
  maxGasSpikeMultiplier: number;
  /** Expected sale slippage already in the economics, bps. */
  expectedSlippageBps: number;
  /** Extra adverse slippage on the collateral sale, uniform in [0, max] bps. */
  maxAdverseSlippageBps: number;
  /** Seconds between detection and finishing the collateral sale (price-move horizon). */
  priceMoveHorizonSec: number;
  /**
   * Winner's curse: when we win, the realizable market price of the collateral is
   * on average this fraction of the liquidation bonus below the oracle price
   * (better-informed searchers passed on it). Exponentially distributed.
   */
  adverseSelectionFraction: number;
  /** Probability of a large loss (collateral dumped into thin liquidity / depeg). */
  tailLossProbability: number;
  /** Tail loss as a fraction of seized collateral, uniform in [min, max]. */
  tailLossMin: number;
  tailLossMax: number;
};

const SECONDS_PER_YEAR = 365 * 24 * 3600;

export function paperOptionsFromConfig(config: Config): PaperExecutorOptions {
  return {
    baseWinProbability: config.paperBaseWinProbability,
    competitionRefUsd: config.competitionRefUsd,
    competitionSizeRefUsd: config.competitionSizeRefUsd,
    txFailureProbability: config.paperTxFailureProbability,
    revertGasFraction: config.paperRevertGasFraction,
    maxGasSpikeMultiplier: config.paperMaxGasSpikeMultiplier,
    expectedSlippageBps: config.collateralSlippageBps,
    maxAdverseSlippageBps: config.paperMaxAdverseSlippageBps,
    priceMoveHorizonSec: config.paperPriceMoveHorizonSec,
    adverseSelectionFraction: config.paperAdverseSelectionFraction,
    tailLossProbability: config.paperTailLossProbability,
    tailLossMin: config.paperTailLossMin,
    tailLossMax: config.paperTailLossMax,
  };
}

/** Probability that we (not a competing searcher) land the liquidation. */
export function winProbability(netProfitUsd: number, repayUsd: number, o: PaperExecutorOptions): number {
  const juice = Math.max(0, netProfitUsd) / Math.max(1e-9, o.competitionRefUsd);
  const size = Math.max(0, repayUsd) / Math.max(1e-9, o.competitionSizeRefUsd);
  return Math.min(1, Math.max(0, o.baseWinProbability / (1 + juice + size)));
}

function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Paper executor: simulates a liquidation race. Results are labelled simulated and
 * are NOT guaranteed profitable:
 * - professional searchers take most opportunities, especially large/juicy ones;
 *   a lost race is a reverted tx that still pays (part of) the gas;
 * - a won fill suffers adverse selection, price moves until the collateral is
 *   sold, extra slippage, gas spikes and occasional large tail losses.
 * No tx is sent and no tx signature is ever produced.
 */
export class PaperExecutor implements Executor {
  readonly id = 'paper';
  readonly simulated = true;

  constructor(
    private readonly rng: Rng,
    private readonly opts: PaperExecutorOptions,
  ) {}

  async execute(opp: Opportunity): Promise<ExecutionOutcome> {
    const o = this.opts;
    const e = opp.economics;
    const gasFull = e.gasUsd * (1 + (Math.max(1, o.maxGasSpikeMultiplier) - 1) * this.rng());

    const pWin = winProbability(e.netProfitUsd, e.repayUsd, o);
    if (this.rng() >= pWin) {
      const gasPaidUsd = gasFull * o.revertGasFraction;
      return {
        status: 'failed',
        realizedPnlUsd: -gasPaidUsd,
        gasPaidUsd,
        adverseSlippageBps: 0,
        failureReason: 'simulated: competing liquidator landed first (tx reverted)',
      };
    }
    if (this.rng() < o.txFailureProbability) {
      const gasPaidUsd = gasFull * o.revertGasFraction;
      return {
        status: 'failed',
        realizedPnlUsd: -gasPaidUsd,
        gasPaidUsd,
        adverseSlippageBps: 0,
        failureReason: 'simulated: transaction reverted / position healed before inclusion',
      };
    }

    const bonus = opp.position.liquidationBonus;
    // Winner's curse: exponential discount of the market price vs the oracle price.
    const adverseSelection = -Math.log(Math.max(1 - this.rng(), 1e-12)) * o.adverseSelectionFraction * bonus;
    // Price move until the seized collateral is sold.
    const sigma = opp.position.collateralVolatility * Math.sqrt(Math.max(0, o.priceMoveHorizonSec) / SECONDS_PER_YEAR);
    const priceMove = sigma * gaussian(this.rng);
    const adverseSlippageBps = o.maxAdverseSlippageBps * this.rng();
    const tail = this.rng() < o.tailLossProbability ? o.tailLossMin + (o.tailLossMax - o.tailLossMin) * this.rng() : 0;

    const priceFactor = Math.max(0, 1 - adverseSelection + priceMove - tail);
    const saleFactor = Math.max(0, 1 - (o.expectedSlippageBps + adverseSlippageBps) / 10_000);
    const saleProceeds = e.collateralSeizedUsd * priceFactor * saleFactor;
    const realizedPnlUsd = saleProceeds - e.repayUsd - e.flashLoanFeeUsd - gasFull;
    return {
      status: 'success',
      realizedPnlUsd,
      gasPaidUsd: gasFull,
      adverseSlippageBps,
      ...(tail > 0 ? { failureReason: `simulated: tail loss ${(tail * 100).toFixed(1)} % on collateral sale` } : {}),
    };
  }
}

/** Placeholder: live execution is not implemented and must never be used. */
export class LiveExecutor implements Executor {
  readonly id = 'live';
  readonly simulated = false;
  async execute(_opp: Opportunity): Promise<ExecutionOutcome> {
    throw new Error('Live executor is not implemented');
  }
}
