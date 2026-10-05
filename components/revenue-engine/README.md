# revenue-engine

Revenue tracking and aggregation for the Money Machine system. It collects revenue events from
several streams (trading, AI services, affiliate, digital products, SaaS, …), stores them
deduplicated, and writes an aggregated `revenue.json` with per-stream totals, 7-day / 30-day
windows, a concentration (Herfindahl) index and rule-based diversification recommendations.

**It does not generate revenue by itself.** It only reads and summarizes numbers that other
components, payment providers or you put in front of it. Nothing here moves money.

## What it does

Each cycle:

1. Runs every enabled **source adapter** (`RevenueSource { name; kind; collect(since) }`).
2. Merges the returned `RevenueEvent`s into `$MM_STATE_DIR/revenue-engine/events.json`,
   deduplicated by `id` (an id, once recorded, is never overwritten).
3. Advances per-source cursors / moves imported inbox files **only after** events are persisted.
4. Aggregates all events and writes `$MM_STATE_DIR/revenue.json` (`mm.revenue/v1`).
5. Appends a `revenue.new` event to `events.jsonl` when new revenue was recorded
   (and `revenue.source-failed` when an adapter failed).

Revenue event:

```ts
{ id, stream, kind: RevenueStreamKind, amountUsd /* negative = refund/fee/loss */, timestamp, source, simulated, meta? }
```

### Streams: real integrations vs. manual

| adapter | input | kind | real or simulated? |
|---|---|---|---|
| `trading` | `strategies/*.json` (realized PnL **delta** per strategy since last snapshot; unrealized PnL is never counted) | `trading` / `liquidation` | `simulated = report.mode !== 'live'`. With default paper mode, all trading revenue is **simulated**. |
| `ai-services` | `marketplace.json` → `revenueEvents` | `ai-services` | Labeled **simulated** by default because the marketplace report has no settlement proof. Set `MARKETPLACE_REVENUE_SIMULATED=false` only once payments are real. |
| `inbox` | JSON/CSV files you drop into `$MM_STATE_DIR/revenue-engine/inbox/`, or `npm run add` | any | **Manual.** Real if what you enter is real. Use for affiliate payouts, other platforms' digital product sales, consulting, etc. |
| `stripe` | Stripe API `GET /v1/balance_transactions` (only if `STRIPE_API_KEY` is set) | `STRIPE_STREAM_KIND` (default `saas`) | **Real integration** (live keys). `sk_test_`/`rk_test_` keys → simulated. |
| `gumroad` | Gumroad API `GET /v2/sales?after=YYYY-MM-DD` (only if `GUMROAD_ACCESS_TOKEN` is set) | `digital-products` | **Real integration.** Sales flagged `test` → simulated. |

There are no built-in affiliate-network or SaaS-billing integrations other than Stripe; those go through the inbox.

Mapping details:

- **Trading**: the last-seen realized PnL is stored per `strategy:mode` in `revenue-engine/state.json`.
  A strategy seen for the first time contributes its full realized PnL; decreases are recorded as negative events;
  a mode change (paper → live) starts a new baseline.
- **Stripe**: `charge`/`payment` → gross amount plus a separate negative processing-fee event; `refund`/`payment_refund`
  → negative; `stripe_fee` → negative; payouts/transfers/other types are skipped (not revenue). Cents → USD.
  Non-USD transactions are **skipped with a warning** (no FX conversion). Pagination via `created[gte]` + `starting_after`.
- **Gumroad**: sale `price` (cents) → USD; `gumroad_fee` → negative fee event; `refunded`/`chargedback` → negative
  event for the full price (partial refunds are only flagged in `meta`). Non-USD sales skipped with a warning.
  Pagination via `page_key`. Field mapping was written against Gumroad's documented sale object and tested with
  fixtures only — verify against your account before relying on it.

### Inbox format

CSV with header `id,stream,kind,amountUsd,timestamp,note` (optional extra column `simulated`), or JSON
(an array of the same objects, or `{ "events": [...] }`):

```csv
id,stream,kind,amountUsd,timestamp,note
aff-2026-09,amazon-associates,affiliate,12.50,2026-09-30T00:00:00Z,"September payout"
,etsy,digital-products,-8,2026-10-01,refund
```

- `kind` must be one of `trading, liquidation, ai-services, affiliate, digital-products, saas, other`.
- Empty `id` → deterministic hash of the row, so re-importing the same file does not double count.
- Empty `timestamp` → file modification time.
- Invalid rows are skipped with a warning; the file moves to `inbox/processed/`.
  Unparseable files move to `inbox/failed/`.

### Aggregation

