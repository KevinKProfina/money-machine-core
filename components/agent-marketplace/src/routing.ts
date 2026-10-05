import { emptyStats, reputationScore } from './reputation.ts';
import type { ReputationStats, Service } from './types.ts';

export const ROUTING_WEIGHTS = { reputation: 0.6, price: 0.25, latency: 0.15 } as const;
const PRICE_EPSILON = 0.01;
/** Latency score used when a service has no samples yet (neutral). */
const UNKNOWN_LATENCY_SCORE = 0.5;

export type RoutingInput = {
  service: Service;
  serviceStats?: ReputationStats;
  agentStats?: ReputationStats;
};

export type ScoredService = {
  service: Service;
  score: number;
  components: { reputation: number; price: number; latency: number };
};

/** Latency score 0..1: 1 s → 0.5, 0 ms → 1. */
export function latencyScore(emaMs: number | undefined): number {
  if (emaMs === undefined) return UNKNOWN_LATENCY_SCORE;
  return 1 / (1 + emaMs / 1000);
}

/**
 * Routing score 0..1 for each candidate. Price is relative to the cheapest candidate
 * (cheapest = 1). Reputation blends service (70 %) and provider agent (30 %) reputation.
 * Sorted best-first; ties broken by lower price then id for determinism.
 */
export function scoreServices(candidates: RoutingInput[]): ScoredService[] {
  if (candidates.length === 0) return [];
  const minPrice = Math.min(...candidates.map((c) => c.service.priceUsd));
  return candidates
    .map(({ service, serviceStats, agentStats }) => {
      const reputation =
        0.7 * reputationScore(serviceStats ?? emptyStats()) + 0.3 * reputationScore(agentStats ?? emptyStats());
      const price = (minPrice + PRICE_EPSILON) / (service.priceUsd + PRICE_EPSILON);
      const latency = latencyScore(serviceStats?.latencyEmaMs);
      const score =
        ROUTING_WEIGHTS.reputation * reputation + ROUTING_WEIGHTS.price * price + ROUTING_WEIGHTS.latency * latency;
      return { service, score, components: { reputation, price, latency } };
    })
    .sort(
      (a, b) =>
        b.score - a.score || a.service.priceUsd - b.service.priceUsd || a.service.id.localeCompare(b.service.id),
    );
}

/** Pick the best provider for a capability, optionally capped by a max price. */
export function pickBest(candidates: RoutingInput[], maxPriceUsd?: number): ScoredService | undefined {
  const affordable = maxPriceUsd === undefined ? candidates : candidates.filter((c) => c.service.priceUsd <= maxPriceUsd);
  return scoreServices(affordable)[0];
}
