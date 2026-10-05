import 'dotenv/config';
import { readConfig } from './config.js';
import { runCycle } from './cycle.js';
import { emitEvent, readJsonSafe, statePaths, type AllocationProposal } from './mm-contract.js';
import { formatProposalTable } from './report.js';

const args = process.argv.slice(2);

async function printReport(): Promise<void> {
  const proposal = await readJsonSafe<AllocationProposal | null>(statePaths.proposal(), null);
  if (!proposal || proposal.schema !== 'mm.allocation-proposal/v1') {
    console.log(`No allocation proposal at ${statePaths.proposal()} — run \`npm run once\` first.`);
    return;
  }
  console.log(formatProposalTable(proposal));
}

async function fatal(err: unknown): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[capital-allocator] fatal: ${message}`);
  await emitEvent({ source: 'capital-allocator', level: 'error', type: 'fatal', message });
  process.exit(1);
}

async function main(): Promise<void> {
  if (args.includes('report')) return printReport();

  const config = readConfig(); // throws ConfigError on invalid env -> exit 1
  if (args.includes('--once')) {
    await runCycle(config);
    return;
  }

  console.log(`[capital-allocator] loop mode, interval ${config.intervalMs} ms`);
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    try {
      await runCycle(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[capital-allocator] cycle failed: ${message}`);
      await emitEvent({ source: 'capital-allocator', level: 'error', type: 'cycle-failed', message });
    }
    if (stopping) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, config.intervalMs);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
}

main().catch(fatal);