- `totalUsd`, `last7dUsd`, `last30dUsd` (windows are `(now − N days, now]`), per stream the same plus `kind` and `simulated`
  (a stream is `simulated` if **any** of its events is simulated).
- `concentration` = Herfindahl index of the shares of streams with **positive** all-time totals
  (1 = a single stream, 1/n = n equal streams, 0 = no positive revenue).
- Extension fields beyond the contract: `realTotalUsd`, `simulatedTotalUsd`, `eventCount`, `positiveStreams`,
  `recommendations`, `sources` (status of the last cycle's adapters), `notes`.
- Recommendations are deterministic rules (e.g. a stream > 60 % of positive revenue → suggest the least-developed
  other kinds, preferring ones that need little capital; HHI bands; net-negative 30-day streams; mostly-simulated warning).
  They are hints, not forecasts.

`totalUsd` **includes simulated events** (as required by the shared contract); consumers that care about real money
should use `realTotalUsd` or the per-stream `simulated` flag.

## How it fits into the system

Part of the Money Machine (see `money-machine-core/contract/ENGINEERING_BRIEF.md`). The supervisor runs
strategies → **revenue-engine `--once`** → capital-allocator → orchestrator. This repo reads `strategies/*.json`,
`marketplace.json` and its own inbox/APIs, and writes `revenue.json` (read by the orchestrator) plus its own files
under `$MM_STATE_DIR/revenue-engine/`. `src/mm-contract.ts` is a verbatim copy of the shared contract — do not edit it here.

## Setup

```bash
npm install
cp .env.example .env   # optional; .env is loaded automatically if present
npm run check && npm test
```

Requires Node 22.

## Env vars

See `.env.example`. Key ones:

| var | default | meaning |
|---|---|---|
| `MM_STATE_DIR` | `./.mm-state` | shared state directory |
| `REVENUE_INTERVAL_MS` | `300000` | loop interval |
| `REVENUE_SOURCES` | `trading,ai-services,inbox,stripe,gumroad` | adapters to run |
| `REVENUE_BACKFILL_DAYS` | `30` | first-run lookback for API adapters |
| `MARKETPLACE_REVENUE_SIMULATED` | `true` | label marketplace revenue simulated |
| `STRIPE_API_KEY` | — | enables Stripe (use a restricted read-only key) |
| `STRIPE_STREAM_KIND` / `STRIPE_STREAM_NAME` | `saas` / `stripe` | how Stripe revenue is classified |
| `GUMROAD_ACCESS_TOKEN` / `GUMROAD_STREAM_NAME` | — / `gumroad` | enables Gumroad |
| `REVENUE_HTTP_TIMEOUT_MS` / `_RETRIES` / `_BACKOFF_MS` | `15000` / `3` / `500` | API timeout + retry with exponential backoff |

## Run modes

```bash
npm run once      # one cycle, exit 0 (non-zero on fatal error) — used by the supervisor
npm start         # loop mode, every REVENUE_INTERVAL_MS
npm run dev       # loop mode with file watching
npm run report    # print a table aggregated from the event store (read-only; add --json for raw output)
npm run add -- --stream affiliate --kind affiliate --amount 12.5 --note "September payout"
                  # record a manual event (optional: --timestamp ISO, --id <unique id>, --simulated)
```

`npm run add` drops the record into the inbox and runs an inbox-only cycle, so it uses the same
validation, dedupe and lock as file imports. A lock file (`revenue-engine/.lock`) prevents a running loop and
`add` from overwriting each other's writes.

## Safety

- Read-only toward money: no payments, transfers or trades are made. API keys are only used for GET requests;
  use restricted read-only keys.
- Nothing is fabricated: events come only from strategy reports, the marketplace report, your inbox entries or
  provider APIs. Simulated sources are labeled `simulated: true`.
- Missing secrets never crash a cycle — Stripe/Gumroad are simply skipped. API failures are retried with backoff,
  then logged; that adapter contributes nothing for the cycle and its cursor does not advance.
- The kill switch does not stop the engine (it only reads and aggregates); this is logged when the switch is active.
- Access tokens are redacted from logged URLs.

## Status / limitations

- With the default paper-mode strategies and an unverified marketplace, **all automatically collected revenue is simulated**.
  Real revenue appears only via live Stripe/Gumroad keys or entries you make yourself.
- Stripe and Gumroad adapters are tested only against fixture responses (the dev sandbox has no internet).
- USD only; non-USD transactions are skipped, not converted.
- Gumroad partial refunds are not itemized; Stripe disputes/adjustments and payouts are ignored.
- Trading revenue is realized PnL deltas observed between cycles; if a strategy resets its realized PnL within the
  same mode, the drop is recorded as a loss.
- Recommendations are simple rules, not financial advice.
