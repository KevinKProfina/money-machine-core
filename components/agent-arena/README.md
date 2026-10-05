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
  default, or a seeded synthetic market; backtests replay GeckoTerminal history). Mints held by any agent are always
  re-priced, even when they dropped out of discovery.
- **Paper fills**: fee bps + slippage bps + constant-product price impact from pool
  liquidity (ported from `solana-trading-agent`'s `PaperExecutor`). Additionally,
  agents hitting the same pool in the same cycle pay the impact of the cumulative
  same-direction flow, so crowded trades get worse fills.
- **Historical backtests + pre-training** on real GeckoTerminal candles with
  walk-forward out-of-sample evaluation, and a **promotion pipeline** that hands the
  best validated genome to `solana-trading-agent` (paper by default) — see below.
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

### Historical backtests on real data (GeckoTerminal)

`npm run backtest` replays real Solana pool history through the **unchanged arena
engine**: `ReplayMarket` (`src/replay-market.ts`) is just another `MarketSource`, and
fixed genomes run in an `Arena` with `lifecycle: false` (no upkeep, deaths or births),
so entry/exit decisions (`species/trader.ts`), paper fills (`paper.ts`), stale
write-offs and the ledger are exactly the code the live arena uses. Open positions are
paper-sold at the end of each window, so results are net of exit costs.

- **Data**: GeckoTerminal public API, no key (`src/geckoterminal.ts`). Pools come from
  `/networks/solana/trending_pools` then `/networks/solana/pools?page=N` (one pool per
  base token, the deepest wins); candles from
  `/pools/{pool}/ohlcv/{minute|hour|day}?aggregate=n&limit=1000&before_timestamp=…&currency=usd`,
  paged backwards. All requests share one throttle (≥ 2.1 s apart, under the public
  ~30 req/min) and retry 429/5xx/network errors with exponential backoff (honouring
  `Retry-After`).
- **Cache**: `$MM_STATE_DIR/arena/history/<pool>-<timeframe><aggregate>.json`
  (e.g. `…-minute5.json`) remembers the covered range; repeated backtests only fetch
  missing edges, `--offline` never touches the network. The still-open candle is never
  cached. `history/pools.json` keeps the last discovered pool list (used offline or
  when discovery fails).
- **Replay snapshot at virtual time T** (one step = timeframe × aggregate):
  price = close of the last candle that has *closed* by T (forward-filled through
  no-trade gaps; a pool is an entry candidate only if it traded within the last hour
  and keeps a price for held positions for 24 h); `priceChange.m5/h1/h24` = close vs the
  last close at or before T−5m/1h/24h (absent when history does not reach back, m5 absent
  for steps > 5 min); `volume24hUsd` = sum over candles closed in (T−24h, T]; `ageHours`
  from `pool_created_at`. **Proxies** (OHLCV has no history for these):
  `liquidityUsd` = discovery-time `reserve_in_usd` × sqrt(price_T / discovery price)
  (constant-product pool value ∝ √price), `marketCapUsd` = discovery FDV × price ratio,
  `buys24h/sells24h` = USD volume of up-/down-candles in $100 units (only the ratio is
  meaningful).
- **No lookahead**: a candle with open time t is only visible from t + step. Tests
  rewrite or delete every candle not closed by T and assert that the snapshot — and
  every position/cash value of a full backtest up to T — is unchanged.
- **Walk-forward**: the window is split into `--folds` consecutive test windows over the
  last `1 − --train-frac` of the history, each with an expanding train window before it.
  Reported separately: *in-sample* (first train window) and *out-of-sample* (test windows,
  compounded). **Promotion only uses out-of-sample numbers.**
- **Metrics per genome**: return (after fees, slippage, impact and final liquidation),
  trades, win rate, max drawdown of the step equity curve, per-trade Sharpe (mean/stdev
  of trade returns, not annualised), exposure (average fraction of equity in positions)
  and time in market.
- **`--evolve`**: the full evolutionary lifecycle (upkeep, deaths, reproduction,
  immigrants; no LLM) on each fold's *train* window with a virtual clock (`--epochs n`
  passes); the best `--top` living genomes are then backtested on the later test
  windows only. This is the real-data pre-training of the population: genomes are
  written to `arena/pretrained.json`, and the live arena (market `dexscreener`) spawns
  those with a positive out-of-sample return once each as `designed` agents
  (`ARENA_ADOPT_PRETRAINED=1`).

