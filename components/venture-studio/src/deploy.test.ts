import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDeployCmd } from './deploy.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vs-deploy-'));

test('deploy cmd runs in the site dir and captures output', async () => {
  const d = dir();
  const log = path.join(d, 'deploy.log');
  const r = await runDeployCmd('pwd && echo deployed', d, 5000, log);
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.match(r.outputTail, /deployed/);
  assert.ok(r.outputTail.includes(fs.realpathSync(d)) || r.outputTail.includes(d));
  assert.match(fs.readFileSync(log, 'utf8'), /deploy ok/);
});

test('deploy cmd failure and timeout are reported, process is killed', async () => {
  const d = dir();
  const fail = await runDeployCmd('echo nope >&2; exit 3', d, 5000);
  assert.equal(fail.ok, false);
  assert.equal(fail.code, 3);
  assert.match(fail.outputTail, /nope/);
  const started = Date.now();
  const slow = await runDeployCmd('sleep 5; echo never', d, 200);
  assert.equal(slow.ok, false);
  assert.equal(slow.timedOut, true);
  assert.ok(Date.now() - started < 3000);
  assert.doesNotMatch(slow.outputTail, /never/);
});
