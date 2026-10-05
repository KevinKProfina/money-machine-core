import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { enginePaths } from '../store.js';
import { type Logger, type RevenueEvent, type RevenueSource, consoleLogger, isStreamKind, toIsoTimestamp } from '../types.js';

/** RFC-4180-ish CSV parser: quoted fields, escaped quotes (""), commas/newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

export type RawRecord = Record<string, unknown>;

function parseBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'n', ''].includes(s)) return false;
  return undefined;
}

/**
 * Validates one manual/imported record. Columns: id,stream,kind,amountUsd,timestamp,note
 * (+ optional simulated). Missing id → deterministic content hash so re-imports dedupe.
 * Missing timestamp → `fallbackTs`.
 */
export function recordToEvent(rec: RawRecord, fallbackTs: string): { event?: RevenueEvent; error?: string } {
  const stream = String(rec.stream ?? '').trim();
  const kind = String(rec.kind ?? '').trim();
  const amountRaw = rec.amountUsd ?? rec.amount;
  const amount = typeof amountRaw === 'number' ? amountRaw : Number(String(amountRaw ?? '').trim());
  if (!stream) return { error: 'missing stream' };
  if (!isStreamKind(kind)) return { error: `invalid kind "${kind}"` };
  if (amountRaw === undefined || String(amountRaw).trim() === '' || !Number.isFinite(amount)) {
    return { error: `invalid amountUsd "${String(amountRaw)}"` };
  }
  const tsRaw = rec.timestamp;
  const ts = tsRaw === undefined || tsRaw === '' ? fallbackTs : toIsoTimestamp(tsRaw);
  if (!ts) return { error: `invalid timestamp "${String(tsRaw)}"` };
  const note = rec.note === undefined || rec.note === '' ? undefined : String(rec.note);
  const simulated = parseBool(rec.simulated) ?? false;
  let id = String(rec.id ?? '').trim();
  if (!id) {
    id = crypto.createHash('sha256').update(JSON.stringify([stream, kind, amount, ts, note ?? ''])).digest('hex').slice(0, 16);
  }
  return {
    event: {
      id: `manual:${id}`,
      stream,
      kind,
      amountUsd: amount,
      timestamp: ts,
      source: 'inbox',
      simulated,
      meta: note ? { note } : undefined,
    },
  };
}

export function parseInboxFile(
  fileName: string,
  content: string,
  fallbackTs: string,
): { events: RevenueEvent[]; errors: string[] } {
  let records: RawRecord[];
  if (fileName.toLowerCase().endsWith('.json')) {
    const parsed: unknown = JSON.parse(content);
    const list = Array.isArray(parsed) ? parsed : (parsed as { events?: unknown })?.events;
    if (!Array.isArray(list)) throw new Error('JSON must be an array of records or { "events": [...] }');
    records = list as RawRecord[];
  } else {
    const rows = parseCsv(content);
    if (rows.length === 0) return { events: [], errors: [] };
    const header = rows[0].map((h) => h.trim());
    if (!header.includes('stream') || !header.includes('amountUsd')) {
      throw new Error('CSV header must contain at least: stream,kind,amountUsd (columns id,stream,kind,amountUsd,timestamp,note)');
    }
    records = rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
  }
  const events: RevenueEvent[] = [];
  const errors: string[] = [];
  records.forEach((rec, i) => {
    const { event, error } = recordToEvent(rec ?? {}, fallbackTs);
    if (event) events.push(event);
    else errors.push(`record ${i + 1}: ${error}`);
  });
  return { events, errors };
}

/** Imports *.json / *.csv files from the inbox; moves them to processed/ (or failed/) on commit. */
export class InboxSource implements RevenueSource {
  readonly name = 'inbox';
  readonly kind = 'other' as const;
  private moves: Array<{ file: string; ok: boolean }> = [];

  constructor(private readonly log: Logger = consoleLogger) {}

  async collect(): Promise<RevenueEvent[]> {
    this.moves = [];
    const dir = enginePaths.inbox();
    await fsp.mkdir(enginePaths.inboxProcessed(), { recursive: true });
    const files = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && /\.(json|csv)$/i.test(d.name))
      .map((d) => d.name)
      .sort();
    const events: RevenueEvent[] = [];
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        const [content, st] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
        const res = parseInboxFile(file, content, st.mtime.toISOString());
        for (const e of res.errors) this.log.warn(`inbox ${file}: skipped ${e}`);
        events.push(...res.events);
        this.moves.push({ file, ok: true });
      } catch (err) {
        this.log.warn(`inbox ${file}: cannot parse (${(err as Error).message}); moving to inbox/failed/`);
        this.moves.push({ file, ok: false });
      }
    }
    return events;
  }

  async commit(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const { file, ok } of this.moves) {
      const targetDir = ok ? enginePaths.inboxProcessed() : enginePaths.inboxFailed();
      await fsp.mkdir(targetDir, { recursive: true });
      await fsp.rename(path.join(enginePaths.inbox(), file), path.join(targetDir, `${stamp}-${file}`)).catch((err) => {
        this.log.warn(`inbox: could not move ${file}: ${(err as Error).message}`);
      });
    }
    this.moves = [];
  }
}
