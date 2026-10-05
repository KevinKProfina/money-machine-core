import { fetchJson, type FetchLike } from './http.js';

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
  /** Percent price changes from DexScreener (5 = +5 %), when provided. */
  priceChange?: { m5?: number; h1?: number; h24?: number };
};

export interface MarketSource {
  /** Discover candidate Solana token mints (newest profiles first). */
  discover(limit: number): Promise<Token[]>;
  /** Current market data for the given mints; mints without data are absent from the map. */
  getTokens(mints: string[]): Promise<Map<string, Token>>;
}

const DEXSCREENER = 'https://api.dexscreener.com';
/** DexScreener accepts up to 30 addresses per tokens request. */
const BATCH = 30;

type DexProfile = { chainId?: string; tokenAddress?: string };
type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string | number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  priceChange?: { m5?: number | string; h1?: number | string; h6?: number | string; h24?: number | string };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
};

function n(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
}

function opt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

/** Convert a DexScreener pair into a Token; returns undefined for unusable pairs. */
export function normalizePair(pair: DexPair, now = Date.now()): Token | undefined {
  const mint = pair.baseToken?.address;
  const priceUsd = n(pair.priceUsd);
  if (pair.chainId !== 'solana' || !mint || !pair.pairAddress || priceUsd <= 0) return undefined;
  const priceChange: NonNullable<Token['priceChange']> = {};
  for (const k of ['m5', 'h1', 'h24'] as const) {
    const v = opt(pair.priceChange?.[k]);
    if (v !== undefined) priceChange[k] = v;
  }
  return {
    mint,
    symbol: pair.baseToken?.symbol ?? '?',
    name: pair.baseToken?.name ?? pair.baseToken?.symbol ?? mint,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId ?? 'unknown',
    url: pair.url,
    priceUsd,
    liquidityUsd: n(pair.liquidity?.usd),
    volume24hUsd: n(pair.volume?.h24),
    marketCapUsd: n(pair.marketCap) || n(pair.fdv),
    ageHours: pair.pairCreatedAt ? Math.max(0, (now - pair.pairCreatedAt) / 3_600_000) : Number.NaN,
    buys24h: n(pair.txns?.h24?.buys),
    sells24h: n(pair.txns?.h24?.sells),
    priceChange,
  };
}

/** Pick, per base-token mint, the pair with the deepest USD liquidity. */
export function bestPairsByMint(pairs: DexPair[], now = Date.now()): Map<string, Token> {
  const out = new Map<string, Token>();
  for (const pair of pairs) {
    const token = normalizePair(pair, now);
    if (!token) continue;
    const existing = out.get(token.mint);
    if (!existing || token.liquidityUsd > existing.liquidityUsd) out.set(token.mint, token);
  }
  return out;
}

export class DexScreenerSource implements MarketSource {
  constructor(
    private readonly opts: { fetchImpl?: FetchLike; timeoutMs?: number; retries?: number; backoffMs?: number; now?: () => number } = {},
  ) {}

  private get http() {
    return { fetchImpl: this.opts.fetchImpl, timeoutMs: this.opts.timeoutMs, retries: this.opts.retries, backoffMs: this.opts.backoffMs };
  }

  async discover(limit: number): Promise<Token[]> {
    let profiles: DexProfile[] = [];
    try {
      const data = await fetchJson<unknown>(`${DEXSCREENER}/token-profiles/latest/v1`, this.http);
      profiles = Array.isArray(data) ? (data as DexProfile[]) : [];
    } catch (error) {
      console.error(`[market] discovery failed: ${(error as Error).message}`);
      return [];
    }
    const mints = [
      ...new Set(profiles.filter((p) => p.chainId === 'solana' && p.tokenAddress).map((p) => p.tokenAddress as string)),
    ].slice(0, limit);
    const tokens = await this.getTokens(mints);
    return mints.map((m) => tokens.get(m)).filter((t): t is Token => t !== undefined);
  }

  async getTokens(mints: string[]): Promise<Map<string, Token>> {
    const result = new Map<string, Token>();
    const unique = [...new Set(mints)];
    const now = this.opts.now?.() ?? Date.now();
    for (let i = 0; i < unique.length; i += BATCH) {
      const chunk = unique.slice(i, i + BATCH);
      try {
        const data = await fetchJson<{ pairs?: DexPair[] | null }>(
          `${DEXSCREENER}/latest/dex/tokens/${chunk.join(',')}`,
          this.http,
        );
        for (const [mint, token] of bestPairsByMint(data?.pairs ?? [], now)) {
          if (chunk.includes(mint)) result.set(mint, token);
        }
      } catch (error) {
        console.error(`[market] token lookup failed for ${chunk.length} mints: ${(error as Error).message}`);
      }
    }
    return result;
  }
}
