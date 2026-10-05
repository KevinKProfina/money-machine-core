import type { Idea, PolicyFinding } from './types.js';

type Rule = { rule: string; re: RegExp };

/** Content rules applied to product + landing text (German and English). */
export const CONTENT_RULES: Rule[] = [
  // income guarantees / get-rich-quick
  { rule: 'income-guarantee', re: /garantiert[^.\n]{0,40}(\d[\d.,]*\s*(€|euro|eur|\$|usd|dollar)|(€|\$|usd|eur)\s*\d)/i },
  { rule: 'income-guarantee', re: /\b(verdien\w*|earn\w*|make|machen|einnahmen|einkommen|income|profit\w*|gewinn\w*|umsatz)\b[^.\n]{0,40}(\d[\d.,]*\s*(€|euro|eur|\$|usd|dollar)|(€|\$|usd|eur)\s*\d[\d.,]*)\s*(im|pro|per|a|each|every|jeden|jede|\/)\s*(monat|month|woche|week|tag|day|jahr|year)/i },
  { rule: 'income-guarantee', re: /\b(guaranteed|garantierte[snm]?)\s+(income|returns?|results?|profits?|earnings|einnahmen|einkommen|gewinne?|rendite|erfolg|umsatz)/i },
  { rule: 'get-rich-quick', re: /\b(get rich quick|schnell reich|reich werden|passive income guaranteed|passives einkommen garantiert|financial freedom in|finanzielle freiheit in)\b/i },
  // fake social proof
  { rule: 'fake-testimonial', re: /\b(testimonials?|kundenstimmen|erfahrungsberichte|what (our )?(customers|users|clients) say|was (unsere )?kunden sagen)\b/i },
  { rule: 'fake-testimonial', re: /["„“][^"„“”\n]{10,300}["”“]\s*[—–-]\s*[A-ZÄÖÜ][a-zäöüß]+(\s+[A-ZÄÖÜ][a-zäöüß]*\.?)?\s*(,|\(|$)/m },
  { rule: 'fake-rating', re: /(★|⭐){3,}|\b[45]([.,]\d)?\s*(\/\s*5|von 5|out of 5)\s*(sterne|stars)?/i },
  { rule: 'fake-user-count', re: /(?<!\p{L})(über|mehr als|bereits|over|more than|already|join)\s+[\d.,]+\+?\s*(zufriedene[n]?\s+|happy\s+|satisfied\s+)?(kunden|customers|users|nutzer|käufer|buyers|downloads|teilnehmer|members)/iu },
  { rule: 'fake-user-count', re: /\b(used|trusted|loved|chosen)\s+by\s+[\d.,]+/i },
  // fake scarcity / urgency
  { rule: 'fake-scarcity', re: /\b(nur noch \d+|only \d+ (left|remaining|copies)|angebot endet|offer ends|limited time only|nur für kurze zeit|letzte chance|last chance|countdown|solange der vorrat)/i },
  // regulated advice
  { rule: 'medical-advice', re: /\b(heilt|heilen|heilung von|cures?|treats? (your )?(depression|anxiety|diabetes|cancer|disease|illness)|dosierung|dosage|abnehmen garantiert|lose \d+ ?(kg|lbs|pounds) in)\b/i },
  { rule: 'financial-advice', re: /\b(kaufen sie (diese|jetzt) (aktie|aktien|krypto|coins?)|buy (this|these) (stocks?|coins?|crypto)|anlageempfehlung|investment recommendation|sichere rendite|risk-free returns?|risikolose rendite)\b/i },
  { rule: 'legal-advice', re: /\b(verbindliche rechtsberatung|ersetzt (den|einen) anwalt|replaces (a|your) lawyer|this is legal advice)\b/i },
  // restricted categories
  { rule: 'restricted-category', re: /\b(casino|gambling|glücksspiel|sportwetten|wett-?tipps|betting tips|porn\w*|erotik|escort|waffen|weapons?|firearms?|munition|ammunition|cannabis|drogen|drugs|kratom|psilocybin)\b/i },
  { rule: 'political-targeting', re: /\b(wahlkampf|wählerstimmen|voter targeting|election campaign|political campaign|parteiwerbung)\b/i },
  // undeliverable claims
  { rule: 'undeliverable-claim', re: /\b(lebenslange[rn]? (support|updates|betreuung)|lifetime (support|updates|coaching)|persönliche[rn]? (betreuung|beratung|coaching)|1:1[- ]?(coaching|call|session)|money-back guarantee|geld-zurück-garantie|zufriedenheitsgarantie)\b/i },
];

/** Trademarks / celebrity names that must not appear in product names or slugs. */
export const TRADEMARK_TERMS = [
  'apple', 'iphone', 'google', 'amazon', 'kindle', 'microsoft', 'excel', 'powerpoint', 'disney', 'netflix', 'nike', 'adidas', 'tesla',
  'chatgpt', 'openai', 'claude', 'anthropic', 'instagram', 'tiktok', 'facebook', 'youtube', 'whatsapp', 'notion', 'canva', 'etsy',
  'shopify', 'lego', 'pokemon', 'pokémon', 'marvel', 'harry potter', 'barbie', 'ikea', 'spotify', 'linkedin', 'paypal', 'stripe',
  'elon musk', 'taylor swift', 'oprah', 'beyonce', 'ronaldo', 'messi', 'trump', 'merkel', 'scholz',
];

const FORBIDDEN_IDEA_TOPICS: Rule[] = [
  { rule: 'medical', re: /\b(medizin\w*|medical|diagnos\w*|therap\w*|heilmittel\w*|heilpraktik\w*|heilung|symptom\w*|krankheiten|diseases?|supplement\w*|nahrungsergänzung\w*|abnehm\w*|weight loss|diät\w*|diet pills?)\b/i },
  { rule: 'legal-advice', re: /\b(rechtsberatung|legal advice|anwalt\w*|lawyer|vertragsprüfung|contract review|steuerberatung|tax advice)\b/i },
  { rule: 'financial-advice', re: /\b(trading[- ]?signal\w*|aktientipps?|stock picks?|crypto signals?|krypto[- ]?signal\w*|anlageberatung|investment advice|forex|day ?trading|finanzberatung|financial advice)\b/i },
  { rule: 'get-rich-quick', re: /\b(get rich|reich werden|passive[sn]? einkommen|passive income|make money online|geld verdienen online|side hustle millions?|schnell geld)\b/i },
  { rule: 'adult-gambling-weapons-drugs', re: /\b(casino|gambling|glücksspiel|sportwetten|wetten|betting|porn\w*|erotik|sex\w*|adult content|escort|waffe\w*|weapons?|firearms?|guns?|munition|cannabis|drogen|drugs?|kratom|vape)\b/i },
  { rule: 'political', re: /\b(wahlkampf\w*|bundestagswahl|landtagswahl|election\w*|partei\w*|political|politisch\w*|propaganda|voter\w*)\b/i },
  { rule: 'outreach-required', re: /\b(cold ?e-?mail\w*|kaltakquise|spam|scraping|scrape|lead ?lists?|massenmail\w*|dm outreach)\b/i },
  { rule: 'third-party-content', re: /\b(resell\w*|weiterverkauf|plr|private label rights|nachdruck|reprint|summar(y|ies) of (the )?book|buchzusammenfassung\w*)\b/i },
];

export function scanContent(text: string, where: string): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  for (const { rule, re } of CONTENT_RULES) {
    const m = re.exec(text);
    if (m) findings.push({ rule, source: 'regex', where, excerpt: excerptAround(text, m.index, m[0].length) });
  }
  return findings;
}

function excerptAround(text: string, index: number, len: number): string {
  const s = Math.max(0, index - 30);
  return text.slice(s, Math.min(text.length, index + len + 30)).replace(/\s+/g, ' ').trim();
}

/** Deterministic hard filters applied to an idea before any scoring. */
export function ideaHardFilter(idea: Idea): string[] {
  const reasons: string[] = [];
  const nameText = `${idea.title} ${idea.slug}`.toLowerCase();
  for (const term of TRADEMARK_TERMS) {
    const re = new RegExp(`(^|[^a-z0-9äöüß])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9äöüß]|$)`, 'i');
    if (re.test(nameText) || re.test(idea.slug.replace(/-/g, ' '))) reasons.push(`trademark/celebrity in name: "${term}"`);
  }
  const fullText = [idea.title, idea.productType, idea.audience, idea.problem, idea.whyPay, ...idea.deliverableOutline, ...idea.keywords].join(' \n ');
  for (const { rule, re } of FORBIDDEN_IDEA_TOPICS) {
    const m = re.exec(fullText);
    if (m) reasons.push(`forbidden topic (${rule}): "${m[0]}"`);
  }
  for (const f of scanContent(fullText, 'idea')) reasons.push(`content rule ${f.rule}: "${f.excerpt}"`);
  if (!(idea.price > 0)) reasons.push('price must be positive');
  return [...new Set(reasons)];
}

/** A micro-tool must be one self-contained HTML file that never talks to the network. */
export function checkMicroTool(html: string): string[] {
  const issues: string[] = [];
  if (!/^\s*(<!doctype html|<html)/i.test(html)) issues.push('not a complete HTML document');
  if (!/<script[\s>]/i.test(html)) issues.push('no inline script: a micro-tool needs inline JS');
  const checks: Array<[string, RegExp]> = [
    ['external script/style/image/frame', /\b(src|href|action|poster|data)\s*=\s*["']?\s*(https?:)?\/\//i],
    ['CSS @import / remote url()', /@import|url\(\s*["']?\s*(https?:)?\/\//i],
    ['fetch()', /\bfetch\s*\(/],
    ['XMLHttpRequest', /XMLHttpRequest/],
    ['WebSocket', /\bWebSocket\b/],
    ['EventSource', /\bEventSource\b/],
    ['sendBeacon', /sendBeacon/],
    ['dynamic import()', /\bimport\s*\(/],
    ['iframe', /<iframe/i],
    ['form submission to a server', /<form[^>]*\baction\s*=/i],
  ];
  for (const [label, re] of checks) if (re.test(html)) issues.push(`network access not allowed: ${label}`);
  return issues;
}

/** autonomyScore = share of steps marked `self`. The model's own number is not trusted. */
export function computeAutonomy(idea: Idea): { score: number; humanSteps: string[] } {
  const steps = idea.autonomy.steps;
  const humanSteps = steps.filter((s) => s.actor === 'human').map((s) => s.step);
  if (steps.length === 0) return { score: 0, humanSteps: ['no autonomy assessment given'] };
  return { score: Math.round(((steps.length - humanSteps.length) / steps.length) * 1000) / 1000, humanSteps };
}

/** Final score: critic (0–100) blended with autonomy (0–1 → 0–100). */
export function combineScore(critic: number, autonomy: number, weight: number): number {
  const c = Math.max(0, Math.min(100, critic));
  const a = Math.max(0, Math.min(1, autonomy)) * 100;
  return Math.round(((1 - weight) * c + weight * a) * 10) / 10;
}

export const POLICY_RULES_TEXT = [
  'No medical, legal or individual financial/investment advice.',
  'No get-rich-quick content, no income or result guarantees, no concrete earnings promises.',
  'No testimonials, reviews, ratings, user/customer counts or social proof of any kind (the product is new, any such claim would be fake).',
  'No fake scarcity or urgency (countdowns, "only N left", "offer ends").',
  'No trademarks, brand names or celebrity names in product names; do not imply endorsement.',
  'No copied or paraphrased third-party content; everything must be original.',
  'No adult, gambling, weapons, drugs or political targeting content.',
  'No claims the product cannot deliver (no personal coaching, calls, lifetime support, money-back guarantees).',
  'The product is AI-assisted; never claim it was written by a human expert.',
].join('\n- ');
