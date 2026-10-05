import { randomUUID } from 'node:crypto';
import {
  emitEvent,
  isKillSwitchActive,
  readStrategyBudget,
  statePaths,
  writeJsonAtomic,
  type StrategyReport,
} from './mm-contract.js';
import { STRATEGY_NAME, type AppConfig } from './config.js';
import { decideExit, type ExitReason } from './exit.js';
import type { Executor } from './executor.js';
import type { Gate } from './claude-gate.js';
import type { MarketSource, Token } from './market.js';
import { computeMetrics } from './metrics.js';
import {
  closePosition,
  closedPositions,
  deployedUsd,
  emptyState,
  loadState,
  markPrice,
  openPositions,
  saveState,
  type Position,
  type TraderState,
} from './positions.js';
import { computeTradeSize } from './sizing.js';
import { rankCandidates } from './strategy.js';
import { resolveStrategy, type ActiveStrategy } from './arena-strategy.js';

export type CycleDeps = {
  cfg: AppConfig;
  market: MarketSource;
  /** Required in paper/live mode; ignored in dry-run. */
  executor?: Executor;
  gate?: Gate;
  alert?: (message: string) => Promise<void>;
  /** Live-only pre-trade check (wallet balance). Entries are skipped when it is not ok. */
  preTradeCheck?: () => Promise<{ ok: boolean; message: string }>;
  now?: () => Date;
  /** Hours a mint is ignored after its position closed (avoid churn). */
  reentryCooldownHours?: number;
};

export type CycleResult = {
  report: StrategyReport;
  opened: Position[];
  closed: Position[];
  state: TraderState;
};

const usd = (x: number) => `$${x.toFixed(2)}`;

