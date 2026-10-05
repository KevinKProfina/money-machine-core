export const COMPONENT_NAME = 'venture-studio';

export type Operator = { name: string; address: string; email: string };

export type StudioConfig = {
  intervalMs: number;
  maxActive: number;
  ideasPerDay: number;
  autonomyWeight: number;
  minScore: number;
  /** Hard floor for the critic score alone (autonomy cannot lift a weak idea over the bar). */
  minCritic: number;
  evalDays: number;
  winnerSales: number;
  maxFollowUps: number;
  minProductChars: number;
  minToolChars: number;
  currency: string;
  priceNote: string;
  siteUrl?: string;
  operator?: Operator;
  /** Names of missing operator fields (empty when complete). */
  operatorMissing: string[];
  deployCmd?: string;
  deployTimeoutMs: number;
  stripe: {
    /** Key that may actually be used (undefined when absent or refused). */
    apiKey?: string;
    testMode: boolean;
    /** Why a configured key is not used. */
    refusedReason?: string;
  };
  llm: {
    apiKey?: string;
    dailyBudgetUsd: number;
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
  };
  notes: string[];
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number, min: number, max: number, integer = false): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new ConfigError(`${key}=${raw} is not a number`);
  if (v < min || v > max) throw new ConfigError(`${key}=${raw} out of range [${min}, ${max}]`);
  if (integer && !Number.isInteger(v)) throw new ConfigError(`${key}=${raw} must be an integer`);
  return v;
}

const str = (env: Env, key: string): string | undefined => env[key]?.trim() || undefined;

export const LIVE_CONFIRM = 'I_UNDERSTAND_REAL_MONEY_RISK';

export function isStripeTestKey(key: string): boolean {
  return /^(sk|rk)_test_/.test(key);
}

export function readConfig(env: Env = process.env): StudioConfig {
  const notes: string[] = [];
  const mode = (env.MODE ?? 'paper').trim().toLowerCase() || 'paper';
  if (!['paper', 'dry-run', 'live'].includes(mode)) throw new ConfigError(`MODE=${env.MODE} unknown (paper | dry-run | live)`);
  const liveConfirmed = mode === 'live' && env.LIVE_TRADING_CONFIRM === LIVE_CONFIRM;

  const siteUrlRaw = str(env, 'STUDIO_SITE_URL');
  let siteUrl: string | undefined;
  if (siteUrlRaw) {
    let u: URL;
    try {
      u = new URL(siteUrlRaw);
    } catch {
      throw new ConfigError(`STUDIO_SITE_URL=${siteUrlRaw} is not a valid URL`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ConfigError('STUDIO_SITE_URL must be http(s)');
    siteUrl = u.toString().replace(/\/+$/, '');
  }

  const opName = str(env, 'STUDIO_OPERATOR_NAME');
  const opAddress = str(env, 'STUDIO_OPERATOR_ADDRESS');
  const opEmail = str(env, 'STUDIO_OPERATOR_EMAIL');
  const operatorMissing: string[] = [];
  if (!opName) operatorMissing.push('STUDIO_OPERATOR_NAME');
  if (!opAddress) operatorMissing.push('STUDIO_OPERATOR_ADDRESS');
  if (!opEmail) operatorMissing.push('STUDIO_OPERATOR_EMAIL');
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opEmail)) throw new ConfigError(`STUDIO_OPERATOR_EMAIL=${opEmail} is not an e-mail address`);

  const currency = (str(env, 'STUDIO_CURRENCY') ?? 'eur').toLowerCase();
  if (!/^[a-z]{3}$/.test(currency)) throw new ConfigError(`STUDIO_CURRENCY=${env.STUDIO_CURRENCY} must be a 3-letter ISO code`);

  const stripeKey = str(env, 'STRIPE_API_KEY');
  const stripe: StudioConfig['stripe'] = { testMode: false };
  if (stripeKey) {
    if (isStripeTestKey(stripeKey)) {
      stripe.apiKey = stripeKey;
      stripe.testMode = true;
      notes.push('Stripe TEST key: payment links and sales are simulated (test mode)');
    } else if (liveConfirmed) {
      stripe.apiKey = stripeKey;
    } else {
      stripe.refusedReason = `live STRIPE_API_KEY ignored: real payments require MODE=live and LIVE_TRADING_CONFIRM=${LIVE_CONFIRM} (in addition to per-venture owner approval)`;
      notes.push(stripe.refusedReason);
    }
  }

  return {
    intervalMs: num(env, 'STUDIO_INTERVAL_MS', 3_600_000, 1_000, 7 * 86_400_000, true),
    maxActive: num(env, 'STUDIO_MAX_ACTIVE', 5, 0, 1000, true),
    ideasPerDay: num(env, 'STUDIO_IDEAS_PER_DAY', 3, 0, 100, true),
    autonomyWeight: num(env, 'STUDIO_AUTONOMY_WEIGHT', 0.4, 0, 1),
    minScore: num(env, 'STUDIO_MIN_SCORE', 60, 0, 100),
    minCritic: num(env, 'STUDIO_MIN_CRITIC', 45, 0, 100),
    evalDays: num(env, 'STUDIO_EVAL_DAYS', 21, 0.01, 3650),
    winnerSales: num(env, 'STUDIO_WINNER_SALES', 3, 1, 1e6, true),
    maxFollowUps: 2,
    minProductChars: num(env, 'STUDIO_MIN_PRODUCT_CHARS', 4000, 200, 1e7, true),
    minToolChars: 1200,
    currency,
    priceNote: str(env, 'STUDIO_PRICE_NOTE') ?? 'Endpreis / final price',
    siteUrl,
    operator: operatorMissing.length === 0 ? { name: opName!, address: opAddress!, email: opEmail! } : undefined,
    operatorMissing,
    deployCmd: str(env, 'STUDIO_DEPLOY_CMD'),
    deployTimeoutMs: num(env, 'STUDIO_DEPLOY_TIMEOUT_MS', 120_000, 100, 3_600_000, true),
    stripe,
    llm: {
      apiKey: str(env, 'ANTHROPIC_API_KEY'),
      dailyBudgetUsd: num(env, 'STUDIO_LLM_DAILY_BUDGET_USD', 3, 0, 1e6),
      inputUsdPerMTok: num(env, 'STUDIO_LLM_INPUT_USD_PER_MTOK', 4, 0, 1e4),
      outputUsdPerMTok: num(env, 'STUDIO_LLM_OUTPUT_USD_PER_MTOK', 20, 0, 1e4),
    },
    notes,
  };
}
