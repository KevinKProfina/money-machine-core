/**
 * LIVE executor: swaps SOL <-> token through the Jupiter swap API and signs with a local keypair.
 *
 * UNTESTED ON MAINNET. This code path has only been type-checked; it has never executed a real
 * swap. It is only constructed when MODE=live AND LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK
 * AND SOLANA_PRIVATE_KEY is set. Use tiny sizes and verify every transaction manually.
 */
import { Connection, PublicKey, VersionedTransaction, type Keypair } from '@solana/web3.js';
import { fetchJson, type FetchLike } from './http.js';
import type { BuyFill, Executor, SellFill } from './executor.js';
import type { Token } from './market.js';
import type { Position } from './positions.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP = 'https://lite-api.jup.ag/swap/v1';
const LAMPORTS = 1_000_000_000;

type QuoteResponse = { inAmount: string; outAmount: string; [key: string]: unknown };
type SwapResponse = { swapTransaction: string; lastValidBlockHeight: number };

export type LiveJupiterOptions = {
  keypair: Keypair;
  connection: Connection;
  slippageBps: number;
  /** SOL kept in the wallet for fees/rent; buys that would dip below are refused. */
  minSolBalance: number;
  fetchImpl?: FetchLike;
};

export class LiveJupiterExecutor implements Executor {
  readonly kind = 'live' as const;

  constructor(private readonly opts: LiveJupiterOptions) {}

  private http(init?: RequestInit) {
    return { fetchImpl: this.opts.fetchImpl, timeoutMs: 15_000, retries: 2, init };
  }

  private async quote(inputMint: string, outputMint: string, amount: string): Promise<QuoteResponse> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount,
      slippageBps: String(this.opts.slippageBps),
      restrictIntermediateTokens: 'true',
    });
    const quote = await fetchJson<QuoteResponse>(`${JUP}/quote?${params}`, this.http());
    if (!quote?.outAmount || BigInt(quote.outAmount) <= 0n) throw new Error(`no Jupiter route ${inputMint} -> ${outputMint}`);
    return quote;
  }

  /** USD price of 1 SOL derived from a SOL->USDC quote. */
  async solPriceUsd(): Promise<number> {
    const q = await this.quote(SOL_MINT, USDC_MINT, String(LAMPORTS));
    return Number(q.outAmount) / 1e6;
  }

  /** Request, sign, send and confirm a swap. No retries here: a resend could double-spend. */
  private async swap(quoteResponse: QuoteResponse): Promise<string> {
    const { keypair, connection } = this.opts;
    const swap = await fetchJson<SwapResponse>(`${JUP}/swap`, {
      ...this.http({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: keypair.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        }),
      }),
      retries: 0,
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    tx.sign([keypair]);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2 });
    const result = await connection.confirmTransaction(
      { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: swap.lastValidBlockHeight },
      'confirmed',
    );
    if (result.value.err) throw new Error(`swap ${signature} failed on-chain: ${JSON.stringify(result.value.err)}`);
    return signature;
  }

  private async tokenBalanceRaw(mint: string): Promise<{ raw: bigint; decimals: number }> {
    const accounts = await this.opts.connection.getParsedTokenAccountsByOwner(this.opts.keypair.publicKey, {
      mint: new PublicKey(mint),
    });
    let raw = 0n;
    let decimals = 0;
    for (const { account } of accounts.value) {
      const info = (account.data as { parsed?: { info?: { tokenAmount?: { amount: string; decimals: number } } } }).parsed?.info
        ?.tokenAmount;
      if (info) {
        raw += BigInt(info.amount);
        decimals = info.decimals;
      }
    }
    if (accounts.value.length === 0) {
      const mintInfo = await this.opts.connection.getParsedAccountInfo(new PublicKey(mint));
      const data = mintInfo.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined;
      decimals = data?.parsed?.info?.decimals ?? 0;
    }
    return { raw, decimals };
  }

  async buy(token: Token, sizeUsd: number): Promise<BuyFill> {
    const solPrice = await this.solPriceUsd();
    const lamports = BigInt(Math.floor((sizeUsd / solPrice) * LAMPORTS));
    const balance = BigInt(await this.opts.connection.getBalance(this.opts.keypair.publicKey));
    const reserve = BigInt(Math.floor(this.opts.minSolBalance * LAMPORTS));
    if (balance - lamports < reserve) {
      throw new Error(`insufficient SOL: balance ${Number(balance) / LAMPORTS}, need ${Number(lamports) / LAMPORTS} + reserve ${this.opts.minSolBalance}`);
    }
    const before = await this.tokenBalanceRaw(token.mint);
    const quote = await this.quote(SOL_MINT, token.mint, lamports.toString());
    const tx = await this.swap(quote);
    const after = await this.tokenBalanceRaw(token.mint);
    const received = after.raw - before.raw > 0n ? after.raw - before.raw : BigInt(quote.outAmount);
    const quantity = Number(received) / 10 ** after.decimals;
    const costUsd = (Number(lamports) / LAMPORTS) * solPrice;
    return { priceUsd: costUsd / quantity, quantity, quantityRaw: received.toString(), costUsd, feeUsd: 0, tx, simulated: false };
  }

  async sell(position: Position): Promise<SellFill> {
    if (!position.quantityRaw) throw new Error(`position ${position.id} has no raw quantity; cannot sell on-chain`);
    const solPrice = await this.solPriceUsd();
    const before = BigInt(await this.opts.connection.getBalance(this.opts.keypair.publicKey));
    const quote = await this.quote(position.mint, SOL_MINT, position.quantityRaw);
    const tx = await this.swap(quote);
    const after = BigInt(await this.opts.connection.getBalance(this.opts.keypair.publicKey));
    // Balance delta already nets out network + priority fees; fall back to the quote if RPC is lagging.
    const lamportsOut = after - before > 0n ? after - before : BigInt(quote.outAmount);
    const proceedsUsd = (Number(lamportsOut) / LAMPORTS) * solPrice;
    return { priceUsd: proceedsUsd / position.quantity, proceedsUsd, feeUsd: 0, tx, simulated: false };
  }
}
