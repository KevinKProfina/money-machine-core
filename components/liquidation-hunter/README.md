# Liquidation Hunter

Strategy `liquidation-hunter` (kind `liquidation`) in the Money Machine system.

> **Status: simulation only.** There is no real opportunity source and no live executor yet.
> Every opportunity is a synthetic position from a seeded generator and every "execution" is a
> paper fill. Nothing here touches a blockchain, and nothing here demonstrates real profitability.

## What it does

Each cycle:

1. **Scan** an `OpportunitySource` for lending positions (default: `SimulatedSource`, seeded and deterministic).
2. **Compute economics** (pure functions in `src/math.ts`): health factor, LTV, max repayable debt
   (close factor, collateral, size cap), collateral seized = repay × (1 + bonus), gross profit,
   minus gas, minus collateral-sale slippage, minus flash-loan fee (if enabled), and a 0–100 risk
   score from margin to threshold, size, gas share of gross profit and collateral volatility.
3. **Deterministic gates** (`src/gates.ts`): liquidatable (HF < 1), repay size ≤
   min(`MAX_LIQUIDATION_SIZE_USD`, budget), net profit ≥ `MIN_LIQUIDATION_PROFIT_USD`,
   gas ≤ `MAX_GAS_SHARE` (30 %) of gross profit, risk score ≤ `MAX_RISK_SCORE`.
4. **Optional Claude gate** (only with `ANTHROPIC_API_KEY`): strict one-line `EXECUTE:` / `SKIP:`
   answer; refusals, errors and unclear answers are treated as SKIP.
5. **Execute** through an `Executor`. Only `PaperExecutor` exists. It models a liquidation race
   against professional searchers: our win probability is
   `PAPER_BASE_WIN_PROBABILITY / (1 + netProfit / COMPETITION_REF_USD + repay / COMPETITION_SIZE_REF_USD)`,
   so large, juicy opportunities are almost always taken by someone else. A lost race (or a
   reverted tx) still pays part of the gas. A won fill suffers adverse selection (the market
   price of the collateral tends to sit below the oracle price — the reason others passed),
   a random price move until the collateral is sold, extra sale slippage, gas spikes and
   occasional large tail losses (collateral dumped into thin liquidity). Fills can lose money.
6. **Record & report**: skipped opportunities go to `decisions.jsonl` with the reason; attempted
   executions go to `executions.jsonl` (status, realized PnL, `simulated: true`). A
   `StrategyReport` is written for the rest of the system.

Real liquidations carry real risks this repo does not remove: price moves between detection and
collateral sale, gas spikes, competing liquidators / MEV, failed or reverted transactions, oracle
updates that heal the position, and slippage when selling the seized collateral.

## How it fits into the system

| reads | writes |
|---|---|
| `$MM_STATE_DIR/allocations.json` (budget, paused), `$MM_STATE_DIR/KILL` | `$MM_STATE_DIR/strategies/liquidation-hunter.json` (`mm.strategy-report/v1`) |
| | `$MM_STATE_DIR/events.jsonl` (execution / cycle events) |
| | `$MM_STATE_DIR/liquidation-hunter/{decisions,executions}.jsonl`, `state.json` |

The money-machine-core supervisor runs `npm run once`. `src/mm-contract.ts` is a verbatim copy of
the shared contract — do not edit it here.

Report fields: `winRate` = attempted executions with positive realized PnL / attempted executions
(skips are never counted); `avgProfit` = mean realized PnL as a fraction of repay size;
`sharpeRatio` = mean / stdev of those per-execution returns; `maxDrawdown` from the equity curve
(starting capital + cumulative PnL); `totalReturn` = realized PnL / starting capital (the budget,
or `STARTING_CAPITAL_USD` when no allocations exist, fixed at the first run in `state.json`).
Liquidations are atomic, so `deployedUsd` and `openPositions` are 0. The notes also show the fill rate.

**Synthetic-data marker:** whenever the opportunities come from `SimulatedSource`, the report's
`notes` contain the exact string `synthetic-market-data` (and `mode` is `paper` or `dry-run`).
Downstream components (capital-allocator, orchestrator, revenue-engine) should use it to avoid
treating these numbers as real performance.

## Setup

```bash
npm install
cp .env.example .env   # optional; every variable has a safe default
npm run check
npm test
```

Node 22+ required.

## Environment variables