```bash
npm run backtest -- --pools 20 --days 7 --timeframe minute --aggregate 5            # leaderboard genomes
npm run backtest -- --pools 20 --days 14 --genomes population --folds 3 --train-frac 0.5
npm run backtest -- --pools 20 --days 7 --genomes my-genomes.json                  # [genome…] or {genomes:[…]}
npm run backtest -- --pools 20 --days 7 --genomes random:20 --seed 3               # random baseline
npm run backtest -- --pools 20 --days 14 --evolve --epochs 3 --top 5 --seed 1      # pre-train on history
npm run backtest -- --offline --days 7 --genomes leaderboard                       # cached data only
```

Other flags: `--capital` (per-genome starting capital, default $100), `--offline`.
Fee/slippage come from `ARENA_FEE_BPS` / `ARENA_SLIPPAGE_BPS`. A 20-pool, 7-day,
5-minute download is ~20 × 3 = 60 requests ≈ 2–3 minutes because of the throttle; the
replay itself takes well under a second per genome. Outputs:
`arena/backtests/latest.json` (`mm.arena-backtest/v1`, this run),
`arena/backtests/results.json` (latest result per genome id; promotion evidence),
`arena/pretrained.json` (`--evolve`). After every backtest `promotions.json` is
re-evaluated.

### Promotion to solana-trading-agent

Every cycle (and after every backtest) the arena writes
`$MM_STATE_DIR/arena/promotions.json` (`mm.arena-promotions/v1`): the top candidates
(living trader agents, plus backtested genomes without a living agent for visibility),
each with `genomeId` (stable content hash of the genome, so arena agents and backtests
of the same genome join), `agentId`, `genome`, `evidence { liveArenaCycles, arenaTrades,
arenaReturn, arenaMaxDrawdown, backtestOos { return, trades, maxDrawdown, sharpe } }`,
`score`, `eligible` and `reasons`; the current `promoted` strategy and a `history`.

A candidate is eligible only if **all** of these hold (env defaults in brackets):

- the live arena runs on real data (`ARENA_MARKET=dexscreener`) — **never from
  `synthetic-market-data`** (nor from a replay population) — and the agent was born
  after the current market source took over;
- arena age ≥ `ARENA_PROMO_MIN_CYCLES` [288 ≈ 1 day], closed trades ≥
  `ARENA_PROMO_MIN_TRADES` [10], arena drawdown ≤ `ARENA_PROMO_MAX_DRAWDOWN` [0.3];
- a GeckoTerminal backtest of the same genome, not older than
  `ARENA_PROMO_MAX_BACKTEST_AGE_HOURS` [168], with step length = arena cycle length,
  whose **out-of-sample** return after simulated costs is > `ARENA_PROMO_MIN_OOS_RETURN`
  [0], with ≥ `ARENA_PROMO_MIN_OOS_TRADES` [5] trades and drawdown ≤
  `ARENA_PROMO_MAX_OOS_DRAWDOWN` [0.3].

`score = oosReturn − 0.5·oosMaxDrawdown + 0.25·clamp(arenaReturn, −1, 1) − 0.25·arenaMaxDrawdown`.
The best eligible candidate is promoted when nothing is promoted yet or when it beats
the promoted strategy's current score by `ARENA_PROMO_MARGIN` [0.02]. A promoted genome
is demoted (the trader falls back to static) when a fresh backtest of it fails the
out-of-sample criteria. Events: `arena.strategy-promoted`, `arena.strategy-demoted`.

