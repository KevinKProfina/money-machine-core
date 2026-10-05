import { addressPort, runOnce, startDaemon } from './app.ts';
import { loadConfig } from './config.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.argv.includes('--once')) {
    await runOnce(config);
    return;
  }
  const daemon = await startDaemon(config);
  console.log(`[agent-marketplace] listening on http://${config.host}:${addressPort(daemon.server)} (state: ${config.stateFile})`);
  const shutdown = (signal: string) => {
    console.log(`[agent-marketplace] ${signal} received, shutting down`);
    daemon.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(`[agent-marketplace] fatal: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});
