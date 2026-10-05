import type { StrategyRules } from './config.js';
import type { Token } from './market.js';

export type Evaluation = {
  allowed: boolean;
  score: number;
  /** Gate failures (when rejected) or score notes. */
  reasons: string[];
};

/** Hard risk gates. Any failure rejects the token regardless of score. */
export function riskGates(token: Token, rules: StrategyRules): string[] {
  const failures: string[] = [];
  const txns = token.buys24h + token.sells24h;
  if (!(token.priceUsd > 0)) failures.push('no price');
  if (token.liquidityUsd < rules.minLiquidityUsd) failures.push(`liquidity $${Math.round(token.liquidityUsd)} < $${rules.minLiquidityUsd}`);
  if (token.volume24hUsd < rules.minVolume24hUsd) failures.push(`24h volume $${Math.round(token.volume24hUsd)} < $${rules.minVolume24hUsd}`);
  if (token.marketCapUsd < rules.minMarketCapUsd) failures.push(`market cap $${Math.round(token.marketCapUsd)} < $${rules.minMarketCapUsd}`);
  if (token.marketCapUsd > rules.maxMarketCapUsd) failures.push(`market cap $${Math.round(token.marketCapUsd)} > $${rules.maxMarketCapUsd}`);
  if (!Number.isFinite(token.ageHours)) failures.push('unknown pair age');
  else if (token.ageHours < rules.minAgeHours) failures.push(`pair age ${token.ageHours.toFixed(1)}h < ${rules.minAgeHours}h`);
  else if (token.ageHours > rules.maxAgeHours) failures.push(`pair age ${token.ageHours.toFixed(1)}h > ${rules.maxAgeHours}h`);
  if (txns < rules.minTxns24h) failures.push(`24h txns ${txns} < ${rules.minTxns24h}`);
  const ratio = token.sells24h > 0 ? token.buys24h / token.sells24h : token.buys24h > 0 ? Infinity : 0;
  if (ratio < rules.minBuySellRatio) failures.push(`buy/sell ratio ${ratio.toFixed(2)} < ${rules.minBuySellRatio}`);
  if (token.marketCapUsd > 0 && token.liquidityUsd / token.marketCapUsd < rules.minLiquidityToMcap) {
    failures.push(`liquidity/mcap ${(token.liquidityUsd / token.marketCapUsd).toFixed(3)} < ${rules.minLiquidityToMcap}`);
  }
  // Momentum gates (off by default). Like the arena, a gate is skipped when DexScreener omits the field.
  const pc = token.priceChange ?? {};
  if (rules.minChangeM5 !== undefined && pc.m5 !== undefined && pc.m5 < rules.minChangeM5) failures.push(`5m change ${pc.m5}% < ${rules.minChangeM5}%`);
  if (rules.minChangeH1 !== undefined && pc.h1 !== undefined && pc.h1 < rules.minChangeH1) failures.push(`1h change ${pc.h1}% < ${rules.minChangeH1}%`);
  if (rules.maxChangeH1 !== undefined && pc.h1 !== undefined && pc.h1 > rules.maxChangeH1) failures.push(`1h change ${pc.h1}% > ${rules.maxChangeH1}%`);
  if (rules.minChangeH24 !== undefined && pc.h24 !== undefined && pc.h24 < rules.minChangeH24) failures.push(`24h change ${pc.h24}% < ${rules.minChangeH24}%`);
  return failures;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Log-scaled 0..1 between lo and hi. */
const logScale = (x: number, lo: number, hi: number) => (x <= lo ? 0 : clamp01(Math.log10(x / lo) / Math.log10(hi / lo)));

/** Deterministic 0..100 score. Higher = deeper, more active, more seasoned market with buy pressure. */
export function scoreToken(token: Token): number {
  const liquidity = logScale(token.liquidityUsd, 20_000, 2_000_000) * 25;
  const volume = logScale(token.volume24hUsd, 50_000, 10_000_000) * 25;
  const buyShare = token.buys24h + token.sells24h > 0 ? token.buys24h / (token.buys24h + token.sells24h) : 0;
  // 45 % buys → 0, 65 % buys → full marks
  const pressure = clamp01((buyShare - 0.45) / 0.2) * 20;
  const age = Number.isFinite(token.ageHours) ? logScale(token.ageHours, 6, 24 * 30) * 15 : 0;
  // turnover (volume/liquidity) between 0.5x and 5x is healthy; extremes score lower
  const turnover = token.liquidityUsd > 0 ? token.volume24hUsd / token.liquidityUsd : 0;
  const turnoverScore = turnover < 0.5 ? turnover / 0.5 : turnover <= 5 ? 1 : clamp01(1 - (turnover - 5) / 20);
  return Math.round(liquidity + volume + pressure + age + turnoverScore * 15);
}

export function evaluateToken(token: Token, rules: StrategyRules): Evaluation {
  const failures = riskGates(token, rules);
  const score = scoreToken(token);
  if (failures.length > 0) return { allowed: false, score, reasons: failures };
  if (score < rules.minScore) return { allowed: false, score, reasons: [`score ${score} < ${rules.minScore}`] };
  return { allowed: true, score, reasons: [`score ${score}`] };
}

/**
 * Ranking key for rankBy ≠ 'score' (same definitions as the agent-arena trader species):
 * h1-momentum = priceChange.h1 (else m5, else 0), turnover = volume/liquidity,
 * buy-pressure = buys/sells, youngest = −age.
 */
export function rankKey(token: Token, rankBy: StrategyRules['rankBy']): number {
  switch (rankBy) {
    case 'h1-momentum':
      return token.priceChange?.h1 ?? token.priceChange?.m5 ?? 0;
    case 'turnover':
      return token.liquidityUsd > 0 ? token.volume24hUsd / token.liquidityUsd : 0;
    case 'buy-pressure':
      return token.sells24h > 0 ? token.buys24h / token.sells24h : token.buys24h > 0 ? 10 : 0;
    case 'youngest':
      return Number.isFinite(token.ageHours) ? -token.ageHours : Number.NEGATIVE_INFINITY;
    default:
      return 0;
  }
}

/** Evaluate and rank candidates: by score (default) or by `rules.rankBy`, score as tie-break. */
export function rankCandidates(tokens: Token[], rules: StrategyRules): Array<{ token: Token; evaluation: Evaluation }> {
  const rankBy = rules.rankBy ?? 'score';
  return tokens
    .map((token) => ({ token, evaluation: evaluateToken(token, rules), key: rankKey(token, rankBy) }))
    .sort((a, b) => (rankBy === 'score' ? 0 : b.key - a.key) || b.evaluation.score - a.evaluation.score)
    .map(({ token, evaluation }) => ({ token, evaluation }));
}
