import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendDecision, decide, pendingApprovals, readApprovals } from './approvals.js';
import { readConfig } from './config.js';
import { runCli, runOnce } from './index.js';
import { readJsonSafe } from './mm-contract.js';
import { studioPaths } from './state.js';
import type { StudioSummary } from './summary.js';
import { harness, tempStateDir, type Harness } from './testing/helpers.js';
import type { Venture } from './types.js';

beforeEach(() => {
  tempStateDir();
});

async function cyclesUntil(h: Harness, pred: () => boolean, max = 20): Promise<void> {
  for (let i = 0; i < max && !pred(); i++) await h.cycle();
  assert.ok(pred(), 'condition not reached');
}

const byState = (h: Harness, s: Venture['state']) => h.studio.state.ventures.filter((v) => v.state === s);
const approveAt = (h: Harness, id: string) => appendDecision({ ventureId: id, decision: 'approved', decidedBy: 'test', decidedAt: new Date(h.clock.t).toISOString() });

test('state machine (offline seeds): idea → queued → review → ready, one stage per cycle; non-buildable parked; forbidden rejected', async () => {
  const h = await harness({ llm: null });
  await h.cycle();
  const vs = h.studio.state.ventures;
  assert.equal(vs.length, 3); // STUDIO_IDEAS_PER_DAY
  assert.ok(vs.every((v) => v.source === 'seed'));
  const parked = vs.find((v) => v.idea.category === 'content-site')!;
  assert.equal(parked.state, 'parked');
  assert.ok(parked.humanSteps.length > 0);
  assert.ok(parked.autonomyScore < 1);
  const buildable = vs.filter((v) => v.state === 'idea');
  assert.equal(buildable.length, 2);

  await h.cycle();
  for (const v of buildable) assert.equal(v.state, 'queued', `${v.slug} ${v.rejectedReason ?? ''}`);
  await h.cycle();
  for (const v of buildable) assert.equal(v.state, 'review');
  for (const v of buildable) {
    assert.ok(fs.existsSync(path.join(v.build!.dir, 'landing.html')));
    assert.ok(fs.existsSync(path.join(v.build!.dir, 'product.html')));
  }
  await h.cycle();
  for (const v of buildable) assert.equal(v.state, 'ready');
  const pend = await pendingApprovals();
  assert.deepEqual(pend.map((p) => p.ventureId).sort(), buildable.map((v) => v.id).sort());
  assert.ok(pend.every((p) => p.policyReport.pass && fs.existsSync(path.join(p.previewPath, 'landing.html'))));
  assert.ok(h.events.some((e) => e.type === 'studio.ideas'));
  assert.equal(h.events.filter((e) => e.type === 'studio.ready_for_approval').length, 2);

  // the gambling seed is rejected by the hard filter once ideation continues the next day
  h.advanceDays(1);
  await cyclesUntil(h, () => h.studio.state.ventures.some((v) => v.seedKey === 'sportwetten-guide' && v.state === 'rejected'), 60);
});

test('GATE: nothing is deployed or created on Stripe while approval is pending or rejected', async () => {
  const h = await harness({ llm: null });
  for (let i = 0; i < 12; i++) await h.cycle();
  const ready = byState(h, 'ready');
  assert.equal(ready.length, 2);
  assert.equal(h.stripe.requests.length, 0, 'no Stripe request at all while pending');
  assert.equal(h.deploys.length, 0, 'no deploy while pending');
  assert.equal(fs.existsSync(studioPaths.site()), false, 'no public site while pending');

  // owner rejects one
  const res = await decide(ready[0]!.id, 'rejected', { decidedBy: 'test', note: 'not my brand' });
  assert.equal(res.ok, true);
  for (let i = 0; i < 5; i++) await h.cycle();
  assert.equal(ready[0]!.state, 'rejected');
  assert.equal(ready[0]!.rejectedBy, 'owner');
  assert.match(ready[0]!.rejectedReason!, /not my brand/);
  assert.equal(h.stripe.requests.length, 0);
  assert.equal(h.deploys.length, 0);
  assert.equal(ready[1]!.state, 'ready');
  assert.ok(h.events.some((e) => e.type === 'studio.rejected'));
});

