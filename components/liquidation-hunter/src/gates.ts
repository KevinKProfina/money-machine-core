import type { Economics, GateCheck, GateResult } from './types.js';

export type GateLimits = {
  minNetProfitUsd: number;
  /** min(MAX_LIQUIDATION_SIZE_USD, available budget). */
  sizeCapUsd: number;
  maxGasShare: number;
  maxRiskScore: number;
};

/** Deterministic, ordered gates. All checks are evaluated; reason lists the failures. */
export function evaluateGates(e: Economics, limits: GateLimits): GateResult {
  const checks: GateCheck[] = [
    {
      gate: 'liquidatable',
      passed: e.liquidatable,
      detail: `health factor ${fmt(e.healthFactor, 4)} ${e.liquidatable ? '<' : '>='} 1`,
    },
    {
      gate: 'size',
      passed: limits.sizeCapUsd > 0 && e.repayUsd > 0 && e.repayUsd <= limits.sizeCapUsd + 1e-9,
      detail:
        limits.sizeCapUsd <= 0
          ? 'no budget available'
          : `repay $${fmt(e.repayUsd)} within cap $${fmt(limits.sizeCapUsd)}`,
    },
    {
      gate: 'min-net-profit',
      passed: e.netProfitUsd >= limits.minNetProfitUsd,
      detail: `net $${fmt(e.netProfitUsd)} vs min $${fmt(limits.minNetProfitUsd)}`,
    },
    {
      gate: 'gas-share',
      passed: Number.isFinite(e.gasShare) && e.gasShare <= limits.maxGasShare,
      detail: `gas ${Number.isFinite(e.gasShare) ? fmt(e.gasShare * 100, 1) + ' %' : 'n/a'} of gross vs max ${fmt(limits.maxGasShare * 100, 1)} %`,
    },
    {
      gate: 'risk-score',
      passed: e.riskScore <= limits.maxRiskScore,
      detail: `risk ${fmt(e.riskScore, 1)} vs max ${fmt(limits.maxRiskScore, 1)}`,
    },
  ];
  const failed = checks.filter((c) => !c.passed);
  return {
    passed: failed.length === 0,
    checks,
    reason: failed.length === 0 ? 'all gates passed' : failed.map((c) => `${c.gate}: ${c.detail}`).join('; '),
  };
}

function fmt(x: number, digits = 2): string {
  return Number.isFinite(x) ? x.toFixed(digits) : String(x);
}
