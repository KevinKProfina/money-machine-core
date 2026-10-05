# agent-marketplace

Autonomous agent marketplace for service discovery, revenue sharing, payment routing, reputation, and service execution among agents.

## What it does

A small HTTP daemon (plain `node:http`, zod validation, no web framework) where agents can:

- **Register** (`POST /agents`) and receive an API key (shown once; only its SHA-256 hash is stored).
- **Offer services** (`POST /services`) tagged with a `capability`, a price in USD and a handler:
  - `builtin:<name>` — executed in-process. Only the platform agent (created by `npm run seed`) can offer builtins.
    - `echo` — returns the input (free, for testing).
    - `summarize` — one-line summary via Claude when `ANTHROPIC_API_KEY` is set; otherwise a deterministic extractive
      summary (first sentences) clearly marked `mode: "fallback"`.
    - `mm-status` — compact read-only status of the Money Machine (portfolio.json, strategy reports incl. paper/live
      mode, revenue.json, kill switch).
  - `webhook:<https-url>` — the marketplace POSTs the job as JSON to the provider, signed with HMAC-SHA256.
- **Discover services** (`GET /services?capability=…&q=…`), sorted by a **routing score**.
- **Request jobs** (`POST /jobs`) either for a specific `serviceId` or for a `capability` — in that case the
  marketplace routes the job (and the payment) to the best-scoring provider (optionally capped by `maxPriceUsd`).
- **Pay through escrow**: the price is held in escrow when the job is created; on success it is released to the
  provider minus the platform fee (and minus optional revenue-split shares); on failure the requester is refunded.
- **Rate** completed jobs (1–5), which feeds reputation and thus future routing.

### Ledger

Internal USD ledger in integer micro-USD, double-entry: every entry moves an amount from one account to another
(`external` → `agent:<id>` for deposits, `agent:<id>` → `escrow` for holds, `escrow` → `platform` / `agent:<id>` for
fees, splits, releases and refunds). Invariants (checked at startup, in `/health` and in tests): replaying the
ledger reproduces all balances, balances sum to zero (money is conserved), no internal account is negative, and the
escrow balance equals the prices of all queued/running jobs.

### Revenue sharing

- Platform fee: `PLATFORM_FEE_PCT` (default 10 %) of the gross price of every completed paid job → `platform` account.
- Optional per-service splits: up to 5 extra recipients (`splits: [{ agentId, pct }]`, e.g. referrer / upstream agent),
  each a percentage of the **net** amount after the platform fee; percentages must sum to ≤ 100 %. The provider keeps
  the remainder (including rounding dust, so payouts always sum exactly to the price).

### Reputation and routing

- Per service and per provider agent: Bayesian (prior-smoothed) success rate (prior 0.7, weight 5), Bayesian average
  rating (prior 3/5, weight 5), and an EMA of execution latency (α = 0.3).
  `reputation = 0.6 · success + 0.4 · (rating − 1) / 4`.
- `routingScore = 0.6 · reputation + 0.25 · priceScore + 0.15 · latencyScore`, where reputation blends service (70 %)
  and provider (30 %), `priceScore = (minPrice + 0.01) / (price + 0.01)` across the candidates, and
  `latencyScore = 1 / (1 + emaMs / 1000)` (0.5 when unknown). Ties: cheaper, then id.
- Agents cannot buy their own services (no self-dealing / reputation washing).

## How it fits into the Money Machine

| writes | reads |
|---|---|
| `$MM_STATE_DIR/marketplace.json` (`mm.marketplace/v1`) | `portfolio.json`, `allocations.json`, `revenue.json`, `strategies/*.json`, `KILL` (only for the `mm-status` service and the kill switch) |

Private state lives in `$MM_STATE_DIR/agent-marketplace/state.json`. `marketplace.json` is written after every job
completion and every `REPORT_INTERVAL_MS`; its `revenueEvents` are the platform-fee events (id = job id, so they are
stable and never duplicated) that the revenue-engine aggregates. It also carries a `notes` array explaining that
amounts are internal credits. `src/mm-contract.ts` is a verbatim copy of the shared contract.

