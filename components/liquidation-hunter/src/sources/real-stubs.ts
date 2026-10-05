import type { LendingPosition } from '../types.js';
import { NotImplementedError, type OpportunitySource, type ScanContext } from './types.js';

/**
 * Skeletons for real opportunity sources. NONE of these is implemented; each
 * `scan` throws NotImplementedError and `assertRunnable` refuses to select them.
 *
 * Implementation notes for whoever builds one:
 * - Take an injected `fetchImpl` / RPC client so the source is unit-testable
 *   offline, and use `fetchWithRetry` (src/http.ts) for timeouts + backoff.
 * - On any network failure, log and return [] (degrade gracefully) rather than throw.
 * - Return positions with `simulated: false`, USD values priced from the
 *   protocol's own oracle (the price the liquidation will be checked against),
 *   and per-reserve liquidationThreshold / liquidationBonus / closeFactor.
 * - Estimate gasCostUsd from current base + priority fees, not a constant.
 *
 * Protocol pointers:
 * - Kamino Lend (Solana): enumerate obligations of a lending market, refresh
 *   reserves + obligation, compare borrow value vs. unhealthy borrow value.
 * - MarginFi v2 (Solana): enumerate marginfi accounts, compute maintenance
 *   health from bank weights; liquidation via lending_account_liquidate.
 * - Save (ex-Solend, Solana): enumerate obligations; obligation is liquidatable
 *   when borrowed value > unhealthy borrow value; close factor per reserve config.
 * - Aave v3 (EVM): follow Borrow/Repay/Supply events or a subgraph for borrowers,
 *   read getUserAccountData(user).healthFactor; liquidationCall(collateral, debt,
 *   user, debtToCover, receiveAToken); close factor 50 % (100 % when HF < 0.95).
 */
abstract class RealSourceStub implements OpportunitySource {
  abstract readonly id: string;
  readonly simulated = false;
  readonly implemented = false;

  async scan(_ctx: ScanContext): Promise<LendingPosition[]> {
    throw new NotImplementedError(`Opportunity source "${this.id}"`);
  }
}

export class KaminoSource extends RealSourceStub {
  readonly id = 'kamino';
}
export class MarginFiSource extends RealSourceStub {
  readonly id = 'marginfi';
}
export class SaveSource extends RealSourceStub {
  readonly id = 'save';
}
export class AaveV3Source extends RealSourceStub {
  readonly id = 'aave-v3';
}