export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const { cfg, market } = deps;
  const now = deps.now ?? (() => new Date());
  const alert = deps.alert ?? (async () => {});
  const cooldownMs = (deps.reentryCooldownHours ?? 24) * 3_600_000;
  const notes: string[] = [...cfg.modeNotes];
  const opened: Position[] = [];
  const closed: Position[] = [];
  const dryRun = cfg.mode === 'dry-run';

  if (!dryRun && !deps.executor) throw new Error(`no executor configured for ${cfg.mode} mode`);
  if (cfg.mode === 'paper') notes.push('paper mode: all fills are simulated at DexScreener prices with configured slippage/fees; no real trades');
  if (dryRun) notes.push('dry-run mode: candidates are evaluated only; no positions are opened or tracked');
  if (cfg.mode === 'live') notes.push('live mode: real swaps via Jupiter (executor untested on mainnet)');

  const killed = isKillSwitchActive();
  const budget = await readStrategyBudget(STRATEGY_NAME);
  const budgetUsd = budget ? budget.budgetUsd : cfg.sizing.startingCapitalUsd;
  const paused = budget?.paused ?? false;
  if (!budget) notes.push(`no allocations.json yet; using STARTING_CAPITAL_USD ${usd(budgetUsd)} as budget`);

  const state = dryRun ? emptyState() : await loadState(cfg.mode);

  // Strategy parameters for NEW entries (static env, or the arena's promoted genome).
  // This never touches cfg.mode: promotion cannot enable live trading.
  const active = await resolveStrategy(cfg);
  notes.push(...active.notes);
  console.log(`[cycle] strategy: ${active.id}${active.source === 'arena' ? ' (arena-promoted genome)' : ''}`);
  const previousStrategy = state.strategyId ?? 'static';
  if (!dryRun && previousStrategy !== active.id) {
    const msg = `strategy switched ${previousStrategy} → ${active.id}; open positions keep the exit rules they were opened with`;
    console.log(`[cycle] ${msg}`);
    await emitEvent({ source: STRATEGY_NAME, level: 'info', type: 'strategy.switched', message: msg, data: { mode: cfg.mode, from: previousStrategy, to: active.id } });
  }
  state.strategyId = active.id;

  // 1) manage open positions: mark prices, apply exits (exits are allowed even when killed/paused)
  const open = openPositions(state);
  if (open.length > 0) {
    const prices = await market.getTokens(open.map((p) => p.mint));
    for (const position of open) {
      const token = prices.get(position.mint);
      if (!token) {
        notes.push(`no current price for ${position.symbol}; exit check skipped`);
        continue;
      }
      const at = now();
      markPrice(position, token.priceUsd, at);
      let reason: ExitReason | undefined;
      let detail = '';
      if (killed && cfg.killClosesPositions) {
        reason = 'kill-switch';
        detail = 'kill switch active and KILL_CLOSES_POSITIONS=true';
      } else {
        const decision = decideExit(
          {
            entryPriceUsd: position.entryPriceUsd,
            highestPriceUsd: position.highestPriceUsd,
            currentPriceUsd: token.priceUsd,
            openedAt: position.openedAt,
            now: at,
          },
          // rules frozen at entry by an arena strategy; otherwise today's static env exits
          position.exitRules ?? cfg.exits,
        );
        if (decision.shouldExit) {
          reason = decision.reason;
          detail = decision.detail;
        }
      }
      if (!reason) continue;
      try {
        const fill = await deps.executor!.sell(position, token.priceUsd, token.liquidityUsd);
        closePosition(position, { priceUsd: fill.priceUsd, proceedsUsd: fill.proceedsUsd, tx: fill.tx }, reason, at);
        closed.push(position);
        const msg = `${fill.simulated ? '[SIMULATED] ' : ''}CLOSE ${position.symbol} (${reason}): pnl ${usd(position.realizedPnlUsd ?? 0)} (${((position.returnPct ?? 0) * 100).toFixed(2)}%) — ${detail}`;
        console.log(`[cycle] ${msg}`);
        await emitEvent({ source: STRATEGY_NAME, level: 'info', type: 'position.closed', message: msg, data: { mode: cfg.mode, position } });
        await alert(`solana-trader ${cfg.mode}: ${msg}${fill.tx ? ` tx=${fill.tx}` : ''}`);
      } catch (error) {
        const msg = `failed to close ${position.symbol} (${reason}): ${(error as Error).message}`;
        console.error(`[cycle] ${msg}`);
        notes.push(msg);
        await emitEvent({ source: STRATEGY_NAME, level: 'error', type: 'position.close-failed', message: msg, data: { mode: cfg.mode, positionId: position.id } });
      }
    }
  }

  // 2) entries
  let entryBlock: string | undefined;
  if (killed) entryBlock = 'kill switch active: no new positions';
  else if (paused) entryBlock = 'strategy paused by orchestrator: no new positions';
  else if (!(budgetUsd > 0)) entryBlock = 'no budget allocated: no new positions';
  else if (active.entryCooldownHours > 0) {
    const lastClose = Math.max(0, ...closedPositions(state).map((p) => new Date(p.closedAt ?? 0).getTime()));
    const until = lastClose + active.entryCooldownHours * 3_600_000;
    if (lastClose > 0 && now().getTime() < until) entryBlock = `entry cooldown (${active.entryCooldownHours}h after the last close) until ${new Date(until).toISOString()}`;
  }
  else if (deps.preTradeCheck) {
    const check = await deps.preTradeCheck().catch((e: Error) => ({ ok: false, message: e.message }));
    if (!check.ok) entryBlock = `pre-trade check failed: ${check.message}`;
  }

  if (entryBlock) {
    notes.push(entryBlock);
  } else {
    const candidates = await market.discover(cfg.maxCandidates);
    if (candidates.length === 0) notes.push('no candidates from market source (API unavailable or nothing listed)');
    const ranked = rankCandidates(candidates, active.strategy);
    const allowed = ranked.filter((c) => c.evaluation.allowed);
    console.log(`[cycle] ${candidates.length} candidates, ${allowed.length} passed deterministic gates`);
    const cutoff = now().getTime() - cooldownMs;
    let dryDeployed = 0;
    let dryOpen = 0;

    for (const { token, evaluation } of allowed) {
      const held = openPositions(state).some((p) => p.mint === token.mint);
      const recentlyClosed = closedPositions(state).some((p) => p.mint === token.mint && new Date(p.closedAt ?? 0).getTime() > cutoff);
      if (held || recentlyClosed) continue;

      const size = computeTradeSize(
        { budgetUsd, deployedUsd: deployedUsd(state) + dryDeployed, openPositions: openPositions(state).length + dryOpen },
        active.sizing,
      );
      if (size.sizeUsd <= 0) {
        notes.push(`entries stopped: ${size.reason}`);
        break;
      }

      if (deps.gate) {
        const verdict = await deps.gate(token, evaluation.score);
        if (verdict.decision !== 'BUY') {
          console.log(`[cycle] claude gate SKIP ${token.symbol}: ${verdict.reason}`);
          continue;
        }
      }

      if (dryRun) {
        dryDeployed += size.sizeUsd;
        dryOpen += 1;
        notes.push(`dry-run: would open ${token.symbol} (${token.mint}) for ${usd(size.sizeUsd)}, score ${evaluation.score}`);
        continue;
      }

      try {
        const position = await openFrom(token, size.sizeUsd, deps.executor!, cfg.mode, now(), active);
        state.positions.push(position);
        opened.push(position);
        const msg = `${position.simulated ? '[SIMULATED] ' : ''}OPEN ${token.symbol} ${usd(position.sizeUsd)} @ $${position.entryPriceUsd.toPrecision(6)} (score ${evaluation.score})`;
        console.log(`[cycle] ${msg}`);
        await emitEvent({ source: STRATEGY_NAME, level: 'info', type: 'position.opened', message: msg, data: { mode: cfg.mode, position } });
        await alert(`solana-trader ${cfg.mode}: ${msg}${position.entryTx ? ` tx=${position.entryTx}` : ''}`);
      } catch (error) {
        const msg = `failed to open ${token.symbol}: ${(error as Error).message}`;
        console.error(`[cycle] ${msg}`);
        notes.push(msg);
        await emitEvent({ source: STRATEGY_NAME, level: 'error', type: 'position.open-failed', message: msg, data: { mode: cfg.mode, mint: token.mint } });
      }
    }
  }

  // 3) metrics + equity curve
  const before = computeMetrics(state.positions, state.equityCurve, cfg.sizing.startingCapitalUsd);
  const equityUsd = cfg.sizing.startingCapitalUsd + before.realizedPnlUsd + before.unrealizedPnlUsd;
  if (!dryRun) state.equityCurve.push({ ts: now().toISOString(), equityUsd: Math.round(equityUsd * 100) / 100 });
  const metrics = computeMetrics(state.positions, state.equityCurve, cfg.sizing.startingCapitalUsd);
  state.maxDrawdown = Math.max(state.maxDrawdown, metrics.maxDrawdown);

  if (!dryRun) await saveState(cfg.mode, state);

  const report: StrategyReport = {
    schema: 'mm.strategy-report/v1',
    name: STRATEGY_NAME,
    kind: 'trading',
    mode: cfg.mode,
    status: killed || paused ? 'paused' : 'active',
    capitalUsd: budgetUsd,
    deployedUsd: metrics.deployedUsd,
    realizedPnlUsd: metrics.realizedPnlUsd,
    unrealizedPnlUsd: metrics.unrealizedPnlUsd,
    totalReturn: metrics.totalReturn,
    winRate: metrics.winRate,
    avgProfit: metrics.avgProfit,
    maxDrawdown: state.maxDrawdown,
    sharpeRatio: metrics.sharpeRatio,
    totalTrades: metrics.totalTrades,
    openPositions: metrics.openPositions,
    lastUpdated: now().toISOString(),
    notes: [
      ...notes,
      `strategy: ${active.id}`,
      `opened ${opened.length}, closed ${closed.length} this cycle`,
      'unrealized PnL is marked at DexScreener price before exit fees/slippage',
    ],
  };
  await writeJsonAtomic(statePaths.strategy(STRATEGY_NAME), report);
  return { report, opened, closed, state };
}

async function openFrom(token: Token, sizeUsd: number, executor: Executor, mode: AppConfig['mode'], at: Date, active: ActiveStrategy): Promise<Position> {
  const fill = await executor.buy(token, sizeUsd);
  if (!(fill.quantity > 0) || !(fill.priceUsd > 0)) throw new Error('executor returned an empty fill');
  return {
    id: randomUUID(),
    mint: token.mint,
    symbol: token.symbol,
    pairAddress: token.pairAddress,
    status: 'open',
    mode,
    simulated: fill.simulated,
    openedAt: at.toISOString(),
    entryPriceUsd: fill.priceUsd,
    sizeUsd: fill.costUsd,
    quantity: fill.quantity,
    quantityRaw: fill.quantityRaw,
    highestPriceUsd: token.priceUsd,
    lastPriceUsd: token.priceUsd,
    lastPriceAt: at.toISOString(),
    entryTx: fill.tx,
    strategyId: active.id,
    ...(active.source === 'arena' ? { exitRules: { ...active.exits } } : {}),
  };
}

