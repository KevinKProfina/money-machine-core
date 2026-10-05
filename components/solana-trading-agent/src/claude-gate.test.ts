import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt, parseGateAnswer } from './claude-gate.js';
import { makeToken } from './testing/fixtures.js';

test('parses strict BUY/SKIP lines', () => {
  assert.deepEqual(parseGateAnswer('BUY: deep liquidity'), { decision: 'BUY', reason: 'deep liquidity' });
  assert.deepEqual(parseGateAnswer('skip - too hyped\nextra'), { decision: 'SKIP', reason: 'too hyped' });
});

test('anything unclear is SKIP', () => {
  assert.equal(parseGateAnswer('').decision, 'SKIP');
  assert.equal(parseGateAnswer('I think you should BUY: it').decision, 'SKIP');
  assert.equal(parseGateAnswer('BUYING: maybe').decision, 'SKIP');
});

test('prompt includes the key market facts', () => {
  const prompt = buildPrompt(makeToken({ symbol: 'ABC' }), 72);
  assert.match(prompt, /ABC/);
  assert.match(prompt, /liquidity: \$400,000/);
  assert.match(prompt, /72\/100/);
});
