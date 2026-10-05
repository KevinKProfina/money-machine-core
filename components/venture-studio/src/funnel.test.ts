import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chooseTrafficSource, FileTrafficSource, HttpTrafficSource } from './analytics.js';
import { appendDecision, pendingApprovals } from './approvals.js';
import { readConfig } from './config.js';
import { computeFunnel, diagnose, siteTraffic, ventureTraffic, type DayAggregate, type Funnel } from './funnel.js';
import { beaconScript, renderCatalog, renderDatenschutz, renderLanding } from './html.js';
import type { FetchLike } from './http.js';
import { historyLine, ideasPrompt } from './prompts.js';
import { analyticsNoticeFor, beaconConfigFor } from './site.js';
import { studioPaths } from './state.js';
import { emptyCheckouts, StripeChannel, tallyCheckouts } from './stripe.js';
import { FakeCollector } from './testing/fake-analytics.js';
import { FakeStripe } from './testing/fake-stripe.js';
import { harness, OPERATOR_ENV, tempStateDir, testConfig, type Harness } from './testing/helpers.js';
import type { LandingCopy, Venture } from './types.js';

beforeEach(() => {
  tempStateDir();
});

const ANALYTICS_ENV = { STUDIO_ANALYTICS_URL: 'https://stats.example.test' };
const T = testConfig().analytics.thresholds; // defaults: 50 visits, 2 % clicks, 3 friction clicks, 25 % completion

const COPY: LandingCopy = { headline: 'H', subheadline: 'S', benefits: ['b'], outline: ['o'], faq: [{ q: 'q', a: 'a' }], metaDescription: 'm' };
const V = { slug: 'my-product', title: 'My product', idea: { language: 'de', price: 9, keywords: ['k'], productType: 'guide' } } as unknown as Venture;

function day(d: string, paths: DayAggregate['paths'], extra: Partial<DayAggregate> = {}): DayAggregate {
  const events = { pageview: 0, buy_click: 0, download: 0 };
  for (const c of Object.values(paths)) for (const e of ['pageview', 'buy_click', 'download'] as const) events[e] += c[e];
  return { schema: 'mm.analytics-day/v1', site: 'shop.example.test', day: d, updatedAt: '', uniqueVisitors: 0, events, paths, referrers: {}, botsFiltered: 0, ...extra };
}
const pc = (pageview: number, buy_click = 0, download = 0, uniqueVisitors = pageview) => ({ pageview, buy_click, download, uniqueVisitors });

function funnel(visits: number | null, clicks: number | null, started: number, complete: number, paid = complete): Funnel {
  return computeFunnel(
    visits === null ? undefined : { visits, uniqueVisitors: visits, buyClicks: clicks ?? 0, downloads: 0, days: 21 },
    { started, open: 0, expired: started - complete, complete, paid, revenueCents: paid * 900 },
    visits === null ? 'none' : 'files',
    '2026-01-01',
  );
}

// ---------------------------------------------------------------- beacon + legal text

test('beacon: on public pages only when STUDIO_ANALYTICS_URL is set; never on previews; < 1 KB; first-party only', () => {
  const cfg = testConfig(ANALYTICS_ENV);
  const beacon = beaconConfigFor(cfg)!;
  assert.deepEqual(beacon, { endpoint: 'https://stats.example.test/e', site: 'shop.example.test' });
  assert.equal(beaconConfigFor(testConfig()), undefined);

  const ctx = { currency: 'eur', priceNote: 'x', buyUrl: 'https://buy.stripe.test/plink_1' };
  const on = renderLanding(V, COPY, { ...ctx, mode: 'live', beacon });
  const off = renderLanding(V, COPY, { ...ctx, mode: 'live' });
  const preview = renderLanding(V, COPY, { ...ctx, mode: 'preview', beacon });
  assert.match(on, /navigator|sendBeacon/);
  assert.match(on, /"\/my-product\/"/, 'fixed landing path, not location.pathname');
  assert.match(on, /buy_click/);
  assert.doesNotMatch(off, /sendBeacon/);
  assert.doesNotMatch(preview, /sendBeacon/);
  assert.doesNotMatch(on, /<script[^>]+src=/, 'no external scripts');
  const tag = beaconScript(beacon, '/my-product/', 'pageview');
  assert.ok(Buffer.byteLength(tag) <= 1024, `beacon is ${Buffer.byteLength(tag)} bytes`);
  assert.match(tag, /doNotTrack|globalPrivacyControl/);
  assert.doesNotMatch(tag, /cookie|localStorage/i);
  const evil = beaconScript({ endpoint: 'https://x.test/e', site: '</script><script>alert(1)' }, '/', 'pageview');
  assert.equal(evil.match(/<\/script>/g)!.length, 1, 'no script breakout');
  assert.match(renderCatalog([], undefined, undefined, beacon), /"\/"/);
  assert.doesNotMatch(renderCatalog([]), /sendBeacon/);
});

