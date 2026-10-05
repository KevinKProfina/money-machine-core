import { createHash } from 'node:crypto';
import type { Rng } from './rng.js';

/** A genome is a flat record of named numeric genes. */
export type Genome = Record<string, number>;

export type GeneSpec = {
  min: number;
  max: number;
  /** Round to an integer after mutation/clamping. */
  integer?: boolean;
  /** Mutate in log space (for genes spanning orders of magnitude, min must be > 0). */
  log?: boolean;
  /** Categorical integer gene: mutation picks a new random value instead of a step. */
  categorical?: boolean;
  /** Narrower range used for random (spontaneous) genomes; mutation can still reach the full bounds. */
  init?: [number, number];
  description: string;
};

export type GenomeSpec = Record<string, GeneSpec>;

export function clampGene(spec: GeneSpec, value: number): number {
  let v = Number.isFinite(value) ? value : (spec.min + spec.max) / 2;
  v = Math.min(spec.max, Math.max(spec.min, v));
  if (spec.integer || spec.categorical) v = Math.round(v);
  return v;
}

export function randomGene(spec: GeneSpec, rng: Rng): number {
  const [lo, hi] = spec.init ?? [spec.min, spec.max];
  if (spec.integer || spec.categorical) return clampGene(spec, rng.int(Math.ceil(lo), Math.floor(hi)));
  if (spec.log) return clampGene(spec, Math.exp(rng.range(Math.log(lo), Math.log(hi))));
  return clampGene(spec, rng.range(lo, hi));
}

/** Gaussian step of ~`sigma` of the gene's range (log range for log genes). */
export function mutateGene(spec: GeneSpec, value: number, rng: Rng, sigma = 0.1): number {
  if (spec.categorical) return rng.int(spec.min, spec.max);
  if (spec.log) {
    const lo = Math.log(spec.min);
    const hi = Math.log(spec.max);
    const v = Math.log(Math.max(spec.min, value)) + rng.normal() * sigma * (hi - lo);
    return clampGene(spec, Math.exp(v));
  }
  const step = rng.normal() * sigma * (spec.max - spec.min);
  let next = value + step;
  if ((spec.integer ?? false) && Math.round(next) === Math.round(value)) next = value + Math.sign(step || 1);
  return clampGene(spec, next);
}

export function randomGenomeFrom(spec: GenomeSpec, rng: Rng): Genome {
  const g: Genome = {};
  for (const [k, s] of Object.entries(spec)) g[k] = randomGene(s, rng);
  return g;
}

/** Each gene mutates independently with probability `rate`. */
export function mutateGenomeFrom(spec: GenomeSpec, genome: Genome, rng: Rng, rate: number): Genome {
  const g: Genome = {};
  for (const [k, s] of Object.entries(spec)) {
    const v = genome[k] ?? randomGene(s, rng);
    g[k] = rng.chance(rate) ? mutateGene(s, v, rng) : clampGene(s, v);
  }
  return g;
}

/** Uniform crossover. */
export function crossoverFrom(spec: GenomeSpec, a: Genome, b: Genome, rng: Rng): Genome {
  const g: Genome = {};
  for (const k of Object.keys(spec)) g[k] = rng.chance(0.5) ? a[k]! : b[k]!;
  return g;
}

export type ValidationResult = { genome: Genome; clamped: string[]; missing: string[] };

/**
 * Coerce unknown input (e.g. LLM output) into a genome within bounds.
 * Missing/non-numeric genes are reported and filled from `fill`.
 */
export function coerceGenome(spec: GenomeSpec, input: unknown, fill: Genome): ValidationResult {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const genome: Genome = {};
  const clamped: string[] = [];
  const missing: string[] = [];
  for (const [k, s] of Object.entries(spec)) {
    const raw = src[k];
    const num = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (typeof num !== 'number' || !Number.isFinite(num)) {
      missing.push(k);
      genome[k] = clampGene(s, fill[k] ?? (s.min + s.max) / 2);
      continue;
    }
    const v = clampGene(s, num);
    if (v !== num) clamped.push(k);
    genome[k] = v;
  }
  return { genome, clamped, missing };
}

/** True if every gene exists, is finite and within bounds. */
export function isWithinBounds(spec: GenomeSpec, genome: Genome): boolean {
  return Object.entries(spec).every(([k, s]) => {
    const v = genome[k];
    return typeof v === 'number' && Number.isFinite(v) && v >= s.min && v <= s.max && (!(s.integer || s.categorical) || Number.isInteger(v));
  });
}

/**
 * Stable content id of a genome: `g-` + 12 hex chars of sha256 over the genes sorted
 * by name, each rounded to 6 significant digits. Identical strategies (e.g. a clone
 * in the live arena and the same genome in a backtest) share one id, so evidence
 * from both can be joined.
 */
export function genomeId(genome: Genome): string {
  const canon = Object.keys(genome)
    .sort()
    .map((k) => `${k}=${Number(genome[k]!.toPrecision(6))}`)
    .join(';');
  return `g-${createHash('sha256').update(canon).digest('hex').slice(0, 12)}`;
}
