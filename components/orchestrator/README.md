# orchestrator

The governance layer of the Money Machine. It turns the capital-allocator's proposal into the
**binding** budget for every strategy (`allocations.json`) and publishes portfolio state
(`portfolio.json`). It applies health gates, the kill switch, the reserve, exposure caps,
rebalance smoothing and profit reinvestment. It never trades.

## What it does

Each cycle it:

1. Reads `strategies/*.json`, `allocation-proposal.json`, `revenue.json`, the previous
   `allocations.json`, and its own state in `$MM_STATE_DIR/orchestrator/state.json`. That state
   holds the profit ledgers, equity high-water marks, the kill-switch latch, PnL and revenue
   baselines, and history.
2. **Books realized profit since the last cycle.**
   - Strategy profit is the change in `realizedPnlUsd` per strategy and mode (a paper→live switch
     starts a fresh baseline). On first sighting an existing loss is booked, an existing profit only
     sets the baseline.
   - Revenue-engine streams are added only when their kind is **not** `trading` or `liquidation`.
     Those streams are already counted through strategy PnL, so this avoids counting them twice.
   - Profit is split into **real** (strategies with `mode: live`, streams with `simulated: false`)
     and **simulated** (paper or dry-run strategies, simulated streams). Each has its own ledger.
   - Losses go into a loss carryforward that reduces capital. Later profit repays that loss
     before anything is reinvested.
   - `REINVESTMENT_PERCENT` of the remaining positive profit is added to capital. The rest is
     retained. Nothing is reinvested while portfolio drawdown is at or above the limit, or while
     the kill switch is active.
   - **Simulated profit never funds live strategies.** It is reinvested only while no strategy
     reports `mode: live`, so the whole loop can be simulated. Once any strategy is live, total
     capital and drawdown use the real ledger only.
3. **Total capital** = `TOTAL_CAPITAL` + reinvested profit − unrecovered losses. The simulated
   ledger counts only while nothing is live.
4. **Gates each strategy.** A strategy is paused when its status is `failed`, its report is stale
   (`lastUpdated` older than `STALE_REPORT_MS`), its metrics are invalid, its health is below
   `MIN_HEALTH_SCORE`, or its drawdown is at or above `STRATEGY_DRAWDOWN_PAUSE`. Between
   `STRATEGY_DRAWDOWN_REDUCE` and the pause level, exposure shrinks linearly. When any strategy is
   live, strategies whose report notes contain `synthetic-market-data` are paused with
   allocation 0.
5. **Kill switch.**
   - If portfolio drawdown from the equity high-water mark reaches `MAX_PORTFOLIO_DRAWDOWN`, the
     orchestrator latches a kill state and emits an `error` event. Every allocation is then 0 with
     `killSwitch: true` until an operator runs `npm run reset-kill-switch`.
   - The global switch, `isKillSwitchActive()` (a `KILL` file or `MM_KILL=1`), is always honoured
     but not latched.
   - Total exposure is already scaled down linearly once drawdown passes half of the limit.
6. **Targets.**
   - Deployable capital = (total − `RESERVE_PCT` × total) × drawdown scale.
   - With a fresh, valid proposal, each healthy strategy gets its proposal share × deployable ×
     drawdown factor. Strategies the allocator's risk gate rejected get 0.
   - Without a usable proposal (missing, stale, or malformed), deployable capital is split equally
     among healthy strategies.
7. **Smoothing and limits.**
   - Each strategy moves at most `MAX_REBALANCE_STEP_PCT` × total toward its target per cycle.
   - Pausing goes to 0 immediately. The first cycle with no previous `allocations.json` uses the
     targets directly. After a kill, allocations ramp up from 0.
   - Then hard limits apply: the per-strategy cap `MAX_STRATEGY_EXPOSURE` × total, and a sum no
     larger than deployable capital. Amounts are rounded down to cents.
8. Writes `allocations.json` (`FinalAllocations`) and `portfolio.json` (`PortfolioState`), then
   emits events when strategies become paused or the kill switch trips.
   - `portfolio.json` also carries extra fields: `realProfitUsd`, `simulatedProfitUsd`, `anyLive`
     and `notes`.
   - In `allocations.json`, `reserveUsd` is all unallocated capital: the reserve plus anything
     left over after caps and gates.

## How it fits into the system

```
strategies/*.json ─┐
allocation-proposal.json ─┼─> orchestrator ─> allocations.json ─> strategies (readStrategyBudget)
revenue.json ─┤                   └────> portfolio.json, events.jsonl
KILL ─┘
```

It runs last in the supervisor cycle: strategies → revenue-engine → capital-allocator →
**orchestrator**. Strategies read their budget with `readStrategyBudget(name)`.

## Setup

```bash
npm install
cp .env.example .env   # optional
npm run check && npm test
```

Requires Node 22. `src/mm-contract.ts` is a verbatim copy of `money-machine-core/contract/mm-contract.ts`.

## Environment variables

Fractions accept `0..1` or a percentage (`10` = 0.10).

| var | default | meaning |
|---|---|---|
| `MM_STATE_DIR` | `.mm-state` | shared state directory |
| `TOTAL_CAPITAL` | `1000` | base capital (USD) |
| `RISK_PROFILE` | `moderate` | validated; a warning is logged if it differs from the proposal's profile |
| `MAX_PORTFOLIO_DRAWDOWN` | `0.25` | drawdown that trips the latched kill switch |
| `MAX_STRATEGY_EXPOSURE` | `0.5` | per-strategy cap as a share of total capital |
| `RESERVE_PCT` | `0.1` | share of capital always kept unallocated |
| `MAX_REBALANCE_STEP_PCT` | `0.1` | max change per strategy per cycle, as a share of total capital |
| `REINVESTMENT_PERCENT` | `0.5` | share of positive realized profit added to capital |
| `STRATEGY_DRAWDOWN_REDUCE` | `0.15` | strategy drawdown where exposure starts shrinking |
| `STRATEGY_DRAWDOWN_PAUSE` | `0.35` | strategy drawdown that pauses it |
| `MIN_HEALTH_SCORE` | `50` | health gate (0–100) |
| `STALE_REPORT_MS` | `21600000` | report and proposal staleness limit |
| `POLL_INTERVAL_MS` | `300000` | loop interval |

Invalid values exit with code 1 and write an `error` event.

## Run modes

```bash
npm run once               # one cycle, exit 0 (non-zero on fatal error)
npm start                  # loop mode
npm run dev                # loop mode with file watching
npm run reset-kill-switch  # clear a latched drawdown kill switch (re-anchors the high-water mark)
```

## Safety

- Safe by default. With no inputs it allocates nothing and writes empty, valid files. No secrets
  are needed.
- Pausing and the kill switch take effect immediately and are never smoothed. The drawdown kill
  switch stays latched until an operator resets it.
- Simulated profit (paper PnL, simulated revenue) never increases capital available to live
  strategies.
- Synthetic-market-data strategies get nothing once anything trades live.
- All writes are atomic (temp file + rename).

## Status and limitations

- In paper mode, all PnL and therefore any capital growth is **simulated** (notional). It is
  reported separately as `simulatedProfitUsd`.
- Profit tracking depends on strategies reporting cumulative `realizedPnlUsd`. If a strategy
  resets that counter, the drop is booked as a loss, which errs on the conservative side.
- The first sighting of a strategy or revenue stream sets a baseline. Historic profit from before
  the orchestrator started is not reinvested; historic strategy losses are booked so the drawdown
  guard sees them.
- Health is a governance heuristic from self-reported metrics. It is not a guarantee of anything.
  No profit is promised.
