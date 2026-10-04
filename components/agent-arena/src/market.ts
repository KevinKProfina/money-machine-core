/** Shared market data model: one snapshot per cycle, read by every agent. */
export type PriceChange = { m5?: number; h1?: number; h24?: number };

export type Token = {
  mint: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  url?: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  marketCapUsd: number;
  /** Hours since the pair was created; NaN when unknown. */
  ageHours: number;
  buys24h: number;
  sells24h: number;
  /** Percent price changes (5 = +5 %) when the source provides them. */
  priceChange: PriceChange;
};

export type MarketSourceId = 'dexscreener' | 'synthetic';

export type MarketSnapshot = {
  source: MarketSourceId;
  /** false when discovery failed: agents must not open new positions this cycle. */
  ok: boolean;
  error?: string;
  fetchedAt: string;
  /** Tokens agents may consider for new entries. */
  candidates: Token[];
  /** Every token with a current price (candidates + mints held by any agent). */
  tokens: Map<string, Token>;
};

export interface MarketSource {
  readonly id: MarketSourceId;
  /** Fetch one snapshot. `heldMints` must be priced too when the source knows them. Must not throw. */
  snapshot(heldMints: string[]): Promise<MarketSnapshot>;
}

export function failedSnapshot(source: MarketSourceId, error: string, now: Date): MarketSnapshot {
  return { source, ok: false, error, fetchedAt: now.toISOString(), candidates: [], tokens: new Map() };
}