test('approve via approvals module → publish: Stripe listing, site, deploy', async () => {
  const h = await harness({ llm: null });
  await cyclesUntil(h, () => byState(h, 'ready').length === 2);
  const v = byState(h, 'ready').find((x) => x.idea.category === 'digital-product')!;
  await approveAt(h, v.id);
  await h.cycle();
  assert.equal(v.state, 'approved');
  assert.equal(h.stripe.requests.length, 0, 'approval is recorded first; publish happens in the next stage');
  await h.cycle();
  assert.equal(v.state, 'live');
  const posts = h.stripe.mutations().map((r) => r.path);
  assert.deepEqual(posts, ['/v1/products', '/v1/prices', '/v1/payment_links']);
  assert.match(v.publish!.token, /^[0-9a-f]{32}$/);
  assert.equal(v.publish!.downloadUrl, `https://shop.example.test/${v.slug}/${v.publish!.token}/`);
  assert.equal(h.stripe.mutations()[2]!.body['after_completion[redirect][url]'], v.publish!.downloadUrl);
  assert.equal(h.deploys.length, 1);
  const site = studioPaths.site();
  for (const f of ['index.html', 'impressum.html', 'datenschutz.html', 'sitemap.xml', 'robots.txt', `${v.slug}/index.html`, `${v.slug}/${v.publish!.token}/index.html`]) assert.ok(fs.existsSync(path.join(site, f)), f);
  const landing = fs.readFileSync(path.join(site, v.slug, 'index.html'), 'utf8');
  assert.match(landing, /buy\.stripe\.test/);
  assert.match(landing, /application\/ld\+json/);
  assert.match(landing, /og:title/);
  assert.match(landing, /AI-assisted/);
  assert.match(landing, /§ 356 Abs\. 5 BGB/);
  assert.doesNotMatch(landing, /noindex/);
  assert.match(fs.readFileSync(path.join(site, 'sitemap.xml'), 'utf8'), new RegExp(v.slug));
  assert.doesNotMatch(fs.readFileSync(path.join(site, 'sitemap.xml'), 'utf8'), new RegExp(v.publish!.token));
  assert.match(fs.readFileSync(path.join(site, 'impressum.html'), 'utf8'), /Test Operator/);
  // the other (still pending) venture is not on the site
  const other = byState(h, 'ready')[0]!;
  assert.equal(fs.existsSync(path.join(site, other.slug)), false);
  assert.ok(h.events.some((e) => e.type === 'studio.approved'));
  assert.ok(h.events.some((e) => e.type === 'studio.publish'));
});

test('legal-page blocker: no operator details → blocked, nothing public; recovers once configured', async () => {
  const h = await harness({ llm: null, env: { STUDIO_OPERATOR_NAME: '', STUDIO_OPERATOR_ADDRESS: '', STUDIO_OPERATOR_EMAIL: '' } });
  await cyclesUntil(h, () => byState(h, 'ready').length > 0);
  const v = byState(h, 'ready')[0]!;
  await approveAt(h, v.id);
  await h.cycle();
  await h.cycle();
  assert.equal(v.state, 'blocked');
  assert.equal(v.blocked!.kind, 'operator');
  assert.match(v.blocked!.reasons[0]!, /operator details missing/);
  assert.equal(h.stripe.requests.length, 0);
  assert.equal(h.deploys.length, 0);
  assert.ok(h.events.some((e) => e.type === 'studio.blocked'));
  await h.studio.persist();

  const h2 = await harness({ llm: null });
  h2.clock.t = h.clock.t;
  await h2.cycle();
  const v2 = h2.studio.state.ventures.find((x) => x.id === v.id)!;
  assert.equal(v2.state, 'approved');
  await h2.cycle();
  assert.equal(v2.state, 'live');
});

async function liveVenture(h: Harness): Promise<Venture> {
  await cyclesUntil(h, () => byState(h, 'ready').length > 0);
  const v = byState(h, 'ready')[0]!;
  await approveAt(h, v.id);
  await cyclesUntil(h, () => v.state === 'live', 4);
  return v;
}

