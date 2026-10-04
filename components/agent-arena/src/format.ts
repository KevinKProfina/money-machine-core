import type { ArenaSummary, LeaderboardRow } from './report.js';
import { RANK_BY } from './species/trader.js';

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function genomeBrief(g: Record<string, number>): string {
  const f = (k: string, d = 0) => (g[k] === undefined ? '?' : g[k]!.toFixed(d));
  return [
    `liq>=${Math.round((g.minLiquidityUsd ?? 0) / 1000)}k`,
    `vol>=${Math.round((g.minVolume24hUsd ?? 0) / 1000)}k`,
    `age ${f('minAgeHours')}-${f('maxAgeHours')}h`,
    `bs>=${f('minBuySellRatio', 2)}`,
    `h1 ${f('minChangeH1')}..${f('maxChangeH1')}%`,
    `size ${pct(g.positionPct ?? 0)}`,
    `tp ${f('takeProfitPct')}% sl ${f('stopLossPct')}% tr ${f('trailingStopPct')}%`,
    `hold<=${f('maxHoldCycles')}`,
    `rank=${RANK_BY[g.rankBy ?? 0] ?? '?'}`,
  ].join(' ');
}

export function leaderboardTable(rows: LeaderboardRow[]): string {
  const header = `${pad('#', 3)}${pad('id', 9)}${lpad('gen', 4)} ${pad('origin', 9)}${lpad('balance', 10)}${lpad('return', 10)}${lpad('age', 6)}${lpad('trades', 7)}${lpad('win', 7)}${lpad('kids', 5)}  genome`;
  const lines = rows.map(
    (r, i) =>
      `${pad(String(i + 1), 3)}${pad(r.id, 9)}${lpad(String(r.generation), 4)} ${pad(r.origin, 9)}${lpad(`$${r.balanceUsd.toFixed(2)}`, 10)}${lpad(pct(r.return), 10)}` +
      `${lpad(String(r.ageCycles), 6)}${lpad(String(r.trades), 7)}${lpad(pct(r.winRate), 7)}${lpad(String(r.children), 5)}  ${genomeBrief(r.genome)}`,
  );
  return [header, ...lines].join('\n');
}

export function summaryText(s: ArenaSummary): string {
  const m = s.metrics;
  return [
    `cycle ${s.cycle} | market ${s.marketSource}${s.marketOk ? '' : ' (last fetch FAILED)'} | mode ${s.mode}`,
    `population ${s.population} | births ${s.births.total} (${Object.entries(s.births.byOrigin).map(([k, v]) => `${k} ${v}`).join(', ')}) | deaths ${s.deaths.total} | max generation ${s.maxGeneration}`,
    `causes of death: ${Object.entries(s.causesOfDeath).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'} | avg lifespan ${s.graveyard.avgLifespanCycles} cycles`,
    `equity $${s.equityUsd.toFixed(2)} | treasury $${s.treasuryUsd.toFixed(2)} | pnl $${s.pnlUsd.toFixed(2)} (${pct(m.totalReturn)}) | realized $${m.realizedPnlUsd.toFixed(2)} unrealized $${m.unrealizedPnlUsd.toFixed(2)}`,
    `closed trades ${m.totalTrades} | win rate ${pct(m.winRate)} | avg trade ${pct(m.avgProfit)} | sharpe/trade ${m.sharpeRatio.toFixed(3)} | max drawdown ${pct(m.maxDrawdown)} | open positions ${m.openPositions}`,
    `LLM: ${s.llm.enabled ? `calls ${s.llm.calls}, spend $${s.llm.totalUsd.toFixed(4)}, designed ${s.llm.designedSpawned}` : 'disabled'}`,
    ...s.notes.filter((n) => n === 'synthetic-market-data').map((n) => `note: ${n}`),
  ].join('\n');
}
