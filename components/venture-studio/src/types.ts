import { z } from 'zod';

export const CATEGORIES = ['digital-product', 'micro-tool', 'content-site', 'service-listing'] as const;
export type Category = (typeof CATEGORIES)[number];
/** Categories the studio can fully produce today. Everything else is parked. */
export const BUILDABLE: ReadonlySet<Category> = new Set<Category>(['digital-product', 'micro-tool']);

export const AutonomyStepSchema = z.object({
  step: z.string(),
  actor: z.enum(['self', 'human']),
  why: z.string(),
});

export const IdeaSchema = z.object({
  title: z.string(),
  slug: z.string(),
  category: z.enum(CATEGORIES),
  productType: z.string(),
  audience: z.string(),
  problem: z.string(),
  deliverableOutline: z.array(z.string()),
  price: z.number(),
  language: z.enum(['de', 'en']),
  keywords: z.array(z.string()),
  whyPay: z.string(),
  autonomy: z.object({
    steps: z.array(AutonomyStepSchema),
    autonomyScore: z.number(),
  }),
});
export type Idea = z.infer<typeof IdeaSchema>;
export const IdeasResponseSchema = z.object({ ideas: z.array(IdeaSchema) });

export const CriticSchema = z.object({
  score: z.number(),
  demandSignals: z.string(),
  competition: z.string(),
  buildability: z.string(),
  legalRisk: z.string(),
  reasons: z.array(z.string()),
});
export type Critic = z.infer<typeof CriticSchema>;

export const LandingCopySchema = z.object({
  headline: z.string(),
  subheadline: z.string(),
  benefits: z.array(z.string()),
  outline: z.array(z.string()),
  faq: z.array(z.object({ q: z.string(), a: z.string() })),
  metaDescription: z.string(),
});
export type LandingCopy = z.infer<typeof LandingCopySchema>;

export const ReviewSchema = z.object({
  pass: z.boolean(),
  issues: z.array(z.object({ rule: z.string(), excerpt: z.string(), fix: z.string() })),
});
export type Review = z.infer<typeof ReviewSchema>;

export type VentureState =
  | 'idea'
  | 'parked'
  | 'rejected'
  | 'queued'
  | 'review'
  | 'ready'
  | 'approved'
  | 'live'
  | 'winner'
  | 'killed'
  | 'blocked';

export type BlockKind = 'policy' | 'build' | 'operator' | 'site-url' | 'publish';

export type PolicyFinding = { rule: string; source: 'regex' | 'claude' | 'filter'; where: string; excerpt: string };
export type PolicyReport = {
  pass: boolean;
  checkedAt: string;
  claudeReviewed: boolean;
  findings: PolicyFinding[];
  notes: string[];
};

export type Venture = {
  id: string;
  slug: string;
  title: string;
  source: 'claude' | 'seed';
  idea: Idea;
  autonomyScore: number;
  humanSteps: string[];
  parentId?: string;
  generation: number;
  followUpKind?: 'variant' | 'bundle' | 'price-test';
  /** Seed catalog key (offline content). */
  seedKey?: string;
  state: VentureState;
  createdAt: string;
  updatedAt: string;
  history: Array<{ ts: string; from: VentureState | null; to: VentureState; note?: string }>;
  score?: { critic: number; autonomy: number; final: number; reasons: string[]; criticSource: 'claude' | 'seed' };
  build?: {
    dir: string;
    attempts: number;
    revisions: number;
    copy?: LandingCopy;
    productChars?: number;
  };
  policy?: PolicyReport;
  approval?: { requestedAt: string; decision?: 'approved' | 'rejected'; decidedAt?: string; decidedBy?: string; note?: string };
  publish?: {
    token: string;
    url: string;
    downloadUrl: string;
    publishedAt?: string;
    channel: 'stripe' | 'none';
    attempts: number;
    stripe?: { productId?: string; priceId?: string; paymentLinkId?: string; paymentLinkUrl?: string; testMode: boolean; deactivated?: boolean };
    /** When the venture became purchasable (eval window starts here). */
    salesSince?: string;
  };
  sales?: { count: number; revenueCents: number; currency: string; simulated: boolean; lastCheckedAt: string; error?: string };
  blocked?: { kind: BlockKind; reasons: string[] };
  rejectedReason?: string;
  rejectedBy?: 'scoring' | 'owner';
  killedReason?: string;
  followUpsSpawned?: boolean;
  scoreAttempts?: number;
  lastError?: string;
};

export const PIPELINE_STATES: ReadonlySet<VentureState> = new Set<VentureState>(['idea', 'queued', 'review', 'ready', 'approved', 'live']);

export const FollowUpIdeaSchema = IdeaSchema.extend({ kind: z.enum(['variant', 'bundle', 'price-test']) });
export const FollowUpsResponseSchema = z.object({ ideas: z.array(FollowUpIdeaSchema) });
