import crypto from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runCycle } from './engine.js';
import { loadDotEnv } from './env.js';
import { writeJsonAtomic } from './mm-contract.js';
import { InboxSource, recordToEvent } from './sources/inbox.js';
import { enginePaths } from './store.js';
import { STREAM_KINDS } from './types.js';

const USAGE = `usage: npm run add -- --stream <name> --kind <${STREAM_KINDS.join('|')}> --amount <usd> [--note "..."] [--timestamp ISO] [--id <unique-id>] [--simulated]`;

/**
 * Records a manual event by dropping it into the inbox and running an inbox-only cycle,
 * so it goes through the same validation/dedupe path and the lock as every other import.
 */
async function main(): Promise<void> {
  loadDotEnv();
  const { values } = parseArgs({
    options: {
      stream: { type: 'string' },
      kind: { type: 'string' },
      amount: { type: 'string' },
      note: { type: 'string' },
      timestamp: { type: 'string' },
      id: { type: 'string' },
      simulated: { type: 'boolean', default: false },
    },
  });
  const now = new Date().toISOString();
  const record = {
    id: values.id ?? `cli-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    stream: values.stream,
    kind: values.kind,
    amountUsd: values.amount,
    timestamp: values.timestamp ?? now,
    note: values.note,
    simulated: values.simulated,
  };
  const { event, error } = recordToEvent(record, now);
  if (!event) {
    console.error(`[revenue-engine] ERROR ${error}\n${USAGE}`);
    process.exit(2);
  }
  const file = path.join(enginePaths.inbox(), `cli-${record.id}.json`);
  await writeJsonAtomic(file, [record]);
  const { added } = await runCycle({ sources: () => [new InboxSource()] });
  if (added.some((e) => e.id === event.id)) {
    console.log(`recorded ${event.id}: ${event.amountUsd.toFixed(2)} USD → ${event.stream} (${event.kind})${event.simulated ? ' [simulated]' : ''}`);
  } else {
    console.log(`event ${event.id} already recorded (duplicate id) — nothing added`);
  }
}

main().catch((err) => {
  console.error(`[revenue-engine] ERROR ${(err as Error).message}`);
  process.exit(1);
});
