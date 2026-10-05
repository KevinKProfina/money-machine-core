// Read-only wallet health check: prints public key and SOL balance. Never prints the secret key.
import dotenv from 'dotenv';
import { getWalletStatus } from './wallet.js';

dotenv.config({ quiet: true });

try {
  const status = await getWalletStatus({
    privateKey: process.env.SOLANA_PRIVATE_KEY,
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    minRequiredSol: Number(process.env.MIN_SOL_BALANCE ?? '0.05'),
  });
  console.log(JSON.stringify(status, null, 2));
  process.exit(status.ok ? 0 : 1);
} catch (error) {
  console.error(`wallet check failed: ${(error as Error).message}`);
  process.exit(1);
}