test('Datenschutz: truthful collector section when analytics is on; "no analytics" text when off', () => {
  const op = { name: 'Op', address: 'Str. 1', email: 'op@example.test' };
  const off = renderDatenschutz(op, 'stripe');
  assert.match(off, /keine Analyse- oder Tracking-Werkzeuge/);
  assert.doesNotMatch(off, /Reichweitenmessung/);
  const notice = analyticsNoticeFor(testConfig({ ...ANALYTICS_ENV, ANALYTICS_RETENTION_DAYS: '90' }))!;
  const on = renderDatenschutz(op, 'stripe', notice);
  assert.doesNotMatch(on, /keine Analyse- oder Tracking-Werkzeuge/, 'must not claim "no analytics" while measuring');
  for (const re of [/Reichweitenmessung/, /stats\.example\.test/, /keine Cookies/, /täglich verworfen/, /nicht gespeichert/, /nach 90 Tagen gelöscht/, /Art\. 6 Abs\. 1 lit\. f DSGVO/, /Do Not Track/, /Stripe/]) assert.match(on, re);
  assert.equal(analyticsNoticeFor(testConfig()), undefined);
});

test('site: beacon on landing, catalog and digital-product download page (landing path, never the token); Datenschutz toggles', async () => {
  new FakeCollector('shop.example.test');
  const h = await harness({ llm: null, env: ANALYTICS_ENV });
  const v = await liveVenture(h, 'digital-product');
  const site = studioPaths.site();
  const landing = fs.readFileSync(path.join(site, v.slug, 'index.html'), 'utf8');
  assert.match(landing, /sendBeacon/);
  assert.match(fs.readFileSync(path.join(site, 'index.html'), 'utf8'), /sendBeacon/);
  const dl = fs.readFileSync(path.join(site, v.slug, v.publish!.token, 'index.html'), 'utf8');
  assert.match(dl, /"download"/);
  assert.match(dl, new RegExp(`"/${v.slug}/"`));
  assert.ok(!/<script>[^]*?<\/script>/.exec(dl)![0].includes(v.publish!.token), 'token never sent');
  assert.match(fs.readFileSync(path.join(site, 'datenschutz.html'), 'utf8'), /Reichweitenmessung/);
  assert.doesNotMatch(fs.readFileSync(path.join(v.build!.dir, 'landing.html'), 'utf8'), /sendBeacon/, 'preview stays beacon-free');
});

test('site rebuild when analytics is enabled after publishing; traffic counted only from then on', async () => {
  const h = await harness({ llm: null });
  const v = await liveVenture(h);
  assert.doesNotMatch(fs.readFileSync(path.join(studioPaths.site(), v.slug, 'index.html'), 'utf8'), /sendBeacon/);
  assert.match(fs.readFileSync(path.join(studioPaths.site(), 'datenschutz.html'), 'utf8'), /keine Analyse- oder Tracking-Werkzeuge/);
  await h.studio.persist();
  h.advanceDays(3);

  new FakeCollector('shop.example.test');
  const h2 = await harness({ llm: null, env: ANALYTICS_ENV });
  h2.clock.t = h.clock.t;
  const deploys = h2.deploys.length;
  await h2.cycle();
  assert.equal(h2.deploys.length, deploys + 1, 'redeployed with the beacon');
  assert.match(fs.readFileSync(path.join(studioPaths.site(), v.slug, 'index.html'), 'utf8'), /sendBeacon/);
  assert.match(fs.readFileSync(path.join(studioPaths.site(), 'datenschutz.html'), 'utf8'), /Reichweitenmessung/);
  assert.equal(h2.studio.state.site.beacon?.since, new Date(h2.clock.t).toISOString().slice(0, 10));
  await h2.cycle();
  const v2 = h2.studio.state.ventures.find((x) => x.id === v.id)!;
  assert.equal(v2.funnel!.since, h2.studio.state.site.beacon!.since, 'days before the beacon existed are not counted as zero traffic');
});