| var | default | meaning |
|---|---|---|
| `MM_STATE_DIR` | `.mm-state` | shared state directory |
| `MODE` | `paper` | `paper`, `dry-run`, or `live` (refused) |
| `LIVE_TRADING_CONFIRM` | — | contract confirmation phrase; live is refused regardless |
| `OPPORTUNITY_SOURCE` | `simulated` | only `simulated` works; `kamino`, `marginfi`, `save`, `aave-v3` are stubs and refused |
| `SIM_SEED` / `SIM_POSITIONS_PER_CYCLE` | `42` / `12` | simulated generator seed and size |
| `STARTING_CAPITAL_USD` | `1000` | capital when no `allocations.json` exists |
| `MIN_LIQUIDATION_PROFIT_USD` | `10` | min expected net profit |
| `MAX_LIQUIDATION_SIZE_USD` | `200` | max repay per liquidation (also capped by budget) |
| `MAX_GAS_SHARE` | `0.3` | max gas / gross profit |
| `MAX_RISK_SCORE` | `60` | max risk score (0–100) |
| `MAX_EXECUTIONS_PER_CYCLE` | `3` | attempts per cycle |
| `COLLATERAL_SLIPPAGE_BPS` | `30` | expected slippage selling seized collateral |
| `USE_FLASH_LOAN` / `FLASH_LOAN_FEE_BPS` | `false` / `5` | flash-loan cost model |
| `PAPER_BASE_WIN_PROBABILITY` | `0.4` | race win probability for a tiny opportunity |
| `COMPETITION_REF_USD` / `COMPETITION_SIZE_REF_USD` | `50` / `20000` | how fast win probability falls with net profit / size |
| `PAPER_TX_FAILURE_PROBABILITY` | `0.1` | revert / heal probability even without a competitor |
| `PAPER_REVERT_GAS_FRACTION` | `0.3` | share of gas paid by a losing / reverted tx |
| `PAPER_MAX_GAS_SPIKE_MULTIPLIER` | `2` | paper gas = estimate × U(1, max) |
| `PAPER_MAX_ADVERSE_SLIPPAGE_BPS` | `150` | extra random slippage on paper fills |
| `PAPER_PRICE_MOVE_HORIZON_SEC` | `900` | detection → collateral sold; price move σ = vol·√(t/year) |
| `PAPER_ADVERSE_SELECTION_FRACTION` | `0.55` | mean market discount vs oracle on a won fill, × bonus |
| `PAPER_TAIL_LOSS_PROBABILITY` / `_MIN` / `_MAX` | `0.05` / `0.05` / `0.3` | occasional large loss, fraction of seized collateral |
| `LIQUIDATION_INTERVAL_MS` | `60000` | loop interval |
| `ANTHROPIC_API_KEY` / `CLAUDE_GATE` | — / `on` | optional Claude gate (`claude-opus-5-5`) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | optional alerts |

## Run modes

```bash
npm run once                    # one cycle, exit 0 (non-zero on fatal error)
npm start                       # loop every LIQUIDATION_INTERVAL_MS
npm run dev                     # loop with file watching
MODE=dry-run npm run once       # gates only; records would_execute decisions, no executions
```

`MODE=live` exits with an error at startup: no live executor or real source exists.

## Safety

- Default mode is `paper`; all executions are labelled simulated and never carry a tx hash.
- Live mode is refused even with `LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK`.
- Kill switch (`$MM_STATE_DIR/KILL` or `MM_KILL=1`), orchestrator pause, or zero budget →
  no scan and no new executions; report status `paused` when killed/paused.
- Per-liquidation size ≤ min(`MAX_LIQUIDATION_SIZE_USD`, budget).
- Missing `ANTHROPIC_API_KEY` / Telegram credentials just disable those steps.
- External calls (Telegram) use timeout + retry with backoff and never crash a cycle.

## Status / limitations

- **No real opportunity source.** `src/sources/real-stubs.ts` holds documented skeletons for
  Kamino, MarginFi, Save (Solana) and Aave v3 (EVM); each throws "not implemented".
- **No live executor.** `LiveExecutor` throws.
- `SimulatedSource` parameter ranges (thresholds, bonuses, close factors, gas, volatility) are
  illustrative, not authoritative protocol values.
- The paper model's defaults are deliberately calibrated so that ~50 cycles come out roughly
  break-even (in a 20-seed check: mean about −1 %, individual runs between about −5 % and +4 %,
  drawdowns of a few %). That calibration is an assumption, not a measurement of any real
  market: it only prevents the synthetic strategy from looking like a money printer. Do not read
  the simulated report as evidence of profitability (or of unprofitability).
- The risk score is a heuristic, not a calibrated probability.