The trader only uses it with `STRATEGY_SOURCE=arena`; see its README for the
genome → settings mapping. **Promotion never enables live trading** — it carries
strategy parameters only, and the trader's mode resolution is unchanged.

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
  4. `arena/promotions.json` — `mm.arena-promotions/v1`, read by solana-trading-agent
     when it runs with `STRATEGY_SOURCE=arena` (see above).
  5. Events (`events.jsonl`): `arena.generation-milestone` (first agent reaching
     generation 2, 5, 10, 20, 50, …), `arena.mass-extinction` (> 50 % of the
     population died in one cycle), `arena.llm-batch-spawned`,
     `arena.strategy-promoted`, `arena.strategy-demoted`,
     `arena.invariant-violated`, `cycle.failed`, `fatal`, `config.refused`,
     `backtest.failed`.

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
| `npm run backtest -- …` | historical backtest / `--evolve` pre-training on GeckoTerminal candles (see above); needs internet unless `--offline` with a filled cache |
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
| `ARENA_ADOPT_PRETRAINED` | 1 | spawn positive-OOS genomes from `arena/pretrained.json` once (live `dexscreener` arena only) |
| `ARENA_PROMO_MIN_CYCLES` / `ARENA_PROMO_MIN_TRADES` / `ARENA_PROMO_MAX_DRAWDOWN` | 288 / 10 / 0.3 | arena evidence required for promotion |
| `ARENA_PROMO_MIN_OOS_TRADES` / `ARENA_PROMO_MIN_OOS_RETURN` / `ARENA_PROMO_MAX_OOS_DRAWDOWN` | 5 / 0 / 0.3 | out-of-sample backtest evidence required |
| `ARENA_PROMO_MARGIN` | 0.02 | score margin a challenger needs over the promoted strategy |
| `ARENA_PROMO_MAX_BACKTEST_AGE_HOURS` | 168 | older backtest evidence is ignored |
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
- Backtests (GeckoTerminal) are throttled under the public rate limit, retried with
  backoff, cached on disk, and never run as part of `npm run once`.
- Promotion only publishes strategy parameters; it is never derived from synthetic data
  and cannot change the trader's mode.
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
- **Backtests on memecoin history are noisy.** A few pools and days give a handful of
  trades per genome; a positive out-of-sample number is weak evidence, and it is still
  simulated (paper fill model, no MEV/failed transactions/latency).
- **Survivorship bias**: pool discovery lists pools that are trending/top *today*;
  tokens that rugged and vanished before discovery are missing from the history, which
  flatters long-only strategies. The liquidity and market-cap proxies are anchored to
  discovery-time values (observed after the replayed period); their *dynamics* only use
  past candles, but their level is a mild lookahead. Buy/sell counts are a candle-colour
  proxy, not real transaction counts.
- **"Out-of-sample" is relative.** For evolved genomes it is strict (test windows after
  the train window). Leaderboard/population genomes were evolved live, possibly during
  the backtested period, so their test window may not be unseen data.
- **Out-of-sample gains are not a guarantee.** Promotion is a filter against obviously
  bad strategies, not a forecast; the trader stays in paper mode unless an operator
  explicitly enables live trading.
- Test data for the history/backtest code is generated (`src/testing/gecko.ts`) or
  hand-written fixtures (`fixtures/geckoterminal/`); the sandbox this was built in has
  no internet, so the real GeckoTerminal endpoints were not exercised end-to-end.

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
  backtest-cli.ts     npm run backtest: data loading, walk-forward, reports, promotions
  backtest.ts         evaluate genomes / evolve on a ReplayMarket, metrics, walk-forward splits
  replay-market.ts    historical candles → per-step MarketSnapshots (no lookahead)
  geckoterminal.ts    GeckoTerminal client (throttle, retry, pagination, parsing)
  history.ts          on-disk candle cache + dataset loading
  promotion.ts        promotion criteria, promotions.json, backtest result store
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
