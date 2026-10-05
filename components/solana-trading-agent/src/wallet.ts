import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

export type WalletStatus = {
  ok: boolean;
  publicKey?: string;
  solBalance?: number;
  minRequiredSol: number;
  message: string;
};

/** Decode a secret key given as base58 or as a JSON byte array (solana-keygen format). Never logs the key. */
export function loadKeypair(secret: string): Keypair {
  const trimmed = secret.trim();
  try {
    const bytes = trimmed.startsWith('[') ? Uint8Array.from(JSON.parse(trimmed) as number[]) : bs58.decode(trimmed);
    return Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error('SOLANA_PRIVATE_KEY could not be decoded (expected base58 or a JSON byte array)');
  }
}

export async function getWalletStatus(opts: {
  privateKey?: string;
  rpcUrl: string;
  minRequiredSol: number;
  connection?: Pick<Connection, 'getBalance'>;
}): Promise<WalletStatus> {
  if (!opts.privateKey) {
    return { ok: false, minRequiredSol: opts.minRequiredSol, message: 'SOLANA_PRIVATE_KEY not set' };
  }
  const keypair = loadKeypair(opts.privateKey);
  const connection = opts.connection ?? new Connection(opts.rpcUrl, 'confirmed');
  const lamports = await connection.getBalance(keypair.publicKey);
  const solBalance = lamports / LAMPORTS_PER_SOL;
  const ok = solBalance >= opts.minRequiredSol;
  return {
    ok,
    publicKey: keypair.publicKey.toBase58(),
    solBalance,
    minRequiredSol: opts.minRequiredSol,
    message: ok
      ? `wallet funded (${solBalance.toFixed(4)} SOL)`
      : `wallet underfunded (${solBalance.toFixed(4)} SOL < ${opts.minRequiredSol} SOL)`,
  };
}