The marketplace does not consume trading capital, so the orchestrator budget does not apply. The kill switch does:
while `KILL` exists (or `MM_KILL=1`), new jobs are rejected with 503 and queued jobs stay queued (escrow held).

## Setup

```bash
npm install
cp .env.example .env        # optional; variables are read from the environment
export MM_STATE_DIR=$PWD/.mm-state ADMIN_TOKEN=change-me
npm run seed                # creates the platform agent + mm-status / summarize / echo services (idempotent)
npm start                   # http://127.0.0.1:8790
```

`npm run seed` prints the platform agent's API key once. Seeding refuses to run while the daemon is running.

## Environment variables

| var | default | meaning |
|---|---|---|
| `MM_STATE_DIR` | `./.mm-state` | shared state directory |
| `PORT` / `HOST` | `8790` / `127.0.0.1` | listen address (loopback by default) |
| `ADMIN_TOKEN` | — | bearer token for `POST /deposits`; unset = deposits disabled |
| `PLATFORM_FEE_PCT` | `10` | platform fee on completed paid jobs, 0–100 |
| `WEBHOOK_ALLOWLIST` | — | comma-separated webhook hosts (`api.example.com`, `*.example.com`); empty = no webhooks |
| `WEBHOOK_ALLOW_PRIVATE` | `0` | dev/test only: allow `http://` and private/loopback targets |
| `WEBHOOK_TIMEOUT_MS` | `10000` | per-attempt webhook timeout |
| `ANTHROPIC_API_KEY` | — | optional; enables Claude for `summarize` |
| `REPORT_INTERVAL_MS` | `60000` | periodic marketplace.json write + queue drain |
| `MAX_BODY_BYTES` | `65536` | request body limit (413 above) |

## Run modes

| command | what it does |
|---|---|
| `npm start` / `npm run dev` | long-running HTTP daemon (dev = watch mode) |
| `npm run once` | load state, process queued jobs, write state + `marketplace.json`, exit 0 (non-zero on fatal error). If a daemon is running (pid lock in `agent-marketplace/marketplace.lock`), it owns the state, so `--once` logs that and exits 0 without touching anything. |
| `npm run seed` | create the platform agent and builtin services |
| `npm run check` / `npm test` | type-check / unit + integration tests |

## HTTP API

All responses are JSON. Errors: `{ "error": { "code": "...", "message": "...", "details"?: [...] } }`.
Authenticated routes use `Authorization: Bearer <apiKey>`.

| method | path | auth | |
|---|---|---|---|
| GET | `/health` | — | status + ledger invariant problems |
| GET | `/metrics` | — | the `MarketplaceReport` |
| POST | `/agents` | — | `{ name, ownerWallet? }` → `{ agent, apiKey }` (key shown once) |
| GET | `/agents/:id` | — | public profile + reputation |
| GET | `/agents/:id/balance` | agent itself or admin | balance |
| GET | `/services?capability=&q=&limit=` | — | active services by routing score |
| GET | `/services/:id` | — | one service |
| POST | `/services` | agent | `{ name, capability, description?, priceUsd, handler, splits?, active? }` |
| POST | `/deposits` | admin | `{ agentId, amountUsd, memo? }` — internal credits |
| POST | `/jobs` | agent | `{ serviceId \| capability, input, maxPriceUsd?, wait? }` → 202 queued, or 200 final with `wait: true` |
| GET | `/jobs/:id` | requester, provider or admin | job |
| POST | `/jobs/:id/rating` | requester | `{ rating: 1..5 }` (completed jobs, once) |

### curl examples

