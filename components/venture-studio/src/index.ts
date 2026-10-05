import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { decide, pendingApprovals } from './approvals.js';
import { COMPONENT_NAME, ConfigError, readConfig } from './config.js';
import { emitEvent, readJsonSafe } from './mm-contract.js';
import { acquireLock, studioPaths } from './state.js';
import { Studio, type StudioDeps } from './studio.js';
import { summaryText, type StudioSummary } from './summary.js';

const USAGE = `usage:
  tsx src/index.ts --once | once        run one cycle and exit
  tsx src/index.ts start                loop (STUDIO_INTERVAL_MS, default 1h)
  tsx src/index.ts status               print the last summary + pending approvals
  tsx src/index.ts approve <ventureId>  approve a pending venture (launch gate)
  tsx src/index.ts reject <ventureId> [note]`;

export async function runOnce(deps: Omit<StudioDeps, 'cfg'> & { cfg?: StudioDeps['cfg'] } = {}): Promise<StudioSummary | undefined> {
  const cfg = deps.cfg ?? readConfig();
  const release = await acquireLock();
  if (!release) {
    console.warn('[studio] another studio cycle is running (lock held); skipping');
    return undefined;
  }
  try {
    const studio = await Studio.open({ ...deps, cfg });
    const started = Date.now();
    await studio.cycle();
    const summary = await studio.persist();
    const c = summary.counts;
    console.log(
      `[studio] cycle=${summary.cycle} channel=${summary.channel}${summary.salesSimulated ? '(simulated)' : ''} ideas=${c.idea} queued=${c.queued} review=${c.review} ` +
        `pending-approval=${summary.pendingApprovals.length} live=${c.live} winners=${c.winner} killed=${c.killed} blocked=${c.blocked} parked=${c.parked} ` +
        `llm-today=$${summary.llm.todayUsd.toFixed(3)} (${Date.now() - started} ms)`,
    );
    for (const b of summary.blockers) console.log(`[studio] blocker: ${b}`);
    return summary;
  } finally {
    await release();
  }
}

export async function runCli(argv: string[]): Promise<number> {
  if (argv.includes('--auto-approve')) {
    console.error('--auto-approve is only available inside `npm run simulate` (offline). The real runner always waits for the owner.');
    return 2;
  }
  const positional = argv.filter((a) => !a.startsWith('--'));
  const command = argv.includes('--once') ? 'once' : (positional[0] ?? 'start');

  switch (command) {
    case 'once':
      await runOnce();
      return 0;
    case 'status': {
      const summary = await readJsonSafe<StudioSummary | null>(studioPaths.summary(), null);
      if (!summary) console.log('no summary yet (run `npm run once`)');
      else console.log(summaryText(summary));
      const pend = await pendingApprovals();
      if (pend.length && !summary) for (const p of pend) console.log(`pending: ${p.ventureId} ${p.title} ${p.previewPath}`);
      return 0;
    }
    case 'approve':
    case 'reject': {
      const id = positional[1];
      if (!id) {
        console.error(USAGE);
        return 2;
      }
      const note = positional.slice(2).join(' ') || undefined;
      const res = await decide(id, command === 'approve' ? 'approved' : 'rejected', { decidedBy: `cli:${os.userInfo().username}`, note });
      if (!res.ok) {
        console.error(`[studio] ${res.error}`);
        return 1;
      }
      console.log(`[studio] ${id} ${res.line.decision} — recorded in ${path.relative(process.cwd(), studioPaths.decisions())}; applied on the next studio cycle`);
      return 0;
    }
    case 'start': {
      const cfg = readConfig();
      let stopping = false;
      const stop = () => {
        stopping = true;
        console.log('[loop] stopping after current cycle');
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      while (!stopping) {
        try {
          await runOnce({ cfg });
        } catch (error) {
          const message = `cycle failed: ${(error as Error).message}`;
          console.error(`[loop] ${message}`);
          await emitEvent({ source: COMPONENT_NAME, level: 'error', type: 'cycle.failed', message });
        }
        const until = Date.now() + cfg.intervalMs;
        while (!stopping && Date.now() < until) await new Promise((r) => setTimeout(r, Math.min(1_000, until - Date.now())));
      }
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('src', 'index.ts'));
if (isMain) {
  dotenv.config({ quiet: true });
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch(async (error: unknown) => {
      const message = (error as Error).message ?? String(error);
      console.error(`[fatal] ${message}`);
      await emitEvent({ source: COMPONENT_NAME, level: 'error', type: error instanceof ConfigError ? 'config.refused' : 'fatal', message });
      process.exit(1);
    });
}
