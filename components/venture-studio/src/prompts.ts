import { POLICY_RULES_TEXT } from './policy.js';
import type { Idea, LandingCopy, Venture } from './types.js';

export const SYSTEM = `You are the product engine of a small, fully automated digital-product studio run by one owner in Germany.
The studio can autonomously: write text, generate original content, render HTML, host static files, and create a Stripe payment link via API.
It can NOT: run ads, send e-mails or messages, post on social media, scrape websites, talk to customers, ship physical goods, sign contracts or open accounts.
Traffic comes only from organic search (SEO). Every launch is approved by the owner first.
Content rules (always):
- ${POLICY_RULES_TEXT}`;

export type HistoryItem = { title: string; category: string; state: string; reason?: string; sales?: number };

export function ideasPrompt(n: number, history: HistoryItem[], existingSlugs: string[]): string {
  const hist = history.length ? history.map((h) => `- [${h.state}] ${h.title} (${h.category})${h.sales !== undefined ? `, sales ${h.sales}` : ''}${h.reason ? ` — ${h.reason}` : ''}`).join('\n') : '- (no history yet)';
  return `Propose ${n} NEW income ideas for the studio.

Prefer ideas the studio can execute end-to-end by itself:
- "digital-product": a downloadable text product (guide, template pack, checklist collection, workbook) delivered as one page/Markdown.
- "micro-tool": ONE self-contained static HTML page with inline JS (calculator, generator, converter, planner) that works offline and never calls the network.
Other categories ("content-site", "service-listing") are allowed but will only be recorded as opportunities for a human.

For each idea give an honest autonomy assessment: list EVERY step needed to make money (create, host, sell, deliver, support, bookkeeping beyond automatic Stripe records, ...),
mark each step "self" (the studio can do it fully) or "human" (needs accounts, KYC, physical goods, calls, negotiation, customer support beyond an FAQ, paid ads approval, ...),
and set autonomyScore = share of "self" steps.

Constraints: price is a one-time price in EUR between 3 and 49; language "de" or "en"; slug is lowercase a-z, 0-9 and hyphens, max 50 chars, no brand names;
keywords are realistic search phrases; niche, specific audiences beat broad ones; avoid anything on the content-rule list.

Venture history (learn from it: repeat what sold, avoid what was killed, blocked or rejected and why):
${hist}

Slugs already used (do not reuse): ${existingSlugs.join(', ') || '(none)'}

Answer as JSON: {"ideas":[{ "title", "slug", "category", "productType", "audience", "problem", "deliverableOutline":[...], "price", "language", "keywords":[...], "whyPay", "autonomy":{"steps":[{"step","actor","why"}],"autonomyScore"} }]}`;
}

export function criticPrompt(idea: Idea): string {
  return `Act as a skeptical critic. Score this product idea 0-100 for the chance that it sells at least a few copies within 3 weeks through organic search only, built entirely by AI.
Consider: demand signals (are people searching and paying for this?), competition (free alternatives?), buildability by AI alone with high quality, legal/content-policy risk (any risk → low score).
Be harsh: most ideas deserve < 60.

Idea:
${JSON.stringify(idea, null, 2)}

Answer as JSON: {"score": number, "demandSignals": string, "competition": string, "buildability": string, "legalRisk": string, "reasons": [string]}`;
}

export function productPrompt(v: Venture, minChars: number): string {
  const idea = v.idea;
  if (idea.category === 'micro-tool') {
    return `Build the complete product for this micro-tool:
${JSON.stringify(idea, null, 2)}

Requirements:
- Return ONE complete, self-contained HTML file (starting with <!doctype html>) with inline CSS and inline JS. Language: ${idea.language}.
- No external resources at all: no CDN, no fonts, no images from URLs, no fetch/XMLHttpRequest/WebSocket/beacons, no forms posting anywhere, no analytics.
- It must actually work and be genuinely useful: input validation, clear labels, results explained, responsive, dark-mode friendly. localStorage is allowed.
- Include a short usage explanation and, where numbers could be mistaken for advice, a one-line note that it is a calculation aid, not professional advice.
- Follow the content rules. No testimonials, user counts or ratings.
Return only the HTML, no commentary, no code fences.`;
  }
  return `Write the complete product for this digital product:
${JSON.stringify(idea, null, 2)}

Requirements:
- Markdown, language: ${idea.language}. Real, substantial, original content – at least ${minChars} characters, typically much more. No placeholders like "content goes here", no stubs.
- If it is a pack/collection, include ALL items in full.
- Start with a title (#), a short "how to use" section and a table of contents.
- Practical, specific, honest. Follow the content rules strictly. No testimonials, no earnings claims.
Return only the Markdown, no commentary, no code fences around the whole document.`;
}

export function landingPrompt(v: Venture, productExcerpt: string): string {
  return `Write landing-page copy for this product (language: ${v.idea.language}). Honest, specific, SEO-friendly for these keywords: ${v.idea.keywords.join(', ')}.
No testimonials, ratings, user counts, urgency, guarantees or earnings claims. Do not mention price, AI notice or legal notices (added automatically).

Product idea:
${JSON.stringify(v.idea, null, 2)}

Product excerpt:
${productExcerpt.slice(0, 3000)}

Answer as JSON: {"headline": string (max 70 chars), "subheadline": string, "benefits": [4-6 strings], "outline": [what is inside, 3-15 strings], "faq": [{"q","a"} 3-6 items, must include how delivery works], "metaDescription": string (max 155 chars)}`;
}

export function reviewPrompt(v: Venture, product: string, copy: LandingCopy): string {
  return `You are a strict content-policy reviewer for a German online shop. Review the product and its landing copy against these rules:
- ${POLICY_RULES_TEXT}
Also flag: content that looks copied from a known source, claims the product cannot deliver, anything that needs a licence to sell in Germany.
Product title: ${v.title} (category ${v.idea.category})

Landing copy:
${JSON.stringify(copy, null, 2)}

Product (may be truncated):
${product.slice(0, 40_000)}

Answer as JSON: {"pass": boolean, "issues": [{"rule": string, "excerpt": string, "fix": string}]}. pass=false if ANY rule is violated.`;
}

export function revisePrompt(v: Venture, product: string, issues: Array<{ rule: string; excerpt: string; fix?: string }>): string {
  const what = v.idea.category === 'micro-tool' ? 'the complete corrected HTML file' : 'the complete corrected Markdown';
  return `The following product failed the content-policy review. Fix ALL issues while keeping the product complete and useful.

Issues:
${issues.map((i) => `- ${i.rule}: "${i.excerpt}"${i.fix ? ` → ${i.fix}` : ''}`).join('\n')}

Product:
${product}

Return only ${what}, no commentary, no code fences.`;
}

export function followUpPrompt(parent: Venture, history: HistoryItem[], n: number): string {
  return `This product sold well: ${parent.title} (${parent.idea.category}, ${parent.idea.price} EUR, ${parent.sales?.count ?? 0} sales).
Propose ${n} follow-up ideas: a variant for a neighbouring audience, a bundle/extension, or a price test – each must be a NEW product that the studio can build alone.
Recent history:
${history.map((h) => `- [${h.state}] ${h.title}`).join('\n') || '- none'}

Parent idea:
${JSON.stringify(parent.idea, null, 2)}

Use the same JSON format as idea proposals: {"ideas":[...]} with full autonomy assessment and new unique slugs.`;
}
