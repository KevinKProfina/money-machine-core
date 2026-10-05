import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findAgentByKey, generateApiKey, hashApiKey, isAdmin, parseBearer, safeEqual } from './auth.ts';
import type { Agent } from './types.ts';

test('api keys are random, prefixed and stored only as sha256 hashes', () => {
  const k1 = generateApiKey();
  const k2 = generateApiKey();
  assert.notEqual(k1, k2);
  assert.match(k1, /^amk_[A-Za-z0-9_-]{43}$/);
  assert.match(hashApiKey(k1), /^[0-9a-f]{64}$/);
  assert.notEqual(hashApiKey(k1), k1);
});

test('findAgentByKey accepts the right key and rejects bad keys', () => {
  const key = generateApiKey();
  const agents: Agent[] = [
    { id: 'a1', name: 'x', apiKeyHash: hashApiKey(generateApiKey()), createdAt: '' },
    { id: 'a2', name: 'y', apiKeyHash: hashApiKey(key), createdAt: '' },
  ];
  assert.equal(findAgentByKey(agents, key)?.id, 'a2');
  assert.equal(findAgentByKey(agents, key + 'x'), undefined);
  assert.equal(findAgentByKey(agents, hashApiKey(key)), undefined, 'the hash itself is not a valid key');
  assert.equal(findAgentByKey(agents, undefined), undefined);
  assert.equal(findAgentByKey(agents, ''), undefined);
});

test('bearer parsing and admin check', () => {
  assert.equal(parseBearer('Bearer abc'), 'abc');
  assert.equal(parseBearer('bearer abc '), 'abc');
  assert.equal(parseBearer('Basic abc'), undefined);
  assert.equal(parseBearer(undefined), undefined);
  assert.ok(isAdmin('secret', 'secret'));
  assert.ok(!isAdmin('secret', 'secreT'));
  assert.ok(!isAdmin(undefined, 'anything'));
  assert.ok(!isAdmin('secret', undefined));
  assert.ok(safeEqual('a', 'a'));
  assert.ok(!safeEqual('a', 'ab'));
});
