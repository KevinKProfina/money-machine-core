import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMicroTool, combineScore, computeAutonomy, ideaHardFilter, scanContent } from './policy.js';
import { SEEDS } from './seeds.js';
import type { Idea } from './types.js';

const rules = (text: string) => scanContent(text, 'test').map((f) => f.rule);

test('policy regex: income guarantees and get-rich-quick', () => {
  assert.ok(rules('Mit diesem Guide verdienst du garantiert 1000€ im Monat.').includes('income-guarantee'));
  assert.ok(rules('garantiert 1000€ im Monat').includes('income-guarantee'));
  assert.ok(rules('You will earn $5,000 per month from home').includes('income-guarantee'));
  assert.ok(rules('Guaranteed results within a week').includes('income-guarantee'));
  assert.ok(rules('So wirst du schnell reich').includes('get-rich-quick'));
});

test('policy regex: fake testimonials, ratings, user counts, scarcity', () => {
  assert.ok(rules('Was unsere Kunden sagen: super!').includes('fake-testimonial'));
  assert.ok(rules('"Dieses Paket hat mein Geschäft verändert!" – Maria K.').includes('fake-testimonial'));
  assert.ok(rules('★★★★★ 4.9 von 5 Sternen').includes('fake-rating'));
  assert.ok(rules('Bereits über 2.000 zufriedene Kunden').includes('fake-user-count'));
  assert.ok(rules('Trusted by 10,000 teams').includes('fake-user-count'));
  assert.ok(rules('Nur noch 3 Exemplare verfügbar!').includes('fake-scarcity'));
  assert.ok(rules('Offer ends tonight').includes('fake-scarcity'));
});

test('policy regex: regulated advice and restricted categories', () => {
  assert.ok(rules('Dieser Tee heilt Depressionen').includes('medical-advice'));
  assert.ok(rules('Kaufen Sie diese Aktie jetzt').includes('financial-advice'));
  assert.ok(rules('Die besten Sportwetten-Strategien').includes('restricted-category'));
  assert.ok(rules('inklusive 1:1-Coaching mit mir').includes('undeliverable-claim'));
});

test('policy regex: clean texts pass (no false positives on seed content)', () => {
  assert.deepEqual(rules('Ein Rechner für deinen Stundensatz. Läuft offline im Browser.'), []);
  for (const seed of SEEDS) {
    if (!seed.product || !seed.copy) continue;
    const product = seed.product();
    assert.deepEqual(scanContent(product, 'product'), [], `seed ${seed.key} product`);
    const copyText = [seed.copy.headline, seed.copy.subheadline, ...seed.copy.benefits, ...seed.copy.outline, ...seed.copy.faq.flatMap((f) => [f.q, f.a]), seed.copy.metaDescription].join('\n');
    assert.deepEqual(scanContent(copyText, 'landing'), [], `seed ${seed.key} copy`);
    if (seed.idea.category === 'micro-tool') assert.deepEqual(checkMicroTool(product), [], `seed ${seed.key} tool`);
  }
});

test('micro-tool check: no network, must be self-contained HTML with inline JS', () => {
  const ok = '<!doctype html><html><body><script>let x = 1;</script></body></html>';
  assert.deepEqual(checkMicroTool(ok), []);
  assert.ok(checkMicroTool('<!doctype html><script src="https://cdn.example.com/x.js"></script><script>1</script>').some((i) => i.includes('external')));
  assert.ok(checkMicroTool('<!doctype html><script>fetch("/api")</script>').some((i) => i.includes('fetch')));
  assert.ok(checkMicroTool('<!doctype html><script>new WebSocket("wss://x")</script>').some((i) => i.includes('WebSocket')));
  assert.ok(checkMicroTool('<!doctype html><style>@import url(//fonts.example.com/a.css)</style><script>1</script>').some((i) => i.includes('@import')));
  assert.ok(checkMicroTool('just text').some((i) => i.includes('not a complete HTML')));
});

const baseIdea = (over: Partial<Idea> = {}): Idea => ({
  title: 'Packliste für Mehrtageswanderungen',
  slug: 'packliste-wandern',
  category: 'micro-tool',
  productType: 'tool',
  audience: 'Wanderer',
  problem: 'Vergessene Ausrüstung',
  deliverableOutline: ['Generator'],
  price: 5,
  language: 'de',
  keywords: ['packliste wandern'],
  whyPay: 'spart Zeit',
  autonomy: {
    steps: [
      { step: 'write', actor: 'self', why: '' },
      { step: 'host', actor: 'self', why: '' },
      { step: 'support', actor: 'human', why: 'calls' },
      { step: 'payment link', actor: 'self', why: '' },
    ],
    autonomyScore: 1, // model over-claims; we recompute
  },
  ...over,
});

test('autonomy score is recomputed from steps; human steps are listed', () => {
  const a = computeAutonomy(baseIdea());
  assert.equal(a.score, 0.75);
  assert.deepEqual(a.humanSteps, ['support']);
  assert.equal(computeAutonomy(baseIdea({ autonomy: { steps: [], autonomyScore: 1 } })).score, 0);
});

test('combined score blends critic and autonomy with the configured weight', () => {
  assert.equal(combineScore(50, 1, 0.4), 70);
  assert.equal(combineScore(50, 0, 0.4), 30);
  assert.equal(combineScore(80, 0.5, 0), 80);
  assert.equal(combineScore(150, 2, 0.4), 100); // clamped
});

test('hard filter: trademarks/celebrities in names and forbidden topics', () => {
  assert.deepEqual(ideaHardFilter(baseIdea()), []);
  assert.ok(ideaHardFilter(baseIdea({ title: 'Notion Vorlagen für Lehrer' })).some((r) => r.includes('notion')));
  assert.ok(ideaHardFilter(baseIdea({ slug: 'taylor-swift-quiz' })).some((r) => r.includes('taylor swift')));
  assert.ok(ideaHardFilter(baseIdea({ problem: 'Mehr Gewinne bei Sportwetten' })).some((r) => r.includes('adult-gambling')));
  assert.ok(ideaHardFilter(baseIdea({ title: 'Passives Einkommen mit KI' })).some((r) => r.includes('get-rich-quick')));
  assert.ok(ideaHardFilter(baseIdea({ problem: 'Diagnose von Hautkrankheiten per Foto' })).some((r) => r.includes('medical')));
  assert.ok(ideaHardFilter(baseIdea({ whyPay: 'Wir nutzen Kaltakquise' })).some((r) => r.includes('outreach')));
});
