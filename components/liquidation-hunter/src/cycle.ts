import {
  emitEvent,
  isKillSwitchActive,
  readStrategyBudget,
  statePaths,
  writeJsonAtomic,
  type StrategyReport,
  type StrategyStatus,
} from './mm-contract.js';
import { STRATEGY_NAME, type Config } from './config.js';
import type { ClaudeGate } from './claude-gate.js';
import { PaperExecutor, paperOptionsFromConfig, type Executor } from './executor.js';
import { evaluateGates } from './gates.js';
import { appendDecisions, appendExecutions, readExecutions, readMeta, writeMeta, type LedgerMeta } from './ledger.js';
import { computeEconomics } from './math.js';
import { buildReport } from './metrics.js';
import { deriveSeed, mulberry32 } from './rng.js';
import type { OpportunitySource } from './sources/types.js';
import { noopNotifier, type Notifier } from './telegram.js';
import type { DecisionRecord, ExecutionRecord, Opportunity } from './types.js';

/** Exact marker downstream components use to recognise synthetic data. */
export const SYNTHETIC_DATA_NOTE = 'synthetic-market-data';

export type CycleDeps = {
  config: Config;
  source: OpportunitySource;
  /** Defaults to a PaperExecutor seeded from (SIM_SEED, cycle). */
  executor?: Executor;
  claudeGate?: ClaudeGate;
  notifier?: Notifier;
  now?: () => Date;
  log?: (msg: string) => void;
};

export type CycleSummary = {
  cycle: number;
  halted: boolean;
  scanned: number;
  liquidatable: number;
  passedGates: number;
  executed: number;
  decisions: number;
  cyclePnlUsd: number;
  report: StrategyReport;
};

