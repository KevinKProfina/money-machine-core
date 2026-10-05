import type { LendingPosition } from '../types.js';

export type ScanContext = { cycle: number; now: Date };

/** Anything that can list lending positions that may be liquidatable. */
export interface OpportunitySource {
  readonly id: string;
  /** True when positions are synthetic (not read from a chain). */
  readonly simulated: boolean;
  /** False for skeletons; unimplemented sources cannot be selected. */
  readonly implemented: boolean;
  scan(ctx: ScanContext): Promise<LendingPosition[]>;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented`);
    this.name = 'NotImplementedError';
  }
}