// ---------------------------------------------------------------- funnel math

test('checkout tally: started vs open/expired/complete, only paid complete sessions are sales', () => {
  const c = tallyCheckouts([
    { id: '1', status: 'complete', payment_status: 'paid', amount_total: 900 },
    { id: '2', status: 'complete', payment_status: 'unpaid', amount_total: 900 },
    { id: '3', status: 'expired', payment_status: 'unpaid' },
    { id: '4', status: 'open', payment_status: 'unpaid' },
    { id: '5', status: 'expired' },
  ]);
  assert.deepEqual(c, { started: 5, open: 1, expired: 2, complete: 2, paid: 1, revenueCents: 900 });
  assert.deepEqual(tallyCheckouts([]), emptyCheckouts());
});

test('StripeChannel.countCheckouts paginates ALL sessions of a link (no status filter)', async () => {
  const fake = new FakeStripe();
  const ch = new StripeChannel('sk_test_x', { fetchImpl: fake.fetch, backoffMs: 1 });
  const l = await ch.createListing({ ventureId: 'v1', name: 'n', description: 'd', unitAmountCents: 500, currency: 'eur', downloadUrl: 'https://x.test/d/' });
  for (let i = 0; i < 120; i++) fake.abandon(l.paymentLinkId);
  fake.abandon(l.paymentLinkId, 'open');
  for (let i = 0; i < 3; i++) fake.sell(l.paymentLinkId);
  const c = await ch.countCheckouts(l.paymentLinkId);
  assert.deepEqual(c, { started: 124, open: 1, expired: 120, complete: 3, paid: 3, revenueCents: 1500 });
  const gets = fake.requests.filter((r) => r.method === 'GET');
  assert.equal(gets.length, 2, 'two pages of 100');
  assert.equal(new URL(gets[0]!.url).searchParams.get('status'), null);
});

test('funnel math: per-venture traffic by slug and window, site totals, rates (null without denominator)', () => {
  const days = [
    day('2026-01-01', { '/my-product/': pc(100, 5), '/other/': pc(7) }, { uniqueVisitors: 90, referrers: { 'google.com': 30 } }),
    day('2026-01-02', { '/my-product/': pc(20, 1, 1, 15), '/my-product-2/': pc(50, 50), '/': pc(3) }, { uniqueVisitors: 60, referrers: { 'google.com': 5, 'bing.com': 9 }, botsFiltered: 4 }),
  ];
  assert.deepEqual(ventureTraffic(days, 'my-product', '2026-01-01'), { visits: 120, uniqueVisitors: 115, buyClicks: 6, downloads: 1, days: 2 });
  assert.deepEqual(ventureTraffic(days, 'my-product', '2026-01-02'), { visits: 20, uniqueVisitors: 15, buyClicks: 1, downloads: 1, days: 1 }, 'window + no prefix collision with my-product-2');
  const s = siteTraffic(days, '2026-01-01');
  assert.equal(s.visits, 180);
  assert.equal(s.uniqueVisitors, 150);
  assert.equal(s.buyClicks, 56);
  assert.equal(s.botsFiltered, 4);
  assert.deepEqual(s.topReferrers, [{ host: 'google.com', visits: 35 }, { host: 'bing.com', visits: 9 }]);

  const f = funnel(200, 10, 8, 2);
  assert.equal(f.clickRate, 0.05);
  assert.equal(f.checkoutCompletionRate, 0.25);
  assert.equal(f.conversionRate, 0.01);
  assert.equal(f.sales, 2);
  const none = funnel(null, null, 0, 0);
  assert.equal(none.visits, null);
  assert.equal(none.trafficSource, 'none');
  assert.equal(none.clickRate, null);
  assert.equal(none.checkoutCompletionRate, null);
  assert.equal(funnel(0, 0, 0, 0).clickRate, null);
});