export async function runCycle(deps: CycleDeps): Promise<CycleSummary> {
  const { config, source } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.log(m));
  const notifier = deps.notifier ?? noopNotifier;
  const startedAt = now();

  if (config.mode === 'live') throw new Error('runCycle: live mode is not supported');

  // ---- capital, kill switch, budget ----
  const budget = await readStrategyBudget(STRATEGY_NAME);
  const killed = isKillSwitchActive();
  const capitalUsd = budget ? budget.budgetUsd : config.startingCapitalUsd;
  const paused = killed || (budget?.paused ?? false);

  const prevMeta = await readMeta();
  const meta: LedgerMeta = prevMeta ?? {
    schema: 'liquidation-hunter.state/v1',
    startingCapitalUsd: capitalUsd > 0 ? capitalUsd : config.startingCapitalUsd,
    cycles: 0,
    createdAt: startedAt.toISOString(),
  };
  const cycle = meta.cycles + 1;

  const notes: string[] = [];
  if (source.simulated) {
    notes.push(SYNTHETIC_DATA_NOTE);
    notes.push('SIMULATED: opportunities are synthetic positions from SimulatedSource, not real chain data.');
  }
  notes.push(
    config.mode === 'paper'
      ? 'SIMULATED: executions are paper fills (PaperExecutor: competition race, adverse selection, price moves, tail losses); no transactions are sent. The fill model is a calibrated assumption, not evidence of real performance.'
      : 'dry-run: decisions only, no executions.',
  );

  const decisions: DecisionRecord[] = [];
  const executions: ExecutionRecord[] = [];
  let scanned = 0;
  let liquidatable = 0;
  let passedGates = 0;
  let status: StrategyStatus = 'active';
  const halted = paused || capitalUsd <= 0;

  if (halted) {
    status = paused ? 'paused' : 'active';
    const why = killed ? 'kill switch active' : paused ? 'paused by orchestrator' : 'no budget allocated';
    notes.push(`No new liquidations this cycle: ${why}.`);
    log(`[cycle ${cycle}] halted: ${why}`);
    await emitEvent({ source: STRATEGY_NAME, level: 'warn', type: 'cycle.halted', message: why, data: { cycle } });
  } else {
    // ---- scan ----
    let positions: Awaited<ReturnType<OpportunitySource['scan']>> = [];
    try {
      positions = await source.scan({ cycle, now: startedAt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[cycle ${cycle}] scan failed: ${msg}`);
      notes.push(`Scan failed this cycle: ${msg}`);
      await emitEvent({ source: STRATEGY_NAME, level: 'error', type: 'scan.failed', message: msg, data: { cycle } });
    }
    scanned = positions.length;

    // ---- economics + deterministic gates ----
    const sizeCapUsd = Math.min(config.maxLiquidationSizeUsd, capitalUsd);
    const limits = {
      minNetProfitUsd: config.minNetProfitUsd,
      sizeCapUsd,
      maxGasShare: config.maxGasShare,
      maxRiskScore: config.maxRiskScore,
    };
    const candidates: Opportunity[] = [];
    const ts = startedAt.toISOString();
    const decide = (opp: Opportunity, d: Pick<DecisionRecord, 'decision' | 'stage' | 'reason'>) =>
      decisions.push({
        id: `dec-${cycle}-${decisions.length}`,
        ts,
        cycle,
        mode: config.mode,
        opportunityId: opp.position.id,
        protocol: opp.position.protocol,
        expectedNetProfitUsd: round(opp.economics.netProfitUsd),
        repayUsd: round(opp.economics.repayUsd),
        riskScore: opp.economics.riskScore,
        simulated: opp.position.simulated,
        ...d,
      });

    for (const position of positions) {
      const economics = computeEconomics(position, {
        collateralSlippageBps: config.collateralSlippageBps,
        useFlashLoan: config.useFlashLoan,
        flashLoanFeeBps: config.flashLoanFeeBps,
        maxRepayUsd: sizeCapUsd,
      });
      const opp = { position, economics };
      if (economics.liquidatable) liquidatable++;
      const gate = evaluateGates(economics, limits);
      if (gate.passed) candidates.push(opp);
      else decide(opp, { decision: 'skip', stage: 'gates', reason: gate.reason });
    }
    passedGates = candidates.length;
    const ranked = [...candidates].sort((a, b) => b.economics.netProfitUsd - a.economics.netProfitUsd);

    // ---- optional Claude gate + execution ----
    const executor =
      deps.executor ??
      new PaperExecutor(mulberry32(deriveSeed(config.simSeed, cycle, 0xe8ec)), paperOptionsFromConfig(config));
    if (!executor.simulated) throw new Error('runCycle: refusing non-simulated executor');

    let attempts = 0;
    for (const opp of ranked) {
      if (isKillSwitchActive()) {
        decide(opp, { decision: 'skip', stage: 'halted', reason: 'kill switch activated mid-cycle' });
        continue;
      }
      if (attempts >= config.maxExecutionsPerCycle) {
        decide(opp, { decision: 'skip', stage: 'limit', reason: `max ${config.maxExecutionsPerCycle} executions per cycle` });
        continue;
      }
      if (deps.claudeGate) {
        const verdict = await deps.claudeGate.review(opp);
        if (verdict.decision !== 'execute') {
          decide(opp, { decision: 'skip', stage: 'claude', reason: verdict.reason });
          continue;
        }
      }
      if (config.mode === 'dry-run') {
        decide(opp, { decision: 'would_execute', stage: 'dry-run', reason: 'passed all gates (dry-run, not executed)' });
        attempts++;
        continue;
      }
      attempts++;
      const outcome = await executor.execute(opp);
      const rec: ExecutionRecord = {
        id: `exec-${cycle}-${executions.length}`,
        ts: now().toISOString(),
        cycle,
        mode: config.mode,
        executor: executor.id,
        simulated: executor.simulated,
        opportunityId: opp.position.id,
        protocol: opp.position.protocol,
        status: outcome.status,
        repayUsd: round(opp.economics.repayUsd),
        expectedNetProfitUsd: round(opp.economics.netProfitUsd),
        realizedPnlUsd: round(outcome.realizedPnlUsd),
        gasPaidUsd: round(outcome.gasPaidUsd),
        adverseSlippageBps: round(outcome.adverseSlippageBps),
        ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
      };
      executions.push(rec);
      const label = rec.simulated ? '[SIMULATED] ' : '';
      const msg =
        `${label}${rec.protocol} ${opp.position.collateralSymbol}/${opp.position.debtSymbol} repay $${rec.repayUsd.toFixed(2)}: ` +
        `${rec.status}${rec.failureReason ? ` (${rec.failureReason})` : ''}, pnl $${rec.realizedPnlUsd.toFixed(2)} ` +
        `(expected $${rec.expectedNetProfitUsd.toFixed(2)})`;
      log(`[cycle ${cycle}] ${msg}`);
      await emitEvent({
        source: STRATEGY_NAME,
        level: rec.status === 'success' ? 'info' : 'warn',
        type: 'liquidation.execution',
        message: msg,
        data: rec,
      });
      await notifier.send(`liquidation-hunter: ${msg}`);
    }
  }

  // ---- persist ledger + report ----
  await appendDecisions(decisions);
  await appendExecutions(executions);
  await writeMeta({ ...meta, cycles: cycle });

  const allExecutions = await readExecutions();
  const report = buildReport({
    executions: allExecutions,
    mode: config.mode,
    status,
    capitalUsd,
    startingCapitalUsd: meta.startingCapitalUsd,
    notes,
    now: now(),
  });
  await writeJsonAtomic(statePaths.strategy(STRATEGY_NAME), report);

  const executionsSimulated = executions.every((e) => e.simulated);
  const cyclePnlUsd = round(executions.reduce((s, e) => s + e.realizedPnlUsd, 0));
  const summary = `cycle ${cycle}: scanned=${scanned} liquidatable=${liquidatable} passedGates=${passedGates} executed=${executions.length} skipped=${decisions.filter((d) => d.decision === 'skip').length} cyclePnl=$${cyclePnlUsd.toFixed(2)}${source.simulated || executionsSimulated ? ' (simulated)' : ''}`;
  log(`[cycle ${cycle}] ${summary}`);
  await emitEvent({ source: STRATEGY_NAME, level: 'info', type: 'cycle.completed', message: summary, data: { cycle } });

  return {
    cycle,
    halted,
    scanned,
    liquidatable,
    passedGates,
    executed: executions.length,
    decisions: decisions.length,
    cyclePnlUsd,
    report,
  };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
