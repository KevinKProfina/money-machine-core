/**
 * Offline fake of the Claude client used by tests and `npm run simulate`.
 * Answers are deterministic for a given seed. It is NOT a model: content is filler
 * generated from templates and must never be published for real.
 */
import type { LlmClient, LlmRequest, LlmResponse, LlmTask } from '../llm.js';
import { slugify } from '../studio.js';
import { hash01, Rng } from './rng.js';

const TOPICS = [
  ['Checklisten-Paket für Vereinskassierer', 'digital-product', 'de'],
  ['Packing list generator for multi-day hikes', 'micro-tool', 'en'],
  ['Vorlagen für Übergabeprotokolle in WGs', 'digital-product', 'de'],
  ['Sourdough feeding schedule planner', 'micro-tool', 'en'],
  ['Workbook: first 90 days as a team lead', 'digital-product', 'en'],
  ['Schichtplan-Generator für kleine Cafés', 'micro-tool', 'de'],
  ['Garden planting calendar for balconies', 'micro-tool', 'en'],
  ['Prompt-free writing exercises for fiction', 'digital-product', 'en'],
  ['Vorlagen für Elternbriefe in Kitas', 'digital-product', 'de'],
  ['Board game night scoring sheets', 'digital-product', 'en'],
  ['Local bike repair directory', 'content-site', 'de'],
  ['Wedding speech ghostwriting', 'service-listing', 'en'],
  ['Regional recipe blog with affiliate links', 'content-site', 'en'],
  ['Bewerbungsfoto-Service', 'service-listing', 'de'],
  ['Sportwetten-Rechner', 'micro-tool', 'de'],
] as const;

export type FakeLlmOptions = {
  seed?: string | number;
  /** Share of products whose first draft violates policy (fixed by revision unless stubborn). */
  badDraftRate?: number;
  /** Share of bad drafts that stay bad after revision → blocked. */
  stubbornRate?: number;
  refuseTasks?: LlmTask[];
  failTasks?: LlmTask[];
  /** Fixed critic score (otherwise seeded random). */
  criticScore?: number;
};

export class FakeLlm implements LlmClient {
  readonly calls: LlmRequest[] = [];
  private rng: Rng;
  private n = 0;
  constructor(private readonly opts: FakeLlmOptions = {}) {
    this.rng = new Rng(opts.seed ?? 1);
  }

  count(task: LlmTask): number {
    return this.calls.filter((c) => c.task === task).length;
  }

  async create(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    if (this.opts.failTasks?.includes(req.task)) throw new Error('fake network error');
    if (this.opts.refuseTasks?.includes(req.task)) return { stop_reason: 'refusal', text: '', usage: { input_tokens: 100, output_tokens: 5 } };
    const text = this.answer(req);
    return { stop_reason: 'end_turn', text, usage: { input_tokens: Math.ceil((req.system.length + req.prompt.length) / 4), output_tokens: Math.ceil(text.length / 4) } };
  }

  private slugOf(prompt: string): string {
    return /"slug":\s*"([^"]+)"/.exec(prompt)?.[1] ?? 'x';
  }

  private isBad(slug: string): boolean {
    return hash01(`bad:${slug}`) < (this.opts.badDraftRate ?? 0.3);
  }

  private isStubborn(slug: string): boolean {
    return hash01(`stubborn:${slug}`) < (this.opts.stubbornRate ?? 0.4);
  }

  private idea(i: number, kind?: string) {
    const [title, category, language] = TOPICS[(this.n + i) % TOPICS.length]!;
    const k = ++this.n;
    const buildable = category === 'digital-product' || category === 'micro-tool';
    const steps = [
      { step: 'Write the product', actor: 'self', why: 'text generation' },
      { step: 'Host static page', actor: 'self', why: 'static files' },
      { step: 'Create payment link', actor: 'self', why: 'Stripe API' },
      ...(buildable ? [] : [{ step: 'Talk to customers / partners', actor: 'human', why: 'needs a person' }, { step: 'Open partner accounts', actor: 'human', why: 'KYC' }]),
    ];
    return {
      title: `${title}${k > TOPICS.length ? ` ${Math.ceil(k / TOPICS.length)}` : ''}`,
      slug: slugify(`${title}-${k}`),
      category,
      productType: category,
      audience: 'a specific niche audience',
      problem: `People need help with ${title.toLowerCase()}.`,
      deliverableOutline: ['Part 1', 'Part 2', 'Part 3'],
      price: this.rng.int(5, 29),
      language,
      keywords: [title.toLowerCase()],
      whyPay: 'Saves time.',
      autonomy: { steps, autonomyScore: 0.99 },
      ...(kind ? { kind } : {}),
    };
  }

  private answer(req: LlmRequest): string {
    switch (req.task) {
      case 'ideas': {
        const n = Number(/Propose (\d+)/.exec(req.prompt)?.[1] ?? 1);
        return JSON.stringify({ ideas: Array.from({ length: n }, (_, i) => this.idea(i)) });
      }
      case 'followups':
        return JSON.stringify({ ideas: [this.idea(0, 'variant'), this.idea(1, 'bundle')] });
      case 'critic':
        return JSON.stringify({ score: this.opts.criticScore ?? this.rng.int(35, 90), demandSignals: 'fake', competition: 'fake', buildability: 'fake', legalRisk: 'low', reasons: ['fake critic'] });
      case 'product':
      case 'revise': {
        const slug = req.task === 'product' ? this.slugOf(req.prompt) : (/<title>([^<]+)<\/title>/.exec(req.prompt)?.[1] ?? /^# (\S+)/m.exec(req.prompt)?.[1] ?? 'x');
        const isTool = req.task === 'product' ? /"category": "micro-tool"/.test(req.prompt) : /corrected HTML file/.test(req.prompt);
        const bad = req.task === 'product' ? this.isBad(slug) : this.isBad(slug) && this.isStubborn(slug);
        const claim = bad ? '\n\nMit dieser Methode verdienst du garantiert 1000 € im Monat.\n' : '';
        if (isTool) {
          return `<!doctype html><html><head><meta charset="utf-8"><title>${slug}</title></head><body><h1>${slug}</h1><p>Fake simulated tool.${claim}</p><input id="a" type="number"><output id="o"></output><script>document.getElementById('a').addEventListener('input',function(e){document.getElementById('o').textContent=String(Number(e.target.value)*2);});${'/* padding */'.repeat(100)}</script></body></html>`;
        }
        const section = (i: number) => `## Section ${i}\n\nThis is simulated filler text for section ${i} of ${slug}. It stands in for real content that Claude would write.\n\n- Point A\n- Point B\n- Point C\n`;
        return `# ${slug}\n\n## How to use\n\nSimulated product.${claim}\n\n${Array.from({ length: 30 }, (_, i) => section(i + 1)).join('\n')}`;
      }
      case 'landing':
        return JSON.stringify({ headline: 'Simulated product', subheadline: 'Simulated subheadline', benefits: ['A', 'B', 'C'], outline: ['1', '2', '3'], faq: [{ q: 'How do I get it?', a: 'Download page after checkout.' }], metaDescription: 'Simulated product description.' });
      case 'review': {
        const bad = /garantiert 1000/.test(req.prompt);
        return JSON.stringify({ pass: !bad, issues: bad ? [{ rule: 'income-guarantee', excerpt: 'garantiert 1000 € im Monat', fix: 'remove the claim' }] : [] });
      }
      default:
        return '';
    }
  }
}