test('diagnosis thresholds', () => {
  const d = (f: Funnel) => diagnose(f, T).diagnosis;
  assert.equal(d(funnel(0, 0, 0, 0)), 'no-traffic');
  assert.equal(d(funnel(49, 0, 0, 0)), 'no-traffic');
  assert.equal(d(funnel(50, 0, 0, 0)), 'no-interest', 'at the visit threshold');
  assert.equal(d(funnel(500, 2, 2, 0)), 'no-interest', '0.4 % click rate');
  assert.equal(d(funnel(500, 4, 3, 0)), 'no-interest', 'low click rate wins over a few abandoned checkouts');
  assert.equal(d(funnel(100, 2, 2, 0)), 'no-interest', 'click rate ok but too few clicks to speak of friction');
  assert.equal(d(funnel(100, 5, 5, 0)), 'checkout-friction');
  assert.equal(d(funnel(30, 4, 4, 0)), 'checkout-friction', 'few visits but people try to buy');
  assert.equal(d(funnel(100, 10, 10, 1)), 'checkout-friction', 'sold once, but 10 % completion < 25 %');
  assert.equal(d(funnel(100, 10, 10, 3)), 'converting');
  assert.equal(d(funnel(10, 1, 1, 1)), 'converting', 'a sale beats low traffic');
  assert.equal(d(funnel(null, null, 0, 0)), 'unknown', 'no analytics, no Stripe signal');
  assert.equal(d(funnel(null, null, 4, 0)), 'checkout-friction', 'Stripe alone can show friction');
  assert.equal(d(funnel(null, null, 2, 2)), 'converting');
  const strict = { ...T, minVisits: 1000 };
  assert.equal(diagnose(funnel(500, 2, 2, 0), strict).diagnosis, 'no-traffic', 'threshold is configurable');
  assert.match(diagnose(funnel(10, 0, 0, 0), T).reason, /traffic problem, not necessarily a product problem/);
});

// ---------------------------------------------------------------- stats client

test('stats client: HTTP with bearer token via injected fetch; bad responses rejected; source selection', async () => {
  const calls: Array<{ url: string; auth: string | null }> = [];
  let fail = 1;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, auth: new Headers(init?.headers).get('Authorization') });
    if (fail-- > 0) return new Response('busy', { status: 503 });
    return new Response(JSON.stringify({ schema: 'mm.analytics-stats/v1', days: [day('2026-01-01', { '/a/': pc(3) }), { junk: true }] }), { status: 200 });
  };
  const src = new HttpTrafficSource('https://stats.example.test', 'secret-token', { fetchImpl, backoffMs: 1 });
  const days = await src.load('shop.example.test', '2026-01-01', '2026-01-21');
  assert.equal(days.length, 1, 'invalid day objects dropped');
  assert.equal(calls.length, 2, 'retried after 503');
  const u = new URL(calls[1]!.url);
  assert.equal(u.origin + u.pathname, 'https://stats.example.test/stats');
  assert.deepEqual(Object.fromEntries(u.searchParams), { site: 'shop.example.test', from: '2026-01-01', to: '2026-01-21' });
  assert.equal(calls[1]!.auth, 'Bearer secret-token');
  const bad = new HttpTrafficSource('https://stats.example.test', 't', { fetchImpl: async () => new Response('{"hello":1}'), backoffMs: 1 });
  await assert.rejects(bad.load('shop.example.test', '2026-01-01', '2026-01-02'), /unexpected/);
  const unauthorized = new HttpTrafficSource('https://stats.example.test', 't', { fetchImpl: async () => new Response('{}', { status: 401 }), backoffMs: 1 });
  await assert.rejects(unauthorized.load('shop.example.test', '2026-01-01', '2026-01-02'), /401/);

  // selection: none without URL; http with URL+token; files when the collector shares MM_STATE_DIR
  assert.equal(chooseTrafficSource(testConfig()), undefined);
  assert.equal(chooseTrafficSource(testConfig(ANALYTICS_ENV)), undefined, 'URL but neither shared dir nor token');
  assert.equal(chooseTrafficSource(testConfig({ ...ANALYTICS_ENV, ANALYTICS_READ_TOKEN: 'tok' }))?.id, 'http');
  fs.mkdirSync(path.join(process.env.MM_STATE_DIR!, 'analytics'), { recursive: true }); // what the collector's --once leaves behind
  assert.equal(chooseTrafficSource(testConfig({ ...ANALYTICS_ENV, ANALYTICS_READ_TOKEN: 'tok' }))?.id, 'http', 'a bare analytics dir is not a running collector');
  new FakeCollector('shop.example.test', new Date(Date.UTC(2026, 0, 1)));
  const at = { t: Date.UTC(2026, 0, 1, 12) };
  const files = chooseTrafficSource(testConfig({ ...ANALYTICS_ENV, ANALYTICS_READ_TOKEN: 'tok' }), { now: () => new Date(at.t) });
  assert.equal(files?.id, 'files');
  assert.deepEqual(await (files as FileTrafficSource).load('shop.example.test', '2026-01-01', '2026-01-02'), [], 'no data yet');
  at.t += 2 * 86_400_000;
  await assert.rejects((files as FileTrafficSource).load('shop.example.test', '2026-01-01', '2026-01-03'), /heartbeat stale/, 'collector down → no blind zero-traffic data');
  assert.equal(readConfig({ ...OPERATOR_ENV, ...ANALYTICS_ENV, STUDIO_ANALYTICS_SITE: 'Custom.Site' }).analytics.site, 'custom.site');
  assert.throws(() => readConfig({ STUDIO_ANALYTICS_URL: 'https://x.test/?a=1' }));
});

