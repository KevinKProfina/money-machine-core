import type { Chain, LendingPosition, ProtocolId } from '../types.js';
import { deriveSeed, mulberry32, pick, uniform, type Rng } from '../rng.js';
import type { OpportunitySource, ScanContext } from './types.js';

// SIMULATED. Parameter ranges are illustrative approximations of public protocol
// settings, not authoritative values. Nothing here reads a blockchain.

type ProtocolProfile = {
  protocol: ProtocolId;
  chain: Chain;
  ltRange: [number, number];
  bonusRange: [number, number];
  closeFactor: number;
  gasUsdRange: [number, number];
  pairs: Array<{ collateral: string; debt: string }>;
};

const PROFILES: readonly ProtocolProfile[] = [
  {
    protocol: 'aave-v3',
    chain: 'ethereum',
    ltRange: [0.78, 0.86],
    bonusRange: [0.045, 0.075],
    closeFactor: 0.5,
    gasUsdRange: [4, 60],
    pairs: [
      { collateral: 'WETH', debt: 'USDC' },
      { collateral: 'WBTC', debt: 'USDT' },
      { collateral: 'wstETH', debt: 'WETH' },
    ],
  },
  {
    protocol: 'kamino',
    chain: 'solana',
    ltRange: [0.75, 0.9],
    bonusRange: [0.02, 0.08],
    closeFactor: 0.2,
    gasUsdRange: [0.01, 1.5],
    pairs: [
      { collateral: 'SOL', debt: 'USDC' },
      { collateral: 'JitoSOL', debt: 'SOL' },
      { collateral: 'JUP', debt: 'USDC' },
    ],
  },
  {
    protocol: 'marginfi',
    chain: 'solana',
    ltRange: [0.8, 0.9],
    bonusRange: [0.025, 0.05],
    closeFactor: 0.5,
    gasUsdRange: [0.01, 1.5],
    pairs: [
      { collateral: 'SOL', debt: 'USDC' },
      { collateral: 'mSOL', debt: 'USDT' },
    ],
  },
  {
    protocol: 'save',
    chain: 'solana',
    ltRange: [0.75, 0.85],
    bonusRange: [0.05, 0.1],
    closeFactor: 0.2,
    gasUsdRange: [0.01, 1.5],
    pairs: [
      { collateral: 'SOL', debt: 'USDC' },
      { collateral: 'BONK', debt: 'USDC' },
    ],
  },
];

/** Illustrative annualized volatility by collateral asset. */
const VOLATILITY: Record<string, number> = {
  WETH: 0.7,
  WBTC: 0.55,
  wstETH: 0.7,
  SOL: 0.9,
  JitoSOL: 0.9,
  mSOL: 0.9,
  JUP: 1.3,
  BONK: 1.6,
};

/** Log-uniform sample between lo and hi. */
function logUniform(rng: Rng, lo: number, hi: number): number {
  return Math.exp(uniform(rng, Math.log(lo), Math.log(hi)));
}

function hex(rng: Rng, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(rng() * 16).toString(16);
  return s;
}

/**
 * Deterministic generator of synthetic lending positions. The same (seed, cycle)
 * always yields the same positions. About 20 % of generated positions are
 * liquidatable; the rest are healthy (HF >= 1) so filtering is exercised.
 */
export class SimulatedSource implements OpportunitySource {
  readonly id = 'simulated';
  readonly simulated = true;
  readonly implemented = true;

  constructor(
    private readonly seed: number,
    private readonly positionsPerCycle: number,
  ) {}

  generate(cycle: number, now: Date): LendingPosition[] {
    const rng = mulberry32(deriveSeed(this.seed, cycle));
    const out: LendingPosition[] = [];
    for (let i = 0; i < this.positionsPerCycle; i++) {
      const profile = pick(rng, PROFILES);
      const pair = pick(rng, profile.pairs);
      const liquidationThreshold = round4(uniform(rng, ...profile.ltRange));
      const liquidationBonus = round4(uniform(rng, ...profile.bonusRange));
      const debtUsd = round2(logUniform(rng, 300, 250_000));
      // Target health factor: ~20 % of positions are liquidatable (HF 0.93..1.0),
      // the rest healthy (HF 1.0..1.6) and must be filtered out.
      const targetHf = rng() < 0.2 ? uniform(rng, 0.93, 1.0) : uniform(rng, 1.0, 1.6);
      const collateralUsd = round2((debtUsd * targetHf) / liquidationThreshold);
      const baseVol = VOLATILITY[pair.collateral] ?? 1;
      out.push({
        id: `sim-${cycle}-${i}-${hex(rng, 6)}`,
        protocol: profile.protocol,
        chain: profile.chain,
        borrower: profile.chain === 'ethereum' ? `0x${hex(rng, 40)}` : `SIM${hex(rng, 40)}`,
        collateralSymbol: pair.collateral,
        debtSymbol: pair.debt,
        collateralUsd,
        debtUsd,
        liquidationThreshold,
        liquidationBonus,
        closeFactor: profile.closeFactor,
        gasCostUsd: round2(uniform(rng, ...profile.gasUsdRange)),
        collateralVolatility: round4(baseVol * uniform(rng, 0.8, 1.2)),
        observedAt: now.toISOString(),
        simulated: true,
      });
    }
    return out;
  }

  async scan(ctx: ScanContext): Promise<LendingPosition[]> {
    return this.generate(ctx.cycle, ctx.now);
  }
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}
