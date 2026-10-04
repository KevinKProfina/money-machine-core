import {
  clampGene,
  coerceGenome,
  crossoverFrom,
  mutateGenomeFrom,
  randomGenomeFrom,
  type Genome,
  type GenomeSpec,
  type ValidationResult,
} from '../genome.js';
import type { Token } from '../market.js';
import type { Rng } from '../rng.js';
import type { ActContext, Agent, Intent, Position, Species } from '../types.js';

export const RANK_BY = ['h1-momentum', 'turnover', 'buy-pressure', 'youngest'] as const;

export const TRADER_GENOME: GenomeSpec = {
  minLiquidityUsd: { min: 1_000, max: 5_000_000, log: true, init: [5_000, 500_000], description: 'minimum pool liquidity (USD)' },
  minVolume24hUsd: { min: 1_000, max: 50_000_000, log: true, init: [5_000, 2_000_000], description: 'minimum 24h volume (USD)' },
  minAgeHours: { min: 0, max: 720, init: [0, 72], description: 'minimum pair age (h)' },
  maxAgeHours: { min: 1, max: 20_000, log: true, init: [24, 20_000], description: 'maximum pair age (h)' },
  minBuySellRatio: { min: 0.2, max: 4, init: [0.6, 1.6], description: 'minimum 24h buys/sells ratio' },
  minChangeM5: { min: -20, max: 20, init: [-5, 3], description: 'minimum 5m price change (%) when known' },
  minChangeH1: { min: -50, max: 50, init: [-10, 10], description: 'minimum 1h price change (%) when known' },
  maxChangeH1: { min: -10, max: 300, init: [10, 150], description: 'maximum 1h price change (%) when known (avoid chasing)' },
  minChangeH24: { min: -90, max: 300, init: [-50, 20], description: 'minimum 24h price change (%) when known' },
  positionPct: { min: 0.02, max: 0.5, init: [0.05, 0.3], description: 'position size as a fraction of balance' },
  takeProfitPct: { min: 1, max: 500, log: true, init: [3, 100], description: 'take profit (%)' },
  stopLossPct: { min: 1, max: 90, init: [2, 30], description: 'stop loss (%)' },
  trailingStopPct: { min: 0, max: 80, init: [0, 25], description: 'trailing stop from peak (%), 0 = off' },
  maxHoldCycles: { min: 1, max: 2_000, integer: true, log: true, init: [3, 300], description: 'max holding time (cycles)' },
  maxOpenPositions: { min: 1, max: 10, integer: true, init: [1, 4], description: 'max concurrent open positions' },
  cooldownCycles: { min: 0, max: 100, integer: true, init: [0, 6], description: 'cycles to wait after closing a position' },
  rankBy: { min: 0, max: RANK_BY.length - 1, categorical: true, description: `candidate ranking: ${RANK_BY.map((r, i) => `${i}=${r}`).join(', ')}` },
};

/** Enforce cross-gene consistency (age window, h1 window). */
function repair(g: Genome): Genome {
  const s = TRADER_GENOME;
  if (g.maxAgeHours! < g.minAgeHours! + 1) g.maxAgeHours = clampGene(s.maxAgeHours!, g.minAgeHours! + 1);
  if (g.maxChangeH1! < g.minChangeH1!) g.maxChangeH1 = clampGene(s.maxChangeH1!, g.minChangeH1! + 5);
  return g;
}

export function buySellRatio(t: Token): number {
  if (t.sells24h <= 0) return t.buys24h > 0 ? 10 : 0;
  return t.buys24h / t.sells24h;
}

/** Deterministic entry filter of a trader genome. */
export function passesFilters(g: Genome, t: Token): boolean {
  if (!(t.priceUsd > 0)) return false;
  if (t.liquidityUsd < g.minLiquidityUsd!) return false;
  if (t.volume24hUsd < g.minVolume24hUsd!) return false;
  if (Number.isFinite(t.ageHours)) {
    if (t.ageHours < g.minAgeHours! || t.ageHours > g.maxAgeHours!) return false;
  } else if (g.minAgeHours! > 0) {
    return false; // unknown age only passes when the genome accepts brand-new pairs
  }
  if (buySellRatio(t) < g.minBuySellRatio!) return false;
  const pc = t.priceChange;
  if (pc.m5 !== undefined && pc.m5 < g.minChangeM5!) return false;
  if (pc.h1 !== undefined && (pc.h1 < g.minChangeH1! || pc.h1 > g.maxChangeH1!)) return false;
  if (pc.h24 !== undefined && pc.h24 < g.minChangeH24!) return false;
  return true;
}

