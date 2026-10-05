import type { HealthAssessment } from './health.js';
import type { AllocationProposal } from './mm-contract.js';

export const floorCents = (v: number): number => Math.floor(Math.max(0, v) * 100 + 1e-7) / 100;

export type TargetResult = {
  targets: Record<string, number>;
  source: 'proposal' | 'equal-split';
  reasons: Record<string, string>;
};

/** Validates the capital-allocator proposal; returns why it is unusable, or null if usable. */
export function proposalProblem(p: AllocationProposal | null, now: Date, staleMs: number): string | null {
  if (!p) return 'no allocation proposal';
  if (p.schema !== 'mm.allocation-proposal/v1') return 'proposal has unknown schema';
  if (!(p.totalCapitalUsd > 0)) return 'proposal total capital is not positive';
  if (!p.allocations || typeof p.allocations !== 'object') return 'proposal has no allocations';
  const ts = Date.parse(p.timestamp);
  if (!Number.isFinite(ts) || now.getTime() - ts > staleMs) return 'proposal is stale';
  return null;
}

/**
 * Desired (unsmoothed) allocation per strategy.
 * With a usable proposal: proposal share x deployable x drawdown factor.
 * Otherwise: equal split of deployable among healthy strategies.
 */
export function computeTargets(
  assessments: HealthAssessment[],
  proposal: AllocationProposal | null,
  proposalIssue: string | null,
  deployableUsd: number,
): TargetResult {
  const targets: Record<string, number> = {};
  const reasons: Record<string, string> = {};
  const healthy = assessments.filter((a) => !a.paused);
  for (const a of assessments) targets[a.name] = 0;

  if (proposal && !proposalIssue) {
    const shares: Record<string, number> = {};
    for (const a of healthy) {
      const amount = proposal.allocations[a.name];
      const gate = proposal.scores?.[a.name];
      if (gate && gate.riskGateAllowed === false) {
        shares[a.name] = 0;
        reasons[a.name] = 'rejected by capital-allocator risk gate';
      } else if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) {
        shares[a.name] = amount / proposal.totalCapitalUsd;
      } else {
        shares[a.name] = 0;
        reasons[a.name] = 'no allocation in proposal';
      }
    }
    const shareSum = Object.values(shares).reduce((s, v) => s + v, 0);
    const norm = shareSum > 1 ? 1 / shareSum : 1; // never exceed deployable
    for (const a of healthy) {
      targets[a.name] = shares[a.name]! * norm * deployableUsd * a.exposureFactor;
    }
    return { targets, source: 'proposal', reasons };
  }

  const each = healthy.length > 0 ? deployableUsd / healthy.length : 0;
  for (const a of healthy) {
    targets[a.name] = each * a.exposureFactor;
    reasons[a.name] = `equal split (${proposalIssue ?? 'no proposal'})`;
  }
  return { targets, source: 'equal-split', reasons };
}

export type FinalizeOptions = {
  /** Previous binding allocations; null on the very first cycle (no smoothing). */
  previous: Record<string, number> | null;
  paused: Set<string>;
  maxStepUsd: number;
  capUsd: number;
  deployableUsd: number;
};

/**
 * Applies rebalance smoothing (move at most maxStepUsd toward target per cycle; paused -> 0 at once),
 * then the hard limits: per-strategy cap and total <= deployable. Amounts are floored to cents.
 */
export function finalizeAllocations(targets: Record<string, number>, o: FinalizeOptions): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, target] of Object.entries(targets)) {
    if (o.paused.has(name)) {
      out[name] = 0;
      continue;
    }
    let v = target;
    if (o.previous) {
      const prev = o.previous[name] ?? 0;
      v = prev + Math.max(-o.maxStepUsd, Math.min(o.maxStepUsd, target - prev));
    }
    out[name] = Math.min(Math.max(0, v), o.capUsd);
  }
  const sum = Object.values(out).reduce((s, v) => s + v, 0);
  const scale = sum > o.deployableUsd && sum > 0 ? o.deployableUsd / sum : 1;
  for (const name of Object.keys(out)) out[name] = floorCents(out[name]! * scale);
  return out;
}
