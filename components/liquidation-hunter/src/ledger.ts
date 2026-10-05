import fsp from 'node:fs/promises';
import path from 'node:path';
import { readJsonSafe, stateDir, writeJsonAtomic } from './mm-contract.js';
import { STRATEGY_NAME } from './config.js';
import type { DecisionRecord, ExecutionRecord } from './types.js';

/** Private state of this strategy: $MM_STATE_DIR/liquidation-hunter/ */
export const ledgerPaths = {
  dir: () => path.join(stateDir(), STRATEGY_NAME),
  decisions: () => path.join(stateDir(), STRATEGY_NAME, 'decisions.jsonl'),
  executions: () => path.join(stateDir(), STRATEGY_NAME, 'executions.jsonl'),
  meta: () => path.join(stateDir(), STRATEGY_NAME, 'state.json'),
};

export type LedgerMeta = {
  schema: 'liquidation-hunter.state/v1';
  /** Fixed at first run: budget at that time, or STARTING_CAPITAL_USD. */
  startingCapitalUsd: number;
  cycles: number;
  createdAt: string;
};

export async function readMeta(): Promise<LedgerMeta | null> {
  const meta = await readJsonSafe<LedgerMeta | null>(ledgerPaths.meta(), null);
  return meta?.schema === 'liquidation-hunter.state/v1' ? meta : null;
}

export async function writeMeta(meta: LedgerMeta): Promise<void> {
  await writeJsonAtomic(ledgerPaths.meta(), meta);
}

async function appendJsonl(file: string, records: unknown[]): Promise<void> {
  if (records.length === 0) return;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

async function readJsonl<T>(file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export const appendDecisions = (records: DecisionRecord[]) => appendJsonl(ledgerPaths.decisions(), records);
export const appendExecutions = (records: ExecutionRecord[]) => appendJsonl(ledgerPaths.executions(), records);
export const readDecisions = () => readJsonl<DecisionRecord>(ledgerPaths.decisions());
export const readExecutions = () => readJsonl<ExecutionRecord>(ledgerPaths.executions());