export function rankScore(g: Genome, t: Token): number {
  switch (RANK_BY[g.rankBy!] ?? 'h1-momentum') {
    case 'turnover':
      return t.liquidityUsd > 0 ? t.volume24hUsd / t.liquidityUsd : 0;
    case 'buy-pressure':
      return buySellRatio(t);
    case 'youngest':
      return Number.isFinite(t.ageHours) ? -t.ageHours : -Infinity;
    default:
      return t.priceChange.h1 ?? t.priceChange.m5 ?? 0;
  }
}

export type ExitReason = 'take-profit' | 'stop-loss' | 'trailing-stop' | 'max-hold';

/** Exit decision for a position that was priced this cycle; undefined = hold. */
export function exitReason(g: Genome, p: Position, cycle: number): ExitReason | undefined {
  if (p.lastPricedCycle !== cycle) return undefined; // no fresh price → keep last mark, no exit
  const ret = p.lastPriceUsd / p.entryPriceUsd - 1;
  if (ret >= g.takeProfitPct! / 100) return 'take-profit';
  if (ret <= -g.stopLossPct! / 100) return 'stop-loss';
  const trail = g.trailingStopPct! / 100;
  if (trail > 0 && p.peakPriceUsd > p.entryPriceUsd && p.lastPriceUsd <= p.peakPriceUsd * (1 - trail)) return 'trailing-stop';
  if (cycle - p.openedCycle >= g.maxHoldCycles!) return 'max-hold';
  return undefined;
}

export const traderSpecies: Species = {
  id: 'trader',
  description: 'Paper-trades Solana tokens from the shared market snapshot using evolved filter/exit parameters.',
  genomeSpec: TRADER_GENOME,

  randomGenome(rng: Rng): Genome {
    return repair(randomGenomeFrom(TRADER_GENOME, rng));
  },

  mutate(genome: Genome, rng: Rng, rate: number): Genome {
    return repair(mutateGenomeFrom(TRADER_GENOME, genome, rng, rate));
  },

  crossover(a: Genome, b: Genome, rng: Rng): Genome {
    return repair(crossoverFrom(TRADER_GENOME, a, b, rng));
  },

  validate(input: unknown, fill: Genome): ValidationResult {
    const res = coerceGenome(TRADER_GENOME, input, fill);
    const before = { ...res.genome };
    repair(res.genome);
    for (const k of Object.keys(before)) if (before[k] !== res.genome[k] && !res.clamped.includes(k)) res.clamped.push(k);
    return res;
  },

  act(agent: Agent, ctx: ActContext): Intent[] {
    const g = agent.genome;
    const intents: Intent[] = [];
    for (const p of agent.positions) {
      const reason = exitReason(g, p, ctx.cycle);
      if (reason) intents.push({ kind: 'sell', positionId: p.id, reason });
    }
    const remainingOpen = agent.positions.length - intents.length;
    if (!ctx.allowEntries || ctx.cycle < agent.cooldownUntil || remainingOpen >= g.maxOpenPositions!) return intents;

    const sizeUsd = g.positionPct! * ctx.balanceUsd;
    if (sizeUsd < ctx.minTradeUsd) return intents;
    const held = new Set(agent.positions.map((p) => p.mint));
    let best: Token | undefined;
    let bestScore = -Infinity;
    for (const t of ctx.snapshot.candidates) {
      if (held.has(t.mint) || !passesFilters(g, t)) continue;
      const score = rankScore(g, t);
      if (score > bestScore || best === undefined) {
        best = t;
        bestScore = score;
      }
    }
    if (best) intents.push({ kind: 'buy', mint: best.mint, sizeUsd, reason: `${RANK_BY[g.rankBy!] ?? 'h1-momentum'}=${bestScore.toFixed(3)}` });
    return intents;
  },
};
