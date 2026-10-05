# capital-allocator

Scores every Money Machine strategy and writes an **allocation proposal**. It is advisory only:
the orchestrator applies health gates, the kill switch, the reserve and smoothing, and writes the
binding `allocations.json`. This component never trades and never moves money.

## What it does

Each cycle it:

1. Reads `strategies/*.json` from `$MM_STATE_DIR` (via `readStrategyReports()` from the shared contract).
2. Scores each strategy from four components, each mapped to 0..1 and weighted by the risk profile:
   total return, win rate, Sharpe ratio, max drawdown.
3. **Shrinks for small samples.** `confidence = trades / (trades + PRIOR_TRADES)` and
   `adjusted = 50 + confidence × (raw − 50)`. A strategy with 2 lucky trades stays close to the
   neutral score of 50 and cannot dominate a strategy with a long record.
4. **Discounts synthetic market data.** If a report's `notes` contain `synthetic-market-data`, its
   allocation weight is multiplied by `SYNTHETIC_DATA_WEIGHT` (default 0.25). It is also capped at
   `EXPLORATION_SHARE` of capital, or 10 % when exploration is off. The proposal's reasons say so.
5. **Applies a risk gate.** A strategy gets 0 when its status is `failed`, its metrics are invalid,
   its drawdown is above the profile limit, its total return is below the profile floor, or its
   adjusted score is below the profile minimum. Strategies with too few trades skip the score check
   only when an exploration budget exists. A `paused` status is noted but not gated, because the
   orchestrator owns pausing.
6. **Allocates.** Each approved strategy gets `clamp(λ × weight, MIN_STRATEGY_CAPITAL, cap)`, with λ
   chosen so that the sum fits the budget. Allocation is proportional wherever no bound applies, and
   the minimum is never renormalised away. If capital cannot cover every minimum, the weakest
   strategies get nothing. Whatever no strategy can take because of its cap stays unallocated.
   Amounts are rounded down to cents, so the sum never exceeds `TOTAL_CAPITAL`.
7. **Exploration (optional).** With `EXPLORATION_SHARE > 0`, strategies with fewer than
   `MIN_TRADES_FOR_CONFIDENCE` trades are funded only from that budget, split by weight and capped.
8. Writes an `AllocationProposal` to `allocation-proposal.json`, including per-strategy score,
   gate result and reasons. With no reports it writes an empty proposal and logs it. No demo data
   is ever written to the state directory.

| profile | default cap | max drawdown | min return | min score | emphasis |
|---|---|---|---|---|---|
| conservative | 35 % | 20 % | −10 % | 52 | drawdown, Sharpe |
| moderate | 50 % | 30 % | −20 % | 45 | balanced |
| aggressive | 70 % | 45 % | −35 % | 40 | return |

## How it fits into the system

```
strategies/*.json ──> capital-allocator ──> allocation-proposal.json ──> orchestrator ──> allocations.json
```

The supervisor in money-machine-core runs: strategies → revenue-engine → **capital-allocator** →
orchestrator, each with `--once`. The orchestrator uses the proposal's *shares*
(`allocation / totalCapitalUsd`), so `TOTAL_CAPITAL` here only sets the scale of the proposal.

## Setup

```bash
npm install
cp .env.example .env   # optional
npm run check && npm test
```

Requires Node 22. The source file `src/mm-contract.ts` is a verbatim copy of
`money-machine-core/contract/mm-contract.ts`. Do not edit it here.

## Environment variables

| var | default | meaning |
|---|---|---|
| `MM_STATE_DIR` | `.mm-state` | shared state directory |
| `TOTAL_CAPITAL` | `1000` | capital the proposal is computed against (USD) |
| `RISK_PROFILE` | `moderate` | `conservative` \| `moderate` \| `aggressive`; any other value is a fatal error |
| `MIN_STRATEGY_CAPITAL` | `10` | minimum USD per approved strategy |
| `MAX_STRATEGY_SHARE` | by profile | per-strategy cap as a fraction of capital (0.01–1) |
| `EXPLORATION_SHARE` | `0` | budget for low-data strategies (0–0.5, 0 = off) |
| `MIN_TRADES_FOR_CONFIDENCE` | `10` | below this a strategy counts as "low data" |
| `PRIOR_TRADES` | `20` | strength of the neutral prior, in pseudo-trades |
| `SYNTHETIC_DATA_WEIGHT` | `0.25` | score multiplier for synthetic-market-data strategies (0–1) |
| `ALLOCATION_INTERVAL_MS` | `3600000` | loop interval |

Invalid values exit with code 1 and write an `error` event to `events.jsonl`.

## Run modes

```bash
npm run once     # one cycle, exit 0 (non-zero on fatal error)
npm start        # loop mode, every ALLOCATION_INTERVAL_MS
npm run dev      # loop mode with file watching
npm run report   # print the current proposal as a table
```

## Safety

- Read-only with respect to money. It writes only `allocation-proposal.json`, plus an event on fatal
  errors.
- The kill switch is the orchestrator's job. When `KILL` is active, the allocator only logs it,
  because the orchestrator sets every allocation to 0 anyway.
- Failed strategies always get 0. Sums never exceed total capital, and caps and minimums are
  enforced and covered by tests.
- No secrets and no network access are needed.

## Status and limitations

- The scores are simple heuristics over self-reported metrics. If a strategy reports wrong numbers,
  the scores will be wrong too. Paper-mode metrics are simulated, and the proposal does not change
  that.
- Paper and live strategies are scored the same way. Only synthetic *market data* is discounted.
  The orchestrator handles the difference between real and simulated profit.
- No history: each cycle is scored from the current reports only.