// ---------------------------------------------------------------- decisions

const byState = (h: Harness, s: Venture['state']) => h.studio.state.ventures.filter((v) => v.state === s);

async function cyclesUntil(h: Harness, pred: () => boolean, max = 20): Promise<void> {
  for (let i = 0; i < max && !pred(); i++) await h.cycle();
  assert.ok(pred(), 'condition not reached');
}

async function liveVenture(h: Harness, category?: string): Promise<Venture> {
  await cyclesUntil(h, () => byState(h, 'ready').some((v) => !category || v.idea.category === category));
  const v = byState(h, 'ready').find((x) => !category || x.idea.category === category)!;
  await appendDecision({ ventureId: v.id, decision: 'approved', decidedBy: 'test', decidedAt: new Date(h.clock.t).toISOString() });
  await cyclesUntil(h, () => v.state === 'live', 4);
  return v;
}

async function setup(): Promise<{ h: Harness; v: Venture; col: FakeCollector; at: () => Date }> {
  const col = new FakeCollector('shop.example.test');
  const h = await harness({ llm: null, env: ANALYTICS_ENV });
  const v = await liveVenture(h);
  return { h, v, col, at: () => new Date(h.clock.t) };
}

test('no-traffic after the eval window → kill, recorded as traffic problem (not necessarily product problem)', async () => {
  const { h, v, col, at } = await setup();
  col.record(at(), `/${v.slug}/`, 'pageview', { n: 12, newVisitor: true });
  col.flush();
  h.advanceDays(21.5);
  await h.cycle();
  assert.equal(v.state, 'killed');
  assert.equal(v.funnel!.diagnosis, 'no-traffic');
  assert.equal(v.funnel!.visits, 12);
  assert.match(v.killedReason!, /no sales in 21 days — traffic problem, not necessarily a product problem \(12 landing visits < 50\)/);
  assert.equal(h.studio.state.ventures.filter((x) => x.parentId === v.id).length, 0, 'no re-angle for a traffic problem');
});

test('no-interest → kill + ONE re-angle follow-up (lower price) that goes back through scoring, build, review and the owner gate', async () => {
  const { h, v, col, at } = await setup();
  col.record(at(), `/${v.slug}/`, 'pageview', { n: 300, newVisitor: true });
  col.record(at(), `/${v.slug}/`, 'buy_click');
  col.flush();
  h.advanceDays(21.5);
  await h.cycle();
  assert.equal(v.state, 'killed');
  assert.equal(v.funnel!.diagnosis, 'no-interest');
  assert.match(v.killedReason!, /no interest: 300 visits but only 1 buy click.*re-angle follow-up proposed/);
  const kids = h.studio.state.ventures.filter((x) => x.parentId === v.id);
  assert.equal(kids.length, 1);
  const kid = kids[0]!;
  assert.equal(kid.followUpKind, 'reangle');
  assert.ok(kid.idea.price < v.idea.price);
  assert.equal(v.reanglePending, undefined);
  assert.ok(h.events.some((e) => e.type === 'studio.ideas' && /re-angle/.test(e.message)));
  const mutations = h.stripe.mutations().length;
  await cyclesUntil(h, () => kid.state === 'ready');
  for (let i = 0; i < 3; i++) await h.cycle();
  assert.equal(kid.state, 'ready', 'waits for the owner');
  assert.ok((await pendingApprovals()).some((p) => p.ventureId === kid.id));
  // only the old link deactivation happened on Stripe, nothing was created for the follow-up
  assert.ok(h.stripe.mutations().slice(mutations).every((r) => r.path.startsWith('/v1/payment_links/')));
});

