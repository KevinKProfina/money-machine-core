# agent-arena — evolutionary agent arena (paper only)

> "Earn money or die." A population of many small autonomous agents, each with a
> balance and a genome (strategy parameters). Every cycle each agent pays upkeep,
> acts, and is evaluated. Agents that fall below the death line die; agents that
> grow their balance reproduce with mutation. Natural selection replaces guesswork.

**PAPER ONLY.** This component has no real-money execution path at all: no wallet,
no swap client, no transaction code. `MODE=live` refuses to start with a clear
message. Every fill is simulated and labeled as such. Nothing here is a promise of
profit — see [Limitations](#status--limitations).

## What it does

- **Population** of agents of a pluggable **species**. Implemented now: `trader`.
- **Shared market snapshot** fetched once per cycle for all agents (DexScreener by
  default, or a seeded synthetic market). Mints held by any agent are always
  re-priced, even when they dropped out of discovery.
- **Paper fills**: fee bps + slippage bps + constant-product price impact from pool
  liquidity (ported from `solana-trading-agent`'s `PaperExecutor`). Additionally,
  agents hitting the same pool in the same cycle pay the impact of the cumulative
  same-direction flow, so crowded trades get worse fills.
- **Lifecycle**: upkeep → act (exits first, then entries) → stale write-offs →
  deaths → reproduction → optional Claude "mutator" → min-population refill and
  random immigrants from the treasury.
- **Money conservation invariant**, checked every cycle (throws + emits an
  `arena.invariant-violated` error event on violation):

  ```
  treasury + Σ agent cash + Σ open-position cost basis
    + cumulative (fees + upkeep + realized losses + LLM cost) − cumulative realized gains
  == initial capital + budget adjustments
  ```

  Species never move money themselves; they return *intents* (`buy`/`sell`) and the
  engine executes them against one ledger, so the invariant holds for every species.

### Trader genome

All genes are bounded and validated (`src/species/trader.ts`); mutation is Gaussian
(log-space for liquidity/volume/TP genes), integers always move at least one step,
cross-gene consistency is repaired (min age < max age, h1 window ordered).

| gene | range | meaning |
|---|---|---|
| minLiquidityUsd | 1k – 5M | min pool liquidity |
| minVolume24hUsd | 1k – 50M | min 24h volume |
| minAgeHours / maxAgeHours | 0 – 720 / 1 – 20000 | pair age window (unknown age only passes when minAge = 0) |
| minBuySellRatio | 0.2 – 4 | min 24h buys/sells |
| minChangeM5, minChangeH1, maxChangeH1, minChangeH24 | % | momentum thresholds on DexScreener `priceChange` (skipped when a field is absent) |
| positionPct | 0.02 – 0.5 | position size as fraction of balance |
| takeProfitPct / stopLossPct / trailingStopPct | 1–500 / 1–90 / 0–80 | exits (trailing 0 = off; trails from the peak once above entry) |
| maxHoldCycles | 1 – 2000 | time exit |
| maxOpenPositions | 1 – 10 | concurrency |
| cooldownCycles | 0 – 100 | wait after closing |
| rankBy | 0–3 | candidate ranking: h1-momentum, turnover, buy-pressure, youngest |

Positions are marked to market every cycle. A position without a fresh price keeps
its last mark and cannot exit; after `ARENA_STALE_WRITE_OFF_CYCLES` without any
price it is written off at zero (a price is never invented).

### Lifecycle and economics

- **Upkeep**: every agent pays `ARENA_UPKEEP_USD` per cycle. If its cash is tied up
  in positions, the shortfall becomes debt that is settled from the next proceeds.
- **Death**: balance (cash − debt + marked positions) < `ARENA_DEATH_USD`. Open
  positions are paper-sold at the current price (unpriced ones written off), the
  remaining dust returns to the treasury, and the agent goes to the graveyard
  (cause `bankrupt` or `budget-levy`). When the market fetch failed, deaths of
  agents holding positions are deferred to the next cycle with prices.
- **Reproduction**: balance ≥ `ARENA_REPRO_MULTIPLE` × birth capital and age ≥
  `ARENA_REPRO_MIN_AGE` cycles → a child with a mutated genome (sometimes crossover
  with another eligible agent) receives `ARENA_REPRO_SHARE` of the parent's balance
  (from free cash). Fitness = (balance + capital given to children − birth capital)
  / birth capital.
- **Treasury**: holds unallocated capital. Funds genesis, refills the population to
  `ARENA_MIN_POPULATION`, spawns `ARENA_IMMIGRANTS_PER_CYCLE` random immigrants
  while the treasury is above `ARENA_TREASURY_RESERVE_PCT` of equity, pays the LLM
  mutator, and receives dust from the dead. `ARENA_MAX_POPULATION` caps all births.
- **Lineage**: id, parentId, generation, origin (`genesis`/`spawn`/`birth`/`designed`),
  bornCycle/bornAt, diedCycle/diedAt, cause of death.

### Optional Claude mutator

If `ANTHROPIC_API_KEY` is set, every `ARENA_LLM_EVERY` cycles the arena sends Claude
(`claude-opus-5-5`, effort low, server-side fallbacks, call shape per the
engineering brief) summary stats of the top and bottom genomes and asks for
`ARENA_LLM_GENOMES` new trader genomes as a JSON array. The answer is parsed
defensively; values are clamped to bounds, objects missing more than half the genes
are rejected. Valid genomes are spawned from the treasury as generation-0
`designed` agents. A refusal (`stop_reason === 'refusal'`) or anything unparseable
is a skip. The estimated cost (usage tokens × `ARENA_LLM_*_USD_PER_MTOK`, worst-case
estimate if usage is missing) is charged to the treasury and is part of the
conservation ledger. `ARENA_LLM_DAILY_BUDGET_USD` is enforced *before* each call
using a worst-case estimate. No key → the step is skipped; evolution runs on its own.

## How it fits into Money Machine

- Supervisor runs it in phase 1 with the other strategies (`npm run once`).
- Reads `allocations.json` via `readStrategyBudget('agent-arena')`: when a budget
  exists, the arena's total equity target follows it — the treasury absorbs the
  difference (and if the treasury is empty, agents' free cash is levied
  proportionally; open positions are not force-sold). Budget flows are booked as
  *adjustments*, never as PnL. While paused/killed the budget is not followed.
- Respects the kill switch (`isKillSwitchActive()`) and orchestrator pause: **no
  new entries and no births; exits still run**.
- Writes:
  1. `strategies/agent-arena.json` — `StrategyReport` (kind `trading`, mode `paper`,
     `capitalUsd` = arena equity, arena-wide realized/unrealized PnL, win rate /
     avg profit / per-trade Sharpe over closed trades of all agents, max drawdown of
     the arena equity curve net of budget flows, notes incl. population, births,
     deaths and `synthetic-market-data` when applicable). `realizedPnlUsd` includes
     closed trades, fees, upkeep and LLM cost.
  2. `arena/summary.json` — `mm.arena-summary/v1`: cycle, market source, population,
     births/deaths (total + last cycle), max generation, treasury, equity, equity
     curve (last 500 points), top-10 leaderboard with genomes, species stats, causes
     of death, LLM spend.
  3. `arena/population.json` (living agents + open positions + ledger + RNG state),
     `arena/graveyard.json` (last 500 dead + aggregate stats),
     `arena/synthetic-market.json` (synthetic market state). All atomic writes.
  4. Events (`events.jsonl`): `arena.generation-milestone` (first agent reaching
     generation 2, 5, 10, 20, 50, …), `arena.mass-extinction` (> 50 % of the
     population died in one cycle), `arena.llm-batch-spawned`,
     `arena.invariant-violated`, `cycle.failed`, `fatal`, `config.refused`.

## Setup

```bash
npm install
cp .env.example .env   # optional
npm run check && npm test
```

Node 22, ESM, TypeScript strict, `tsx`. No secrets are needed.

## Run modes

| command | what |
|---|---|
| `npm run once` | one cycle, persist, write report + summary, exit 0 (non-zero on fatal error) |
| `npm start` | loop, one cycle per `ARENA_INTERVAL_MS` (stops on SIGINT/SIGTERM after the current cycle) |
| `npm run leaderboard` | print summary + top-10 table from `$MM_STATE_DIR/arena/summary.json` |
| `npm run simulate -- --cycles 500 --market synthetic --seed 1` | fast offline evolution run in a fresh temp state dir with a virtual clock (fully reproducible per seed); prints summary + leaderboard. LLM disabled. Env vars still apply, e.g. `ARENA_REPRO_MULTIPLE=1.3 npm run simulate -- --cycles 3000` |

Examples:

```bash
MM_STATE_DIR=$(mktemp -d) ARENA_MARKET=synthetic npm run once
npm run simulate -- --cycles 300 --market synthetic --seed 1
```

Performance: a cycle with 2000 agents (incl. writing a ~4 MB population file) takes
~50 ms on a laptop-class machine; a 300-cycle simulation of ~80 agents takes < 0.1 s.

## Environment variables

| var | default | meaning |
|---|---|---|
| `MM_STATE_DIR` | `./.mm-state` | shared state dir |
| `MODE` | `paper` | `live` is refused; `dry-run` runs as paper |
| `ARENA_MARKET` | `dexscreener` | `dexscreener` or `synthetic` |
| `ARENA_SEED` | random at genesis | RNG seed (persisted) |
| `ARENA_SYNTHETIC_TOKENS` | 40 | synthetic universe size |
| `ARENA_INTERVAL_MS` | 300000 | loop interval |
| `ARENA_STARTING_CAPITAL_USD` | 500 | capital before `allocations.json` exists |
| `ARENA_SEED_USD` | 5 | birth capital of treasury-spawned agents |
| `ARENA_MIN_POPULATION` / `ARENA_MAX_POPULATION` | 20 / 2000 | population bounds |
| `ARENA_IMMIGRANTS_PER_CYCLE` | 1 | random explorers per cycle (0 = only min-population refill) |
| `ARENA_TREASURY_RESERVE_PCT` | 0.2 | immigrants only while treasury > this × equity |
| `ARENA_MAX_SPAWNS_PER_CYCLE` | 20 | max min-population refills per cycle |
| `ARENA_UPKEEP_USD` | 0.002 | per agent per cycle |
| `ARENA_DEATH_USD` | 0.5 | death line (must be < seed) |
| `ARENA_REPRO_MULTIPLE` | 2 | reproduce at balance ≥ multiple × birth capital |
| `ARENA_REPRO_MIN_AGE` | 12 | min age in cycles to reproduce |
| `ARENA_REPRO_SHARE` | 0.5 | share of the parent's balance given to the child |
| `ARENA_MUTATION_RATE` | 0.2 | per-gene mutation probability |
| `ARENA_CROSSOVER_RATE` | 0.15 | probability of crossover before mutation |
| `ARENA_FEE_BPS` / `ARENA_SLIPPAGE_BPS` | 30 / 100 | paper fill costs (same defaults as solana-trading-agent) |
| `ARENA_MIN_TRADE_USD` | 0.25 | smallest paper order |
| `ARENA_STALE_WRITE_OFF_CYCLES` | 288 | write off positions without any price for this long |
| `ANTHROPIC_API_KEY` | — | enables the Claude mutator |
| `ARENA_LLM_EVERY` | 50 | mutator cadence (cycles) |
| `ARENA_LLM_GENOMES` | 5 | genomes requested per call |
| `ARENA_LLM_DAILY_BUDGET_USD` | 1 | hard daily cap (UTC day) |
| `ARENA_LLM_INPUT_USD_PER_MTOK` / `ARENA_LLM_OUTPUT_USD_PER_MTOK` | 4 / 20 | cost estimate |
| `ARENA_VERBOSE` | 0 | `1` logs every paper trade |

**About upkeep:** the default `ARENA_UPKEEP_USD=0.002` per agent per cycle models
the compute cost of a tiny *rule-based* agent (a few comparisons per cycle). Real
LLM-driven agents cost **orders of magnitude more** per decision (cents to dollars
per call); an arena of LLM agents would need a correspondingly higher upkeep, and
most of them would starve. With the defaults, upkeep alone is ≈ $0.58 per agent per
day at 5-minute cycles — over 2000 cycles it eats most of a $5 seed, which is
deliberate selection pressure.

## Safety

- No real-money path exists; `MODE=live` exits non-zero with an explanation.
- Kill switch / orchestrator pause → no entries, no births, exits still run.
- All external calls (DexScreener) have timeout + retry with backoff and degrade
  gracefully: a failed fetch means no new entries that cycle; upkeep is still paid,
  positions keep their last mark.
- Money conservation is asserted every cycle; a violation stops the loop.
- The Claude mutator is optional, budget-capped, and its output is validated and
  clamped; it can only propose genomes, never move money.

## Status / limitations

Be honest about what this is:

- **Paper only.** Fills are modeled (fee + slippage + constant-product impact), not
  executed. Real DEX execution has MEV, failed transactions, priority fees, token
  transfer taxes and liquidity that moves within a cycle; none of that is modeled.
  Our own trades do not move the mark price across cycles.
- **The synthetic market proves nothing about real markets.** It is a random walk
  with hidden persistent trends, jumps and rug pulls, designed so evolution has
  *something* to find. Genomes that win there are tuned to the generator. Every
  report produced with it carries `synthetic-market-data`.
- **Survivors on real data still need long evaluation.** A paper survivor over a few
  hundred cycles is mostly luck + selection bias (with thousands of agents, some
  will look great by chance). Treat leaderboards as hypotheses, not strategies.
- **Evolution overfits to the recent regime.** Selection rewards what worked in the
  last weeks; when the regime changes, the population can collapse (watch for
  `arena.mass-extinction`).
- **DexScreener discovery is narrow and biased** (latest profiles / boosts), and its
  `priceChange`, `txns` and liquidity numbers can be stale or manipulated.
- With the spec defaults (repro at 2×, upkeep 0.002, slippage 100 bps) reproduction
  is rare; on the synthetic market the arena loses money over the first few hundred
  cycles (`npm run simulate -- --cycles 300 --seed 1`: equity $500 → ~$415, mostly
  upkeep and round-trip costs). That is the expected cost of exploration, not a bug.
- Per-trade Sharpe is a crude, non-annualised statistic.

## Next step: `service` species (not implemented)

The species framework (`src/types.ts` → `Species`, registry in
`src/species/registry.ts`) is built so a second species can plug in:

1. Add `src/species/service.ts` with a genome of service parameters (which service
   types to offer, price per job, quality/compute budget per job, max concurrent
   jobs, bid aggressiveness).
2. Extend `Intent` with service intents (e.g. `list-service`, `bid-job`,
   `deliver-job`) and `ActContext` with a marketplace snapshot read from
   `agent-marketplace` (its `marketplace.json` / HTTP API).
3. Let the engine execute those intents against the same ledger: revenue credited
   to agent cash (booked as realized gains), compute cost per job as an explicit
   ledger term — the conservation invariant then covers both species.
4. Upkeep per species (a service agent that calls an LLM per job must pay real
   LLM costs), and species stats are already reported per species in `summary.json`.
5. Revenue from service agents should also be reported to revenue-engine as its
   own stream (simulated until real jobs are paid).

## Layout

```
src/
  index.ts            CLI: --once / loop
  simulate.ts         offline evolution run (temp state dir, virtual clock)
  leaderboard.ts      prints the leaderboard from summary.json
  runner.ts           wiring: config, state, market, control (kill/budget), outputs
  arena.ts            engine: lifecycle, ledger, invariant, events
  species/            Species registry + trader species
  genome.ts           bounded genes, mutation, crossover, coercion
  market.ts           shared snapshot model
  dexscreener.ts      DexScreener source (discovery + batched token lookups)
  synthetic-market.ts seeded synthetic market
  paper.ts            paper fill math
  mutator.ts          optional Claude mutator
  report.ts           StrategyReport + summary + metrics
  state.ts            persistence (population, graveyard)
  mm-contract.ts      verbatim copy of the Money Machine contract
```