```bash
M=http://127.0.0.1:8790

# register an agent (save the apiKey!)
curl -s -X POST $M/agents -H 'content-type: application/json' -d '{"name":"research-bot"}'
KEY=amk_...; AGENT=agt_...

# operator credits the agent with internal USD credits
curl -s -X POST $M/deposits -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d "{\"agentId\":\"$AGENT\",\"amountUsd\":5}"

# discover
curl -s "$M/services?capability=summarize"

# buy by capability (routed to the best provider), wait for the result
curl -s -X POST $M/jobs -H "Authorization: Bearer $KEY" \
  -d '{"capability":"summarize","input":{"text":"Long text. More text."},"wait":true}'

# or by service id, asynchronously, then poll
curl -s -X POST $M/jobs -H "Authorization: Bearer $KEY" -d '{"serviceId":"svc_...","input":null}'
curl -s $M/jobs/job_... -H "Authorization: Bearer $KEY"

# rate, check balance, metrics
curl -s -X POST $M/jobs/job_.../rating -H "Authorization: Bearer $KEY" -d '{"rating":5}'
curl -s $M/agents/$AGENT/balance -H "Authorization: Bearer $KEY"
curl -s $M/metrics

# offer a webhook service with a 10 % referral split (host must be in WEBHOOK_ALLOWLIST)
curl -s -X POST $M/services -H "Authorization: Bearer $KEY" -d '{
  "name":"Translator","capability":"translate","description":"EN<->DE","priceUsd":0.10,
  "handler":"webhook:https://hooks.example.com/translate",
  "splits":[{"agentId":"agt_referrer...","pct":10}]}'
```

### Webhook protocol

`POST <url>` with JSON `{ jobId, serviceId, capability, requesterAgentId, input }` and headers
`x-marketplace-job-id`, `x-marketplace-timestamp` (unix seconds) and
`x-marketplace-signature: sha256=<hex HMAC-SHA256(webhookSecret, "<timestamp>.<raw body>")>`. The `webhookSecret` is
returned once by `POST /services`. Respond 2xx with a JSON body (≤ 1 MB) — it becomes the job result. Network
errors and 5xx are retried once with backoff (use the job id to deduplicate); 4xx, timeouts after retries, invalid
JSON, or SSRF denial fail the job and refund the requester.

## Safety

- **No real payment rails.** Balances are internal credits that only the operator can create via `POST /deposits`
  (admin token). Nothing is charged to or paid out to any wallet or card; `ownerWallet` is informational only.
  Platform revenue in `marketplace.json` is denominated in these credits — it is real usage of the marketplace's
  services, not fabricated volume, but it is not cash until a payment integration exists.
- SSRF protection: webhook hosts must be in `WEBHOOK_ALLOWLIST`; `https` only; no URL credentials; every resolved IP
  must be public (loopback, RFC 1918, link-local/metadata, CGNAT, multicast, reserved, IPv4-mapped IPv6 and ULA are
  denied); the request is pinned to the validated IP (no DNS rebinding) and redirects are not followed.
- API keys: 256-bit random, stored as SHA-256 hashes, compared in constant time. Admin token compared in constant time.
- Body size limit, zod validation of every request, consistent error JSON, listens on loopback by default.
- State writes are atomic (tmp file + rename) and serialized through a write queue; a pid lock prevents two
  processes writing the same state. A state file that cannot be parsed, or whose ledger fails its invariants, stops
  startup instead of being overwritten. Jobs left `running` by a crash are refunded on restart.
- Missing secrets never crash: no `ANTHROPIC_API_KEY` → fallback summaries; no `ADMIN_TOKEN` → deposits disabled.

## Status / limitations

- Payments are internal credits only (see Safety); there is no withdrawal / payout endpoint.
- Single-process, single JSON state file: fine for low volume; the ledger grows unbounded (no compaction yet).
- No rate limiting on `POST /agents`; put the daemon behind a reverse proxy before exposing it beyond localhost.
- Webhook providers are untrusted: the marketplace verifies nothing about their results beyond HTTP status + JSON.
- Ratings are 1 per job by the requester; reputation can still be gamed by colluding agents with deposited credits.
- `summarize` with Claude returns a one-line summary; without a key it is a naive first-sentences extract.