test('no-interest under the kill switch: kill continues, the re-angle idea waits until ideation is allowed again', async () => {
  const { h, v, col, at } = await setup();
  col.record(at(), `/${v.slug}/`, 'pageview', { n: 300, newVisitor: true });
  col.flush();
  h.control.halted = true;
  h.control.reason = 'kill switch active';
  h.advanceDays(21.5);
  await h.cycle();
  assert.equal(v.state, 'killed');
  assert.equal(v.reanglePending, true);
  assert.equal(h.studio.state.ventures.filter((x) => x.parentId === v.id).length, 0);
  h.control.halted = false;
  await h.cycle();
  assert.equal(h.studio.state.ventures.filter((x) => x.parentId === v.id && x.followUpKind === 'reangle').length, 1);
});

test('checkout-friction: flagged in the summary, kept live past the eval window, killed after evalDays × grace factor', async () => {
  const { h, v, col, at } = await setup();
  col.record(at(), `/${v.slug}/`, 'pageview', { n: 120, newVisitor: true });
  col.record(at(), `/${v.slug}/`, 'buy_click', { n: 6 });
  col.flush();
  for (let i = 0; i < 5; i++) h.stripe.abandon(v.publish!.stripe!.paymentLinkId!);
  h.stripe.abandon(v.publish!.stripe!.paymentLinkId!, 'open');
  await h.cycle();
  assert.equal(v.funnel!.diagnosis, 'checkout-friction');
  assert.deepEqual([v.funnel!.checkoutsStarted, v.funnel!.checkoutsExpired, v.funnel!.checkoutsOpen, v.funnel!.checkoutsCompleted], [6, 5, 1, 0]);
  assert.equal(h.events.filter((e) => e.type === 'studio.funnel_alert').length, 1);
  h.advanceDays(22);
  await h.cycle();
  assert.equal(v.state, 'live', 'not killed at the normal eval window');
  const s = await h.studio.persist();
  const att = s.attention.find((a) => a.ventureId === v.id)!;
  assert.equal(att.diagnosis, 'checkout-friction');
  assert.match(att.message, /6 checkouts started, 0 completed/);
  assert.equal(h.events.filter((e) => e.type === 'studio.funnel_alert').length, 1, 'alert only once');
  h.advanceDays(21);
  await h.cycle();
  assert.equal(v.state, 'killed');
  assert.match(v.killedReason!, /no sales in 4\d days — checkout friction/);
});

test('converting: winner rule unchanged; summary carries per-venture funnel and site-wide traffic totals', async () => {
  const { h, v, col, at } = await setup();
  col.record(at(), '/', 'pageview', { n: 10, newVisitor: true, ref: 'duckduckgo.com' });
  col.record(at(), `/${v.slug}/`, 'pageview', { n: 200, newVisitor: true, ref: 'google.com' });
  col.record(at(), `/${v.slug}/`, 'buy_click', { n: 8 });
  col.record(at(), `/${v.slug}/`, 'download', { n: 3 });
  col.bot(at(), 7);
  col.flush();
  for (let i = 0; i < 3; i++) h.stripe.sell(v.publish!.stripe!.paymentLinkId!);
  h.stripe.abandon(v.publish!.stripe!.paymentLinkId!);
  h.advanceDays(21.2);
  await h.cycle();
  assert.equal(v.state, 'winner');
  const s = await h.studio.persist();
  const l = s.live.find((x) => x.ventureId === v.id)!;
  assert.equal(l.diagnosis, 'converting');
  assert.equal(l.funnel!.visits, 200);
  assert.equal(l.funnel!.uniqueVisitors, 200);
  assert.equal(l.funnel!.buyClicks, 8);
  assert.equal(l.funnel!.checkoutsStarted, 4);
  assert.equal(l.funnel!.sales, 3);
  assert.equal(l.funnel!.clickRate, 0.04);
  assert.equal(l.funnel!.conversionRate, 0.015);
  assert.equal(l.funnel!.checkoutCompletionRate, 0.75);
  assert.equal(l.funnel!.trafficSource, 'files');
  assert.equal(s.traffic.enabled, true);
  assert.equal(s.traffic.source, 'files');
  assert.equal(s.traffic.last30d!.visits, 210);
  assert.equal(s.traffic.last30d!.botsFiltered, 7);
  assert.deepEqual(s.traffic.last30d!.topReferrers[0], { host: 'google.com', visits: 200 });
  assert.equal(s.traffic.last7d!.visits, 0, 'traffic was 3 weeks ago');
  assert.equal(s.attention.length, 0);
});

