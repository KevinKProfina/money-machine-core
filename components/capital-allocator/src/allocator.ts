import { syntheticMaxShare, type AllocatorConfig } from './config.js';
import type { AllocationProposal, StrategyReport } from './mm-contract.js';
import { scoreStrategy, type StrategyScore } from './scoring.js';

export type Candidate = {
  name: string;
  /** Positive weight (the adjusted score, after any synthetic-data discount). */
  weight: number;
  /** Low-data strategy funded from the exploration budget instead of the main pool. */
  exploration: boolean;
  /** Optional per-strategy cap as a share of total capital (tighter than maxStrategyShare). */
  maxShare?: number;
};

export type AllocationOptions = {
  minStrategyCapitalUsd: number;
  maxStrategyShare: number;
  explorationShare: number;
};

export type AllocationResult = {
  allocations: Record<string, number>;
  unallocatedUsd: number;
  notes: Record<string, string[]>;
};

/** Round down to whole cents so that sums never exceed the budget. */
export const floorCents = (v: number): number => Math.floor(v * 100 + 1e-7) / 100;

/**
 * Distribute up to `budget` across weights so that each amount is
 * clamp(lambda * w_i, lo_i, hi_i) — i.e. proportional to weight wherever the bounds don't bind.
 * Requires sum(lo) <= budget and lo_i <= hi_i. Returns amounts whose sum <= budget.
 */
export function boundedProportional(weights: number[], budget: number, lo: number[], hi: number[]): number[] {
  const n = weights.length;
  if (n === 0 || budget <= 0) return weights.map(() => 0);
  const clampAt = (lambda: number, i: number) => Math.min(hi[i]!, Math.max(lo[i]!, lambda * weights[i]!));
  if (hi.reduce((s, v) => s + v, 0) <= budget) return [...hi];
  const total = (lambda: number) => weights.reduce((s, _w, i) => s + clampAt(lambda, i), 0);
  let low = 0;
  let high = Math.max(0, ...weights.map((w, i) => (w > 0 ? hi[i]! / w : 0)));
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    if (total(mid) <= budget) low = mid;
    else high = mid;
  }
  return weights.map((_w, i) => clampAt(low, i));
}

/**
 * Allocates `totalCapitalUsd` across risk-gate-approved candidates.
 * Invariants: every amount in [min, cap] or 0 (exploration amounts in [0, cap]), sum <= total,
 * leftover is unallocated.
 */
export function allocate(candidates: Candidate[], totalCapitalUsd: number, opts: AllocationOptions): AllocationResult {
  const allocations: Record<string, number> = {};
  const notes: Record<string, string[]> = {};
  const note = (name: string, msg: string) => (notes[name] ??= []).push(msg);
  for (const c of candidates) allocations[c.name] = 0;

  const total = Math.max(0, totalCapitalUsd);
  const capOf = (c: Candidate) => floorCents(Math.min(opts.maxStrategyShare, c.maxShare ?? 1) * total);
  const minOf = (c: Candidate) => Math.min(opts.minStrategyCapitalUsd, capOf(c));

  // Exploration pool: weight-proportional split of explorationShare, capped, only when enabled.
  const explore = opts.explorationShare > 0 ? candidates.filter((c) => c.exploration) : [];
  const main = candidates.filter((c) => !explore.includes(c));
  let explorationUsed = 0;
  if (explore.length > 0) {
    const amounts = boundedProportional(
      explore.map((c) => c.weight),
      floorCents(opts.explorationShare * total),
      explore.map(() => 0),
      explore.map(capOf),
    );
    explore.forEach((c, i) => {
      const amount = floorCents(amounts[i]!);
      allocations[c.name] = amount;
      explorationUsed += amount;
      note(c.name, `exploration budget $${amount.toFixed(2)}`);
    });
  }

  // Main pool: drop lowest-weight strategies until every remaining one can get the minimum.
  const mainBudget = Math.max(0, total - explorationUsed);
  const ranked = [...main].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));
  while (ranked.length > 0 && ranked.reduce((s, c) => s + minOf(c), 0) > mainBudget) {
    const dropped = ranked.pop()!;
    note(dropped.name, 'not funded: capital too small to give every approved strategy its minimum');
  }
  const amounts = boundedProportional(
    ranked.map((c) => c.weight),
    mainBudget,
    ranked.map(minOf),
    ranked.map(capOf),
  );
  ranked.forEach((c, i) => {
    const amount = floorCents(amounts[i]!);
    allocations[c.name] = amount;
    const cap = capOf(c);
    if (amount >= cap - 0.005) note(c.name, `capped at ${((cap / (total || 1)) * 100).toFixed(1)}% of capital`);
  });

  const allocated = Object.values(allocations).reduce((s, v) => s + v, 0);
  return { allocations, unallocatedUsd: floorCents(Math.max(0, total - allocated)), notes };
}

export type ProposalBuild = { proposal: AllocationProposal; scores: StrategyScore[]; unallocatedUsd: number };

export function buildProposal(reports: StrategyReport[], config: AllocatorConfig, now: Date = new Date()): ProposalBuild {
  const seen = new Set<string>();
  const scores: StrategyScore[] = [];
  for (const report of reports) {
    if (typeof report.name !== 'string' || report.name.trim() === '') continue;
    const s = scoreStrategy(report, config);
    if (seen.has(s.name)) {
      s.riskGateAllowed = false;
      s.reasons.push('rejected: duplicate strategy name');
    }
    seen.add(s.name);
    scores.push(s);
  }

  const candidates: Candidate[] = scores
    .filter((s) => s.riskGateAllowed && s.allocationWeight > 0)
    .map((s) => ({
      name: s.name,
      weight: Math.max(1e-6, s.allocationWeight),
      exploration: s.lowData,
      ...(s.syntheticData ? { maxShare: syntheticMaxShare(config) } : {}),
    }));
  const result = allocate(candidates, config.totalCapitalUsd, config);

  const proposal: AllocationProposal = {
    schema: 'mm.allocation-proposal/v1',
    timestamp: now.toISOString(),
    totalCapitalUsd: config.totalCapitalUsd,
    riskProfile: config.riskProfile,
    allocations: {},
    scores: {},
  };
  for (const s of scores) {
    if (proposal.scores[s.name]) continue; // keep the first of duplicates
    proposal.allocations[s.name] = result.allocations[s.name] ?? 0;
    proposal.scores[s.name] = {
      score: Math.round(s.allocationWeight * 100) / 100,
      riskGateAllowed: s.riskGateAllowed,
      reasons: [...s.reasons, ...(result.notes[s.name] ?? [])],
    };
  }
  return { proposal, scores, unallocatedUsd: result.unallocatedUsd };
}