test('kill after eval window with zero sales: link deactivated, page discontinued, removed from catalog + sitemap, redeployed', async () => {
  const h = await harness({ llm: null });
  const v = await liveVenture(h);
  const deploysBefore = h.deploys.length;
  h.advanceDays(20);
  await h.cycle();
  assert.equal(v.state, 'live', 'not before STUDIO_EVAL_DAYS');
  h.advanceDays(1.5);
  await h.cycle();
  assert.equal(v.state, 'killed');
  assert.match(v.killedReason!, /no sales in 21 days/);
  assert.equal(v.publish!.stripe!.deactivated, true);
  const deact = h.stripe.mutations().find((r) => r.path === `/v1/payment_links/${v.publish!.stripe!.paymentLinkId}`);
  assert.equal(deact?.body.active, 'false');
  assert.equal(h.deploys.length, deploysBefore + 1);
  const site = studioPaths.site();
  const landing = fs.readFileSync(path.join(site, v.slug, 'index.html'), 'utf8');
  assert.match(landing, /nicht mehr erhältlich|discontinued/);
  assert.doesNotMatch(landing, /buy\.stripe\.test/);
  assert.doesNotMatch(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), new RegExp(`href="${v.slug}/"`));
  assert.doesNotMatch(fs.readFileSync(path.join(site, 'sitemap.xml'), 'utf8'), new RegExp(v.slug));
  assert.ok(fs.existsSync(path.join(site, v.slug, v.publish!.token, 'index.html')), 'buyers keep their download');
  assert.ok(h.events.some((e) => e.type === 'studio.kill'));
});

test('winner after eval window spawns follow-ups that go back through the gate', async () => {
  const h = await harness({ llm: null });
  const v = await liveVenture(h);
  for (let i = 0; i < 3; i++) h.stripe.sell(v.publish!.stripe!.paymentLinkId!);
  await h.cycle();
  assert.equal(v.sales!.count, 3);
  assert.equal(v.sales!.simulated, true);
  assert.equal(v.state, 'live', 'winner only after the eval window');
  h.advanceDays(21.1);
  await h.cycle();
  assert.equal(v.state, 'winner');
  assert.ok(h.events.some((e) => e.type === 'studio.winner'));
  await h.cycle();
  const kids = h.studio.state.ventures.filter((x) => x.parentId === v.id);
  assert.ok(kids.length >= 1 && kids.length <= 2);
  assert.ok(kids.every((k) => k.generation === 1));
  const mutationsBefore = h.stripe.mutations().length;
  await cyclesUntil(h, () => kids.every((k) => k.state === 'ready'));
  for (let i = 0; i < 3; i++) await h.cycle();
  assert.ok(kids.every((k) => k.state === 'ready'), 'follow-ups wait for approval');
  assert.equal(h.stripe.mutations().length, mutationsBefore, 'no Stripe objects for unapproved follow-ups');
  assert.ok((await pendingApprovals()).some((p) => p.ventureId === kids[0]!.id));
});

test('kill switch: no ideation/build/publish, but measuring and killing continue', async () => {
  const h = await harness({ llm: null });
  const v = await liveVenture(h);
  const other = byState(h, 'ready')[0];
  if (other) await approveAt(h, other.id);
  h.control.halted = true;
  h.control.reason = 'kill switch active';
  const count = h.studio.state.ventures.length;
  const mutations = h.stripe.mutations().length;
  h.advanceDays(2);
  await h.cycle();
  assert.equal(h.studio.state.ventures.length, count, 'no ideation');
  if (other) assert.equal(other.state, 'approved', 'approval is recorded, but not published under kill switch');
  assert.equal(h.stripe.mutations().length, mutations, 'nothing created on Stripe');
  h.advanceDays(21);
  await h.cycle();
  assert.equal(v.state, 'killed', 'killing continues under kill switch');
  assert.ok(h.stripe.requests.some((r) => r.method === 'GET'), 'measuring continues');
  const summary = await h.studio.persist();
  assert.equal(summary.halted, true);
});

test('Claude path: ideas, critic, build, policy revision once, then ready; stubborn violations → blocked', async () => {
  const h = await harness({ llm: { badDraftRate: 1, stubbornRate: 0, criticScore: 80 }, env: { STUDIO_IDEAS_PER_DAY: '5' } });
  await cyclesUntil(h, () => byState(h, 'ready').length > 0, 10);
  const ready = byState(h, 'ready')[0]!;
  assert.equal(ready.source, 'claude');
  assert.equal(ready.build!.revisions, 1);
  assert.equal(ready.policy!.claudeReviewed, true);
  assert.ok(h.llm!.count('revise') >= 1);
  assert.ok(byState(h, 'parked').length + h.studio.state.ventures.filter((v) => v.state !== 'parked').length === h.studio.state.ventures.length);
  const policyReview = h.llm!.calls.find((c) => c.task === 'review')!;
  assert.equal(policyReview.effort, 'low');
  assert.equal(h.llm!.calls.find((c) => c.task === 'product')!.effort, 'medium');

  tempStateDir();
  const h2 = await harness({ llm: { badDraftRate: 1, stubbornRate: 1, criticScore: 80 } });
  await cyclesUntil(h2, () => byState(h2, 'blocked').length > 0, 10);
  const b = byState(h2, 'blocked')[0]!;
  assert.equal(b.blocked!.kind, 'policy');
  assert.ok(b.blocked!.reasons.some((r) => r.includes('income-guarantee')));
  assert.equal(h2.stripe.requests.length, 0);
});