test('without analytics: Stripe-only funnel, plain kill reason, summary says analytics is off', async () => {
  const h = await harness({ llm: null });
  const v = await liveVenture(h);
  h.advanceDays(21.5);
  await h.cycle();
  assert.equal(v.state, 'killed');
  assert.equal(v.killedReason, 'no sales in 21 days');
  assert.equal(v.funnel!.diagnosis, 'unknown');
  assert.equal(v.funnel!.visits, null);
  const s = await h.studio.persist();
  assert.equal(s.traffic.enabled, false);
  assert.ok(s.notes.some((n) => n.includes('analytics off')));
});

test('analytics configured but unreachable: eval decision waits (max 2 days) instead of deciding on missing data', async () => {
  let down = true;
  const h = await harness({
    llm: null,
    env: ANALYTICS_ENV,
    extra: { traffic: { id: 'http', load: async () => (down ? Promise.reject(new Error('ECONNREFUSED')) : []) } },
  });
  const v = await liveVenture(h);
  h.advanceDays(21.5);
  await h.cycle();
  assert.equal(v.state, 'live');
  const s = await h.studio.persist();
  assert.match(s.traffic.error!, /ECONNREFUSED/);
  down = false;
  await h.cycle();
  assert.equal(v.state, 'killed');
  assert.equal(v.funnel!.diagnosis, 'no-traffic');
});

test('ideation learns from diagnoses: history lines and the ideas prompt carry them', async () => {
  const line = historyLine({ title: 'X', category: 'digital-product', state: 'killed', price: 9, sales: 0, diagnosis: 'no-traffic', funnel: 'visits 3', reason: 'no sales in 21 days — traffic problem' });
  assert.match(line, /diagnosis no-traffic \[visits 3\] — no sales/);
  const p = ideasPrompt(2, [{ title: 'X', category: 'digital-product', state: 'killed', diagnosis: 'no-interest' }], []);
  assert.match(p, /diagnosis no-interest/);
  assert.match(p, /no-traffic: almost nobody found the landing page/);

  // end-to-end with the fake Claude: a no-traffic kill shows up in the next ideation prompt
  const col = new FakeCollector('shop.example.test');
  const h = await harness({ llm: { criticScore: 85 }, env: { ...ANALYTICS_ENV, STUDIO_MAX_ACTIVE: '20' } });
  const v = await liveVenture(h);
  col.flush();
  h.advanceDays(21.5);
  await h.cycle();
  assert.equal(v.state, 'killed');
  h.advanceDays(1);
  await h.cycle();
  const prompts = h.llm!.calls.filter((c) => c.task === 'ideas').map((c) => c.prompt);
  assert.ok(prompts.at(-1)!.includes(`[killed] ${v.title}`));
  assert.match(prompts.at(-1)!, /diagnosis no-traffic/);
  assert.match(prompts.at(-1)!, /traffic problem, not necessarily a product problem/);
});

test('simulate: the fake world (visits, clicks, abandoned checkouts) exercises the funnel diagnoses', async () => {
  const { simulate } = await import('./simulate.js');
  const prev = process.env.MM_STATE_DIR;
  const r = await simulate(['--days', '60', '--seed', '2', '--auto-approve', '--quiet']);
  process.env.MM_STATE_DIR = prev;
  assert.ok(Object.keys(r.diagnoses).length >= 3, JSON.stringify(r.diagnoses));
  assert.ok((r.diagnoses['no-traffic'] ?? 0) >= 1);
  assert.match(r.text, /FUNNEL DIAGNOSES/);
  assert.match(r.text, /TRAFFIC \(files/);
  assert.match(r.text, /funnel: visits \d+/);
});
