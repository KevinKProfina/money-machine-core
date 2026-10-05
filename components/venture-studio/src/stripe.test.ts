import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isStripeTestKey, readConfig } from './config.js';
import { formEncode, StripeChannel } from './stripe.js';
import { FakeStripe } from './testing/fake-stripe.js';

test('formEncode encodes nested Stripe keys and skips undefined', () => {
  assert.equal(formEncode({ 'line_items[0][price]': 'price_1', a: undefined, b: 1 }), 'line_items%5B0%5D%5Bprice%5D=price_1&b=1');
});

test('createListing: product → price (cents, currency) → payment link with redirect to the download URL', async () => {
  const fake = new FakeStripe();
  const ch = new StripeChannel('sk_test_abc', { fetchImpl: fake.fetch, backoffMs: 1 });
  assert.equal(ch.simulated, true);
  const listing = await ch.createListing({ ventureId: 'v1', name: 'Kit', description: 'desc', unitAmountCents: 1299, currency: 'eur', downloadUrl: 'https://s.test/kit/tok/', submitMessage: 'Widerruf...' });
  const [p, pr, l] = fake.requests;
  assert.equal(p!.method, 'POST');
  assert.equal(p!.path, '/v1/products');
  assert.equal(p!.body.name, 'Kit');
  assert.equal(p!.body['metadata[venture_id]'], 'v1');
  assert.equal(p!.headers.Authorization, 'Bearer sk_test_abc');
  assert.equal(p!.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(p!.headers['Idempotency-Key']);
  assert.equal(pr!.path, '/v1/prices');
  assert.equal(pr!.body.unit_amount, '1299');
  assert.equal(pr!.body.currency, 'eur');
  assert.equal(pr!.body.product, listing.productId);
  assert.equal(l!.path, '/v1/payment_links');
  assert.equal(l!.body['line_items[0][price]'], listing.priceId);
  assert.equal(l!.body['line_items[0][quantity]'], '1');
  assert.equal(l!.body['after_completion[type]'], 'redirect');
  assert.equal(l!.body['after_completion[redirect][url]'], 'https://s.test/kit/tok/');
  assert.equal(l!.body['custom_text[submit][message]'], 'Widerruf...');
  assert.match(listing.paymentLinkUrl, /^https:\/\//);
});

test('createListing resumes from partial ids and retries 5xx with the same idempotency key', async () => {
  const fake = new FakeStripe();
  const ch = new StripeChannel('sk_test_abc', { fetchImpl: fake.fetch, backoffMs: 1 });
  fake.failNext = { count: 1, status: 500 };
  await ch.createListing({ ventureId: 'v2', name: 'X', description: '', unitAmountCents: 500, currency: 'eur', downloadUrl: 'https://s.test/x/t/', existing: { productId: 'prod_old', priceId: 'price_old' } });
  assert.ok(fake.requests.every((r) => r.path === '/v1/payment_links'));
  assert.equal(fake.requests.length, 2);
  assert.equal(fake.requests[0]!.headers['Idempotency-Key'], fake.requests[1]!.headers['Idempotency-Key']);
  assert.equal(fake.requests[1]!.body['line_items[0][price]'], 'price_old');
});

test('countSales paginates complete sessions and only counts paid ones', async () => {
  const fake = new FakeStripe();
  const ch = new StripeChannel('sk_test_abc', { fetchImpl: fake.fetch, backoffMs: 1 });
  const l = await ch.createListing({ ventureId: 'v', name: 'X', description: '', unitAmountCents: 700, currency: 'eur', downloadUrl: 'https://s.test/' });
  const other = await ch.createListing({ ventureId: 'w', name: 'Y', description: '', unitAmountCents: 100, currency: 'eur', downloadUrl: 'https://s.test/' });
  for (let i = 0; i < 230; i++) fake.sell(l.paymentLinkId);
  fake.sell(l.paymentLinkId, { status: 'open' });
  fake.sell(l.paymentLinkId, { paid: false });
  fake.sell(other.paymentLinkId);
  fake.requests.length = 0;
  const s = await ch.countSales(l.paymentLinkId);
  assert.equal(s.count, 230);
  assert.equal(s.revenueCents, 230 * 700);
  const gets = fake.requests.filter((r) => r.method === 'GET');
  assert.equal(gets.length, 3);
  const u0 = new URL(gets[0]!.url);
  assert.equal(u0.pathname, '/v1/checkout/sessions');
  assert.equal(u0.searchParams.get('payment_link'), l.paymentLinkId);
  assert.equal(u0.searchParams.get('status'), 'complete');
  assert.equal(u0.searchParams.get('limit'), '100');
  assert.equal(u0.searchParams.get('starting_after'), null);
  assert.ok(new URL(gets[1]!.url).searchParams.get('starting_after'));
});

test('deactivate posts active=false to the payment link', async () => {
  const fake = new FakeStripe();
  const ch = new StripeChannel('rk_test_abc', { fetchImpl: fake.fetch, backoffMs: 1 });
  const l = await ch.createListing({ ventureId: 'v', name: 'X', description: '', unitAmountCents: 700, currency: 'eur', downloadUrl: 'https://s.test/' });
  await ch.deactivate(l.paymentLinkId);
  const last = fake.requests[fake.requests.length - 1]!;
  assert.equal(last.method, 'POST');
  assert.equal(last.path, `/v1/payment_links/${l.paymentLinkId}`);
  assert.equal(last.body.active, 'false');
  assert.equal(fake.links.get(l.paymentLinkId)!.active, false);
});

test('test keys are flagged simulated; live keys need MODE=live + confirmation', () => {
  assert.equal(isStripeTestKey('sk_test_1'), true);
  assert.equal(isStripeTestKey('rk_test_1'), true);
  assert.equal(isStripeTestKey('sk_live_1'), false);
  assert.equal(new StripeChannel('sk_live_1').simulated, false);
  const refused = readConfig({ STRIPE_API_KEY: 'sk_live_1' });
  assert.equal(refused.stripe.apiKey, undefined);
  assert.match(refused.stripe.refusedReason!, /MODE=live/);
  const testKey = readConfig({ STRIPE_API_KEY: 'sk_test_1' });
  assert.equal(testKey.stripe.apiKey, 'sk_test_1');
  assert.equal(testKey.stripe.testMode, true);
  const live = readConfig({ STRIPE_API_KEY: 'sk_live_1', MODE: 'live', LIVE_TRADING_CONFIRM: 'I_UNDERSTAND_REAL_MONEY_RISK' });
  assert.equal(live.stripe.apiKey, 'sk_live_1');
  assert.equal(live.stripe.testMode, false);
});