test('Claude refusal fails the step gracefully; low critic score is rejected with reasons', async () => {
  const h = await harness({ llm: { refuseTasks: ['product'], criticScore: 90 } });
  await cyclesUntil(h, () => byState(h, 'blocked').length > 0, 10);
  assert.match(byState(h, 'blocked')[0]!.blocked!.reasons[0]!, /refused/);

  tempStateDir();
  const h2 = await harness({ llm: { criticScore: 20 } });
  await h2.cycle();
  await h2.cycle();
  const rej = byState(h2, 'rejected');
  assert.ok(rej.length > 0);
  assert.ok(rej.every((v) => v.rejectedBy === 'scoring' && /critic 20/.test(v.rejectedReason!)));
});

test('LLM budget cap: no call is made when the worst case exceeds the daily budget', async () => {
  const h = await harness({ llm: {}, env: { STUDIO_LLM_DAILY_BUDGET_USD: '0.001' } });
  for (let i = 0; i < 3; i++) await h.cycle();
  assert.equal(h.llm!.calls.length, 0);
  assert.equal(h.studio.state.ventures.length, 0);
  assert.ok(h.studio.state.llm.budgetSkips >= 1);
  assert.equal(h.studio.state.llm.totalUsd, 0);
});

test('channel none: approved ventures go live as "coming soon", never become winners', async () => {
  const h = await harness({ llm: null, channel: 'none' });
  const v = await liveVenture(h);
  assert.equal(v.publish!.channel, 'none');
  const landing = fs.readFileSync(path.join(studioPaths.site(), v.slug, 'index.html'), 'utf8');
  assert.match(landing, /Bald verfügbar|Coming soon/);
  h.advanceDays(40);
  await h.cycle();
  assert.equal(v.state, 'live');
  const s = await h.studio.persist();
  assert.equal(s.channel, 'none');
  assert.ok(s.blockers.some((b) => b.includes('STRIPE_API_KEY')));
});

test('full --once cycles in a temp MM_STATE_DIR without secrets', async () => {
  const cfg = readConfig({});
  let summary: StudioSummary | undefined;
  for (let i = 0; i < 5; i++) summary = await runOnce({ cfg, emit: async () => undefined, log: () => undefined });
  assert.ok(summary);
  const onDisk = await readJsonSafe<StudioSummary | null>(studioPaths.summary(), null);
  assert.equal(onDisk?.schema, 'mm.studio-summary/v1');
  assert.equal(onDisk?.channel, 'none');
  assert.ok(onDisk!.pendingApprovals.length >= 1);
  assert.ok(onDisk!.parkedOpportunities.length >= 1);
  assert.ok(onDisk!.blockers.some((b) => b.includes('operator details missing')));
  assert.equal(onDisk!.llm.enabled, false);
  assert.equal(fs.existsSync(studioPaths.site()), false);
  assert.equal((await readApprovals()).schema, 'mm.studio-approvals/v1');
  for (const k of ['idea', 'parked', 'rejected', 'queued', 'review', 'ready', 'approved', 'live', 'winner', 'killed', 'blocked']) assert.equal(typeof onDisk!.counts[k as Venture['state']], 'number');
});

test('CLI: --auto-approve is refused outside simulate; approve/reject write decision lines', async () => {
  assert.equal(await runCli(['--auto-approve']), 2);
  assert.equal(await runCli(['--once', '--auto-approve']), 2);
  const cfg = readConfig({});
  for (let i = 0; i < 4; i++) await runOnce({ cfg, emit: async () => undefined, log: () => undefined });
  const [p] = await pendingApprovals();
  assert.ok(p);
  assert.equal(await runCli(['approve', 'v9999']), 1);
  assert.equal(await runCli(['reject', p.ventureId, 'too', 'generic']), 0);
  const line = JSON.parse(fs.readFileSync(studioPaths.decisions(), 'utf8').trim());
  assert.equal(line.decision, 'rejected');
  assert.equal(line.note, 'too generic');
  await runOnce({ cfg, emit: async () => undefined, log: () => undefined });
  const req = (await readApprovals()).requests.find((r) => r.ventureId === p.ventureId)!;
  assert.equal(req.decision, 'rejected');
});
