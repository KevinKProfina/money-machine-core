import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { InboxSource, parseCsv, parseInboxFile } from './sources/inbox.js';
import { enginePaths } from './store.js';
import { silentLogger } from './types.js';
import { useTempStateDir } from './test-utils.js';

const FALLBACK = '2026-10-01T00:00:00.000Z';

test('parseCsv handles quotes, escaped quotes, CRLF and blank lines', () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\n\n2,,\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', '', '']]);
});

test('CSV import: valid rows mapped, invalid rows reported, missing id hashed deterministically', () => {
  const csv = [
    'id,stream,kind,amountUsd,timestamp,note',
    'aff-1,amazon-associates,affiliate,12.50,2026-09-30T10:00:00Z,"September payout, part 1"',
    ',etsy,digital-products,8,2026-09-29,',
    'bad-1,etsy,not-a-kind,8,2026-09-29,',
    'bad-2,etsy,digital-products,abc,2026-09-29,',
    'ref-1,etsy,digital-products,-8,,refund',
  ].join('\n');
  const a = parseInboxFile('payouts.csv', csv, FALLBACK);
  const b = parseInboxFile('payouts.csv', csv, FALLBACK);
  assert.equal(a.events.length, 3);
  assert.equal(a.errors.length, 2);
  assert.equal(a.events[0].id, 'manual:aff-1');
  assert.equal(a.events[0].amountUsd, 12.5);
  assert.equal(a.events[0].meta?.note, 'September payout, part 1');
  assert.equal(a.events[0].simulated, false);
  assert.match(a.events[1].id, /^manual:[0-9a-f]{16}$/);
  assert.equal(a.events[1].id, b.events[1].id);
  assert.equal(a.events[2].timestamp, FALLBACK);
  assert.equal(a.events[2].amountUsd, -8);
});

test('JSON import accepts an array or { events: [...] }', () => {
  const arr = parseInboxFile('a.json', JSON.stringify([{ id: '1', stream: 's', kind: 'saas', amountUsd: 5, timestamp: '2026-10-01' }]), FALLBACK);
  assert.equal(arr.events[0].id, 'manual:1');
  const obj = parseInboxFile('b.json', JSON.stringify({ events: [{ id: '2', stream: 's', kind: 'other', amountUsd: '7', simulated: true }] }), FALLBACK);
  assert.equal(obj.events[0].amountUsd, 7);
  assert.equal(obj.events[0].simulated, true);
  assert.throws(() => parseInboxFile('c.json', '{"nope":1}', FALLBACK));
});

test('InboxSource imports files and moves them to processed/ (broken → failed/) only on commit', async () => {
  await useTempStateDir();
  await fsp.mkdir(enginePaths.inbox(), { recursive: true });
  await fsp.writeFile(path.join(enginePaths.inbox(), 'a.csv'), 'id,stream,kind,amountUsd,timestamp,note\n1,aff,affiliate,3,2026-10-01,\n');
  await fsp.writeFile(path.join(enginePaths.inbox(), 'b.json'), '[{"id":"2","stream":"gum","kind":"digital-products","amountUsd":4}]');
  await fsp.writeFile(path.join(enginePaths.inbox(), 'broken.json'), '{not json');
  await fsp.writeFile(path.join(enginePaths.inbox(), 'ignore.txt'), 'x');
  const src = new InboxSource(silentLogger);
  const events = await src.collect();
  assert.deepEqual(events.map((e) => e.id).sort(), ['manual:1', 'manual:2']);
  assert.ok((await fsp.readdir(enginePaths.inbox())).includes('a.csv'));
  await src.commit();
  const left = (await fsp.readdir(enginePaths.inbox(), { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
  assert.deepEqual(left, ['ignore.txt']);
  assert.equal((await fsp.readdir(enginePaths.inboxProcessed())).length, 2);
  assert.equal((await fsp.readdir(enginePaths.inboxFailed())).length, 1);
});
