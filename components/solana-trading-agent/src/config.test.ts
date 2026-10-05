import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_CONFIRM_PHRASE, readConfig, resolveMode } from './config.js';

test('defaults to paper with no MODE/DRY_RUN', () => {
  assert.equal(resolveMode({}, []).mode, 'paper');
  assert.equal(readConfig({}, []).mode, 'paper');
});

test('live requires the exact confirmation phrase', () => {
  const r = resolveMode({ MODE: 'live' }, []);
  assert.equal(r.mode, 'paper');
  assert.match(r.notes[0]!, /LIVE_TRADING_CONFIRM/);
  assert.equal(resolveMode({ MODE: 'live', LIVE_TRADING_CONFIRM: 'yes' }, []).mode, 'paper');
  assert.equal(resolveMode({ MODE: 'live', LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE }, []).mode, 'live');
  assert.equal(resolveMode({ LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE }, ['--mode', 'live']).mode, 'live');
});

test('confirmed live without private key is a config error; paper without key is fine', () => {
  assert.throws(() => readConfig({ MODE: 'live', LIVE_TRADING_CONFIRM: LIVE_CONFIRM_PHRASE }, []), /SOLANA_PRIVATE_KEY/);
  assert.doesNotThrow(() => readConfig({ MODE: 'paper' }, []));
});

test('dry-run via MODE, --mode or DRY_RUN; legacy/unknown modes fall back to paper', () => {
  assert.equal(resolveMode({ MODE: 'dry-run' }, []).mode, 'dry-run');
  assert.equal(resolveMode({}, ['--mode', 'dry-run']).mode, 'dry-run');
  assert.equal(resolveMode({ DRY_RUN: 'true' }, []).mode, 'dry-run');
  assert.equal(resolveMode({ MODE: 'mainnet' }, []).mode, 'paper');
});

test('invalid numbers are rejected', () => {
  assert.throws(() => readConfig({ MAX_USD_PER_TRADE: 'abc' }, []), /MAX_USD_PER_TRADE/);
  assert.throws(() => readConfig({ MAX_POSITION_PCT: '5' }, []), /fraction/);
});
