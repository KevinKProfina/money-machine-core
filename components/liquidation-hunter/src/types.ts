import type { RunMode } from './mm-contract.js';

export type Chain = 'solana' | 'ethereum';
export type ProtocolId = 'aave-v3' | 'kamino' | 'marginfi' | 'save';

/** A borrower position on a lending protocol, as reported by an OpportunitySource. */
export type LendingPosition = {
  id: string;
  protocol: ProtocolId;
  chain: Chain;
  borrower: string;
  collateralSymbol: string;
  debtSymbol: string;
  /** USD value of the borrower's collateral. */
  collateralUsd: number;
  /** USD value of the borrower's debt. */
  debtUsd: number;
  /** Liquidation threshold as a fraction (0.825 = 82.5 %). */
  liquidationThreshold: number;
  /** Liquidation bonus as a fraction (0.05 = 5 % extra collateral). */
  liquidationBonus: number;
  /** Max fraction of the debt repayable in one liquidation call. */
  closeFactor: number;
  /** Estimated USD gas / priority-fee cost of the liquidation tx. */
  gasCostUsd: number;
  /** Annualized volatility of the collateral asset, fraction (0.8 = 80 %). */
  collateralVolatility: number;
  observedAt: string;
  /** True when the position does not come from a real chain. */
  simulated: boolean;
};

export type CostParams = {
  /** Expected slippage when selling seized collateral, in bps. */
  collateralSlippageBps: number;
  /** Whether the repay amount is flash-borrowed. */
  useFlashLoan: boolean;
  /** Flash-loan fee in bps of the borrowed amount. */
  flashLoanFeeBps: number;
  /** Hard cap on the repay amount (size limit / budget), USD. */
  maxRepayUsd: number;
};

export type Economics = {
  healthFactor: number;
  ltv: number;
  liquidatable: boolean;
  repayUsd: number;
  collateralSeizedUsd: number;
  grossProfitUsd: number;
  gasUsd: number;
  slippageUsd: number;
  flashLoanFeeUsd: number;
  netProfitUsd: number;
  /** Net profit as a fraction of the repay amount. */
  netReturn: number;
  /** Gas cost as a fraction of gross profit (Infinity if gross <= 0). */
  gasShare: number;
  /** 0 (low) .. 100 (high). */
  riskScore: number;
};

export type Opportunity = { position: LendingPosition; economics: Economics };

export type GateCheck = { gate: string; passed: boolean; detail: string };
export type GateResult = { passed: boolean; checks: GateCheck[]; reason: string };

/** A decision record: every opportunity that was evaluated and NOT executed. */
export type DecisionRecord = {
  id: string;
  ts: string;
  cycle: number;
  mode: RunMode;
  opportunityId: string;
  protocol: ProtocolId;
  decision: 'skip' | 'would_execute';
  stage: 'gates' | 'claude' | 'limit' | 'dry-run' | 'halted';
  reason: string;
  expectedNetProfitUsd: number;
  repayUsd: number;
  riskScore: number;
  simulated: boolean;
};

/** An execution record: an attempted liquidation (paper or live). */
export type ExecutionRecord = {
  id: string;
  ts: string;
  cycle: number;
  mode: RunMode;
  executor: string;
  /** True for paper fills. Live fills would carry a real tx signature. */
  simulated: boolean;
  opportunityId: string;
  protocol: ProtocolId;
  status: 'success' | 'failed';
  repayUsd: number;
  expectedNetProfitUsd: number;
  /** Realized PnL in USD (negative on failure: gas is still paid). */
  realizedPnlUsd: number;
  gasPaidUsd: number;
  adverseSlippageBps: number;
  failureReason?: string;
  /** Only set by a live executor from a confirmed transaction. Never fabricated. */
  txSignature?: string;
};
