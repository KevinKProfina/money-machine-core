import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadEvents, mergeEvents, saveEvents } from './store.js';
import { ev, useTempStateDir } from './test-utils.js';

test('mergeEvents dedupes by id (existing wins, duplicates within a batch collapse)', () => {
  const existing = [ev({ id: 'a', amountUsd: 1 })];
  const { merged, added, invalid } = mergeEvents(existing, [
    ev({ id: 'a', amountUsd: 999 }),
    ev({ id: 'b', amountUsd: 2 }),
    ev({ id: 'b', amountUsd: 3 }),
    { ...ev({ id: 'bad' }), amountUsd: Number.NaN },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((e) => e.id === 'a')?.amountUsd, 1);
  assert.deepEqual(added.map((e) => e.id), ['b']);
  assert.equal(added[0].amountUsd, 2);
  assert.equal(invalid, 1);
});

test('events persist to revenue-engine/events.json and reload', async () => {
  await useTempStateDir();
  assert.deepEqual(await loadEvents(), []);
  await saveEvents([ev({ id: 'z', timestamp: '2026-10-02T00:00:00.000Z' }), ev({ id: 'y' })]);
  const loaded = await loadEvents();
  assert.deepEqual(loaded.map((e) => e.id), ['y', 'z']);
});
