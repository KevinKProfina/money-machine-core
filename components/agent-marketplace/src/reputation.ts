import type { ReputationStats } from './types.ts';

/** Prior: behaves as if every new provider already had PRIOR_WEIGHT jobs at PRIOR_SUCCESS / PRIOR_RATING. */
export const PRIOR_WEIGHT = 5;
export const PRIOR_SUCCESS = 0.7;
export const PRIOR_RATING = 3;
export const LATENCY_ALPHA = 0.3;

export function emptyStats(): ReputationStats {
  return { successes: 0, failures: 0, ratingSum: 0, ratingCount: 0 };
}

/** Bayesian (prior-smoothed) success rate, 0..1. */
export function successScore(s: ReputationStats): number {
  return (s.successes + PRIOR_SUCCESS * PRIOR_WEIGHT) / (s.successes + s.failures + PRIOR_WEIGHT);
}

/** Bayesian average rating, 1..5. */
export function ratingScore(s: ReputationStats): number {
  return (s.ratingSum + PRIOR_RATING * PRIOR_WEIGHT) / (s.ratingCount + PRIOR_WEIGHT);
}

/** Combined reputation 0..1: 60 % success, 40 % rating (rating mapped 1..5 → 0..1). */
export function reputationScore(s: ReputationStats): number {
  return 0.6 * successScore(s) + 0.4 * ((ratingScore(s) - 1) / 4);
}

export function recordOutcome(s: ReputationStats, success: boolean, latencyMs: number): ReputationStats {
  const next = { ...s };
  if (success) next.successes += 1;
  else next.failures += 1;
  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    next.latencyEmaMs =
      next.latencyEmaMs === undefined ? latencyMs : LATENCY_ALPHA * latencyMs + (1 - LATENCY_ALPHA) * next.latencyEmaMs;
  }
  return next;
}

export function recordRating(s: ReputationStats, rating: number): ReputationStats {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error('rating must be an integer 1..5');
  return { ...s, ratingSum: s.ratingSum + rating, ratingCount: s.ratingCount + 1 };
}
