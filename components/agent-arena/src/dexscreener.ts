import { fetchJson, type FetchLike } from './http.js';
import { failedSnapshot, type MarketSnapshot, type MarketSource, type Token } from './market.js';

const DEXSCREENER = 'https://api.dexscreener.com';
/** DexScreener accepts up to 30 addresses per tokens request. */
const BATCH = 30;

type DexProfile = { chainId?: string; tokenAddress?: string };
export type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string | number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { m5?: number | string; h1?: number | string; h6?: number | string; h24?: number | string };
  txns?: { h24?: { buys?: number; sells?: number } };
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
  const priceChange: Token['priceChange'] = {};
  const m5 = opt(pair.priceChange?.m5);
  const h1 = opt(pair.priceChange?.h1);
  const h24 = opt(pair.priceChange?.h24);
  if (m5 !== undefined) priceChange.m5 = m5;
  if (h1 !== undefined) priceChange.h1 = h1;
  if (h24 !== undefined) priceChange.h24 = h24;
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

export type DexScreenerOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  now?: () => number;
  /** Max discovered candidate mints per snapshot. */
  discoveryLimit?: number;
  log?: (msg: string) => void;
};

/**
 * Real market data from DexScreener's public API. Discovery = latest token profiles
 * + latest boosts (Solana only); held mints that dropped out of discovery are looked
 * up in batches so every open position keeps a fresh mark.
 */
export class DexScreenerSource implements MarketSource {
  readonly id = 'dexscreener' as const;

  constructor(private readonly opts: DexScreenerOptions = {}) {}

  private get http() {
    return { fetchImpl: this.opts.fetchImpl, timeoutMs: this.opts.timeoutMs, retries: this.opts.retries, backoffMs: this.opts.backoffMs };
  }

  private log(msg: string) {
    (this.opts.log ?? console.error)(`[dexscreener] ${msg}`);
  }

  /** Throws if every discovery endpoint failed (so the caller can block entries). */
  async discoverMints(): Promise<string[]> {
    const endpoints = ['/token-profiles/latest/v1', '/token-boosts/latest/v1'];
    const mints: string[] = [];
    let failures = 0;
    for (const endpoint of endpoints) {
      try {
        const data = await fetchJson<unknown>(`${DEXSCREENER}${endpoint}`, this.http);
        const rows = Array.isArray(data) ? (data as DexProfile[]) : [];
        for (const p of rows) if (p.chainId === 'solana' && p.tokenAddress) mints.push(p.tokenAddress);
      } catch (error) {
        failures++;
        this.log(`discovery ${endpoint} failed: ${(error as Error).message}`);
      }
    }
    if (failures === endpoints.length) throw new Error('all discovery endpoints failed');
    return [...new Set(mints)].slice(0, this.opts.discoveryLimit ?? 60);
  }

  async getTokens(mints: string[]): Promise<{ tokens: Map<string, Token>; failedBatches: number }> {
    const tokens = new Map<string, Token>();
    const unique = [...new Set(mints)];
    const now = this.opts.now?.() ?? Date.now();
    let failedBatches = 0;
    for (let i = 0; i < unique.length; i += BATCH) {
      const chunk = unique.slice(i, i + BATCH);
      try {
        const data = await fetchJson<{ pairs?: DexPair[] | null }>(`${DEXSCREENER}/latest/dex/tokens/${chunk.join(',')}`, this.http);
        for (const [mint, token] of bestPairsByMint(data?.pairs ?? [], now)) if (chunk.includes(mint)) tokens.set(mint, token);
      } catch (error) {
        failedBatches++;
        this.log(`token lookup failed for ${chunk.length} mints: ${(error as Error).message}`);
      }
    }
    return { tokens, failedBatches };
  }

  async snapshot(heldMints: string[]): Promise<MarketSnapshot> {
    const now = new Date(this.opts.now?.() ?? Date.now());
    let discovered: string[] = [];
    let discoveryError: string | undefined;
    try {
      discovered = await this.discoverMints();
    } catch (error) {
      discoveryError = (error as Error).message;
    }
    const { tokens, failedBatches } = await this.getTokens([...discovered, ...heldMints]);
    const totalBatches = Math.ceil(new Set([...discovered, ...heldMints]).size / BATCH);
    if (discoveryError) {
      // Still keep whatever held-mint prices we got, but no entries this cycle.
      const snap = failedSnapshot('dexscreener', discoveryError, now);
      snap.tokens = tokens;
      return snap;
    }
    if (totalBatches > 0 && failedBatches === totalBatches) {
      const snap = failedSnapshot('dexscreener', 'all token lookups failed', now);
      return snap;
    }
    const candidates = discovered.map((m) => tokens.get(m)).filter((t): t is Token => t !== undefined);
    return { source: 'dexscreener', ok: true, fetchedAt: now.toISOString(), candidates, tokens };
  }
}
