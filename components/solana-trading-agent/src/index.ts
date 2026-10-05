import dotenv from 'dotenv';
import { Connection } from '@solana/web3.js';
import { emitEvent } from './mm-contract.js';
import { readConfig, STRATEGY_NAME, type AppConfig } from './config.js';
import { sendTelegramAlert } from './alerts.js';
import { createClaudeGate } from './claude-gate.js';
import { runCycle, type CycleDeps } from './cycle.js';
import { PaperExecutor } from './executor.js';
import { LiveJupiterExecutor } from './jupiter.js';
import { DexScreenerSource } from './market.js';
import { getWalletStatus, loadKeypair } from './wallet.js';

dotenv.config({ quiet: true });

function buildDeps(cfg: AppConfig): CycleDeps {
  const deps: CycleDeps = {
    cfg,
    market: new DexScreenerSource(),
    alert: (message) => sendTelegramAlert(message),
  };

  if (cfg.useClaudeGate && cfg.anthropicApiKey) deps.gate = createClaudeGate(cfg.anthropicApiKey);
  else console.log('[init] Claude gate disabled (no ANTHROPIC_API_KEY or USE_CLAUDE_GATE=false); deterministic rules only');

  if (cfg.mode === 'live') {
    // readConfig() already guarantees confirmation phrase + private key for live mode.
    const keypair = loadKeypair(cfg.solanaPrivateKey!);
    const connection = new Connection(cfg.solanaRpcUrl, 'confirmed');
    deps.executor = new LiveJupiterExecutor({ keypair, connection, slippageBps: cfg.liveSlippageBps, minSolBalance: cfg.minSolBalance });
    deps.preTradeCheck = async () => {
      const status = await getWalletStatus({ privateKey: cfg.solanaPrivateKey, rpcUrl: cfg.solanaRpcUrl, minRequiredSol: cfg.minSolBalance, connection });
      return { ok: status.ok, message: status.message };
    };
  } else if (cfg.mode === 'paper') {
    deps.executor = new PaperExecutor(cfg.paperSlippageBps, cfg.paperFeeBps);
  }
  return deps;
}

async function once(deps: CycleDeps): Promise<void> {
  const { report } = await runCycle(deps);
  console.log(
    `[cycle] mode=${report.mode} status=${report.status} open=${report.openPositions} deployed=$${report.deployedUsd} ` +
      `realized=$${report.realizedPnlUsd} unrealized=$${report.unrealizedPnlUsd} trades=${report.totalTrades}`,
  );
}

async function main(): Promise<void> {
  const cfg = readConfig();
  console.log(`[init] ${STRATEGY_NAME} starting in ${cfg.mode.toUpperCase()} mode`);
  for (const note of cfg.modeNotes) console.warn(`[init] ${note}`);
  console.log(`[init] strategy source: ${cfg.strategySource}${cfg.strategySource === 'arena' ? ' (agent-arena promoted genome, re-read every cycle; falls back to static; never changes the mode)' : ''}`);
  const deps = buildDeps(cfg);

  if (process.argv.includes('--once')) {
    await once(deps);
    return;
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
    console.log('[loop] stopping after current cycle');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    try {
      await once(deps);
    } catch (error) {
      const message = `cycle failed: ${(error as Error).message}`;
      console.error(`[loop] ${message}`);
      await emitEvent({ source: STRATEGY_NAME, level: 'error', type: 'cycle.failed', message });
    }
    const until = Date.now() + cfg.pollIntervalMs;
    while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(1_000, until - Date.now())));
  }
}

main().catch(async (error: unknown) => {
  const message = (error as Error).message ?? String(error);
  console.error(`[fatal] ${message}`);
  await emitEvent({ source: STRATEGY_NAME, level: 'error', type: 'fatal', message });
  process.exit(1);
});
