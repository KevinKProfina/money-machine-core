/**
 * Replay: walks recorded/synthetic price series through the real exit rules and paper executor.
 * Usage: npm run replay [-- path/to/series.json]
 * Entries are taken at the first point of each series (entry selection is NOT replayed — DexScreener
 * has no historical snapshot API); the output therefore measures exit-rule behaviour only.
 */
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readConfig, type ExitRules } from './config.js';
import { decideExit } from './exit.js';
import { PaperExecutor } from './executor.js';
import type { Token } from './market.js';
import { computeMetrics, type Metrics } from './metrics.js';
import { closePosition, markPrice, type EquityPoint, type Position } from './positions.js';

export type PricePoint = { ts: string; priceUsd: number };
/** liquidityUsd: pool liquidity used for paper price impact; unknown = treated as thin. */
export type PriceSeries = { mint: string; symbol: string; liquidityUsd?: number; points: PricePoint[] };
export type ReplayFile = { description?: string; series: PriceSeries[] };

export type ReplayResult = { positions: Position[]; equityCurve: EquityPoint[]; metrics: Metrics };

export async function replay(
  series: PriceSeries[],
  opts: { exits: ExitRules; sizeUsd: number; startingCapitalUsd: number; slippageBps: number; feeBps: number },
): Promise<ReplayResult> {
  const executor = new PaperExecutor(opts.slippageBps, opts.feeBps);
  const positions: Position[] = [];
  const equityCurve: EquityPoint[] = [];
  let realized = 0;

  for (const s of series) {
    const [first, ...rest] = s.points;
    if (!first || !(first.priceUsd > 0)) continue;
    const token = { mint: s.mint, symbol: s.symbol, priceUsd: first.priceUsd, liquidityUsd: s.liquidityUsd ?? 0 } as Token;
    const fill = await executor.buy(token, opts.sizeUsd);
    const position: Position = {
      id: `replay-${positions.length + 1}`,
      mint: s.mint,
      symbol: s.symbol,
      status: 'open',
      mode: 'paper',
      simulated: true,
      openedAt: first.ts,
      entryPriceUsd: fill.priceUsd,
      sizeUsd: fill.costUsd,
      quantity: fill.quantity,
      highestPriceUsd: first.priceUsd,
      lastPriceUsd: first.priceUsd,
      lastPriceAt: first.ts,
    };
    positions.push(position);

    for (const point of rest) {
      const at = new Date(point.ts);
      markPrice(position, point.priceUsd, at);
      const decision = decideExit(
        { entryPriceUsd: position.entryPriceUsd, highestPriceUsd: position.highestPriceUsd, currentPriceUsd: point.priceUsd, openedAt: position.openedAt, now: at },
        opts.exits,
      );
      if (decision.shouldExit && decision.reason) {
        const sell = await executor.sell(position, point.priceUsd, s.liquidityUsd);
        closePosition(position, { priceUsd: sell.priceUsd, proceedsUsd: sell.proceedsUsd }, decision.reason, at);
        break;
      }
    }
    if (position.status === 'open') {
      const sell = await executor.sell(position, position.lastPriceUsd, s.liquidityUsd);
      closePosition(position, { priceUsd: sell.priceUsd, proceedsUsd: sell.proceedsUsd }, 'end-of-data', new Date(position.lastPriceAt));
    }
    realized += position.realizedPnlUsd ?? 0;
    equityCurve.push({ ts: position.closedAt!, equityUsd: opts.startingCapitalUsd + realized });
  }

  return { positions, equityCurve, metrics: computeMetrics(positions, equityCurve, opts.startingCapitalUsd) };
}

async function main() {
  const file = process.argv[2] ?? 'fixtures/replay-series.json';
  const data = JSON.parse(await fs.readFile(file, 'utf8')) as ReplayFile;
  const cfg = readConfig();
  const sizeUsd = Math.min(cfg.sizing.maxUsdPerTrade, cfg.sizing.startingCapitalUsd * cfg.sizing.maxPositionPct);
  const result = await replay(data.series, {
    exits: cfg.exits,
    sizeUsd,
    startingCapitalUsd: cfg.sizing.startingCapitalUsd,
    slippageBps: cfg.paperSlippageBps,
    feeBps: cfg.paperFeeBps,
  });
  console.log(`[replay] ${file}${data.description ? ` — ${data.description}` : ''} (simulated fills, $${sizeUsd} per trade)`);
  for (const p of result.positions) {
    console.log(`  ${p.symbol.padEnd(8)} ${String(p.exitReason).padEnd(13)} pnl $${(p.realizedPnlUsd ?? 0).toFixed(2).padStart(8)} (${((p.returnPct ?? 0) * 100).toFixed(2)}%)`);
  }
  console.log(JSON.stringify(result.metrics, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`[replay] ${(error as Error).message}`);
    process.exit(1);
  });
}
