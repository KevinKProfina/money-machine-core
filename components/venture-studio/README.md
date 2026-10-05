# venture-studio — autonomous digital-product studio with a human launch gate

The studio looks for small income ideas, scores them, builds the product and its
landing page, reviews the content against a policy, and then **stops and asks the
owner**. Everything that goes public or touches money — deploying the site,
creating Stripe products/payment links, making a product purchasable — happens only
after the owner approved *that specific venture*. Nothing here is a promise of
income: most products sell nothing (see [Limitations](#status--limitations)).

## What it does

```
            ┌─────────────── autonomous ───────────────┐   ┌── owner ──┐   ┌──────── after approval ────────┐
 history ─▶ │ 1 scout ─▶ 2 score ─▶ 3 build ─▶ review   │──▶│ 4 approve │──▶│ 5 publish ─▶ 6 measure & evolve │
            └──┬───────────┬──────────────────────┬─────┘   └─────┬─────┘   └──────┬───────────────┬──────────┘
               │           │                      │               │                │               │
            parked      rejected               blocked         rejected          killed         winner
         (needs human) (score/filter)   (policy after 1 rev.)  (owner note        (0 sales in    (≥3 sales →
                                                                → history)         eval window)   ≤2 follow-ups,
                                                                                                  same gate)
```

States: `idea → queued → review → ready → approved → live → winner | killed`, plus
`parked`, `rejected`, `blocked`. Each cycle (`--once`) advances every venture by
**at most one stage**.

1. **Opportunity scout.** While `idea+queued+review+ready+approved+live <
   STUDIO_MAX_ACTIVE` and at most `STUDIO_IDEAS_PER_DAY` per UTC day, Claude proposes
   ideas as structured JSON (title, slug, category, product type, audience, problem,
   deliverable outline, price, language, keywords, why people pay, and an
   **autonomy assessment**: every step needed to make money, marked `self` or
   `human`). `autonomyScore` is recomputed by the studio as the share of `self`
   steps (the model's own number is not trusted). The prompt contains the venture
   history (winners, killed + reasons, blocked + reasons, owner rejections + notes,
   parked). Only `digital-product` and `micro-tool` are built; `content-site` and
   `service-listing` are **parked** with their human steps and listed in the summary
   as "opportunities needing a human". Without `ANTHROPIC_API_KEY` the studio uses a
   small built-in **seed catalog** (`source: 'seed'`) so the whole pipeline runs
   offline.
2. **Scoring.** Deterministic hard filters first (trademarks/celebrities in names,
   medical/legal/financial advice, get-rich-quick, adult/gambling/weapons/drugs,
   political, outreach, third-party content). Then a Claude critic score 0–100
   (demand, competition, AI-buildability, legal risk). Final score =
   `(1−w)·critic + w·autonomy·100` with `w = STUDIO_AUTONOMY_WEIGHT`. Kept if final ≥
   `STUDIO_MIN_SCORE` **and** critic ≥ `STUDIO_MIN_CRITIC` (extra floor so a fully
   autonomous but weak idea cannot pass on autonomy alone).
3. **Build.** Claude writes the full product (Markdown for digital products, a
   single self-contained HTML file with inline JS and no network access for
   micro-tools), rendered with `marked` (raw HTML in Markdown is escaped). Landing
   copy comes as JSON and is put into a fixed template: headline, benefits, outline,
   price, FAQ, buy-button placeholder, SEO meta, OpenGraph, JSON-LD `Product` (no
   ratings), an **AI-assisted** notice and the German **withdrawal-right notice for
   digital content** (§ 356 Abs. 5 BGB). Then a separate **policy review** (Claude,
   effort `low`) plus deterministic regex checks (and a no-network check for
   micro-tools). Failing content gets **one** revision, then `blocked` with reasons.
   Passing → `ready` → approval request.
4. **Approval queue** — see [The launch gate](#the-launch-gate).
5. **Publish** (approved only) — static site in `$MM_STATE_DIR/studio/site/`:
   `/index.html` (catalog of live products), `/<slug>/index.html` (landing),
   `/<slug>/<128-bit-token>/` (download page, `noindex`), `/impressum.html`,
   `/datenschutz.html`, `/sitemap.xml`, `/robots.txt`. Requires
   `STUDIO_SITE_URL` and `STUDIO_OPERATOR_NAME/ADDRESS/EMAIL` (Impressumspflicht),
   otherwise the venture is `blocked: operator details missing` (it resumes
   automatically once configured). The site is rebuilt into a temp dir and swapped in;
   then `STUDIO_DEPLOY_CMD` runs (shell, cwd = site dir, timeout, logged to
   `studio/deploy.log`; failures are retried next cycle). Sales channel:
   - `stripe` (`STRIPE_API_KEY`): REST via `fetch` (form-encoded, idempotency keys,
     retry with backoff): `POST /v1/products`, `POST /v1/prices` (cents,
     `STUDIO_CURRENCY`), `POST /v1/payment_links` (`line_items[0][price]`,
     `line_items[0][quantity]=1`, `after_completion[type]=redirect`,
     `after_completion[redirect][url]=<download url>`, withdrawal waiver as
     `custom_text[submit][message]`). Sales + funnel: `GET /v1/checkout/sessions?payment_link=…`
     (all statuses, paginated; sales = `complete` + `paid`). Kill: `POST /v1/payment_links/<id>` `active=false`.
     Test keys (`sk_test_`/`rk_test_`) → all sales flagged **simulated**.
   - `none`: landing page shows "coming soon"; nothing can be bought or become a
     winner; the summary says revenue needs `STRIPE_API_KEY`. If a key is added
     later, live ventures get their payment link on the next cycle.
6. **Measure & evolve.** Every cycle measures the funnel of each live venture (see
   [Funnel measurement & diagnosis](#funnel-measurement--diagnosis)) and decides
   with the diagnosis. After `STUDIO_EVAL_DAYS` purchasable:
   - 0 sales → `killed` (link deactivated, landing "discontinued" + `noindex`,
     removed from catalog and sitemap, redeploy; the download page stays so earlier
     buyers keep access). The kill reason records the diagnosis:
     `no-traffic` → *"traffic problem, not necessarily a product problem"*;
     `no-interest` → additionally **one re-angle follow-up** (different angle and/or
     price, `followUpKind: 'reangle'`; never for a re-angle itself);
     `checkout-friction` → **not** killed at the normal window: flagged in the
     summary (`attention`) and an event, kept live up to `STUDIO_EVAL_DAYS ×
     STUDIO_FRICTION_GRACE_FACTOR` days, then killed if still 0 sales.
   - ≥ `STUDIO_WINNER_SALES` → `winner`, which spawns up to 2 follow-up ideas
     (variant / bundle / price test, `parentId`, `generation`).
   - Ventures with 1…(winner−1) sales stay live.

   **All follow-ups (winner and re-angle) go through scoring, build, review and the
   owner gate again.** Diagnoses and funnel numbers are part of the venture history
   that is fed into the ideation prompt, together with a short guide on what each
   diagnosis means, so the scout can learn (e.g. "no-traffic" ≠ bad product).

Per-venture sales are used only for studio decisions and are **not** sent to
`revenue-engine` (its own Stripe adapter already counts the money).

## Funnel measurement & diagnosis

```
landing visits ──▶ buy clicks ──▶ checkouts started ──▶ sales (paid)
(analytics beacon)  (beacon)      (Stripe sessions,      (Stripe, complete+paid)
                                   any status)
```

- **Visits / unique visitors / buy clicks / downloads** come from
  [`components/analytics-collector`](../analytics-collector) (cookieless, aggregates
  only). Source selection: the collector's daily files when a **running** collector
  shares this `MM_STATE_DIR` (its heartbeat `$MM_STATE_DIR/analytics/collector.json`
  exists; if the heartbeat is older than 36 h the data counts as unavailable instead
  of "zero visits"), otherwise
  `GET {STUDIO_ANALYTICS_URL}/stats?site=…&from=…&to=…` with
  `Authorization: Bearer $ANALYTICS_READ_TOKEN` (timeout + retry), otherwise none.
  Analytics is used only when `STUDIO_ANALYTICS_URL` is set (without a beacon on the
  pages, zero visits would be meaningless).
- **Checkouts:** one paginated `GET /v1/checkout/sessions?payment_link=…` (all
  statuses) per live venture per cycle: `started` = all sessions, plus
  `open` / `expired` / `complete`; sales = complete **and** paid.
- **Window:** from the day the venture became purchasable (or was published), but
  never before the day the beacon was first deployed, so days without a beacon are
  not counted as "zero traffic".
- **Diagnosis** (`diagnose()` in `src/funnel.ts`, pure and unit-tested; thresholds
  via env):

  | diagnosis | rule (sales = 0 unless stated) |
  |---|---|
  | `converting` | ≥ 1 sale (but: ≥ `STUDIO_DIAG_MIN_FRICTION_CLICKS` checkouts started and completion < `STUDIO_DIAG_MIN_CHECKOUT_COMPLETION` → `checkout-friction`) |
  | `no-traffic` | visits < `STUDIO_DIAG_MIN_VISITS` (50) and fewer than 3 buy clicks/checkouts |
  | `no-interest` | enough visits, click rate < `STUDIO_DIAG_MIN_CLICK_RATE` (2 %) — wins over a few abandoned checkouts — or too few clicks to speak of friction |
  | `checkout-friction` | ≥ `STUDIO_DIAG_MIN_FRICTION_CLICKS` (3) buy clicks / started checkouts, none completed |
  | `unknown` | no analytics data and no Stripe signal (falls back to the plain "no sales" rule) |

- If analytics is configured but unreachable, an evaluation decision waits up to
  2 extra days for data instead of deciding blind.
- **summary.json** gains `live[].funnel` (visits, uniqueVisitors, buyClicks,
  downloads, checkoutsStarted/Open/Expired/Completed, sales, clickRate,
  checkoutCompletionRate, conversionRate, trafficSource, since, diagnosis,
  diagnosisReason), `live[].diagnosis`, `traffic` (site-wide `last7d` / `last30d`
  totals incl. bots filtered and top referrer hosts, source, error) and `attention`
  (e.g. checkout friction). `npm run status` prints them.

### The beacon

When `STUDIO_ANALYTICS_URL` is set, landing pages (live / coming soon /
discontinued), the catalog and digital-product download pages get a ≤ 1 KB inline
script (no third-party script, no cookies, no storage): `pageview` on load (with
`document.referrer`), `buy_click` on the buy button, `download` on the download page.
It posts `{site, path, event, ref?}` via `navigator.sendBeacon` to
`{STUDIO_ANALYTICS_URL}/e`. The path is fixed by the studio (`/<slug>/`), so the
secret download token is never sent. Browsers with Do-Not-Track / Global Privacy
Control send nothing. Previews never contain the beacon. **Micro-tool** download
pages stay beacon-free because the tool promises "no network access" (their
downloads are not counted). Enabling/changing the analytics URL triggers a site
rebuild + redeploy, and the generated **Datenschutz** page then describes the
collector truthfully (what is sent, transient IP/UA processing, daily salt, no
storage of IP/UA, aggregates only, retention `ANALYTICS_RETENTION_DAYS`, legal
basis Art. 6 (1) f DSGVO, DNT/GPC). Without analytics it keeps saying that no
analytics is used.

## How it fits into the system

A cycle component run by the `money-machine-core` supervisor (`--once`). It reads
`KILL` / `MM_KILL` and `allocations.json` (`paused` for `venture-studio` is treated
like the kill switch), writes only below `$MM_STATE_DIR/studio/`, and appends events
to `events.jsonl` via `emitEvent` (`studio.ideas`, `studio.ready_for_approval`,
`studio.approved`, `studio.rejected`, `studio.publish`, `studio.kill`,
`studio.winner`, `studio.blocked`, `studio.deploy`, `studio.deploy_failed`,
`studio.funnel_alert`). With analytics it reads `$MM_STATE_DIR/analytics/<site>/*.json`
(written by `analytics-collector`) or the collector's `/stats` endpoint. It does
not consume capital and writes no `strategies/*.json`.

Files in `$MM_STATE_DIR/studio/`:

| file | writer | content |
|---|---|---|
| `ventures.json` | studio | full state (`mm.studio-state/v1`) |
| `ventures/<id>/` | studio | preview: `landing.html`, `product.html`, `product.md`, `copy.json` |
| `approvals.json` | **studio only** | requests + consumed decisions (`mm.studio-approvals/v1`) |
| `decisions.jsonl` | owner (dashboard, CLI) | append-only decisions |
| `summary.json` | studio | dashboard summary (`mm.studio-summary/v1`) |
| `site/` | studio | the public static site (approved ventures only) |
| `deploy.log` | studio | deploy command output |

## The launch gate

**Why:** the studio writes product claims, prices and legal pages on the owner's
name and domain, and takes real money. An LLM can be wrong in ways regex cannot
catch (quality, tone, legal subtleties). The owner is legally responsible, so a human
looks at every product before it can be bought. The gate is **mandatory and has no
switch**: no env var disables it, and `--auto-approve` exists only inside the
offline simulator (the real CLI exits with an error if it is passed). Killing /
unpublishing never needs approval, because it reduces exposure.

**Previews** live in `studio/ventures/<id>/` (never inside `site/`), so nothing of a
pending venture can be deployed.

### `approvals.json` (read-only for everyone but the studio)

```jsonc
{
  "schema": "mm.studio-approvals/v1",
  "requests": [
    {
      "ventureId": "v0002",
      "title": "15 E-Mail-Vorlagen für Handwerksbetriebe",
      "slug": "handwerk-email-vorlagen",
      "price": 12,
      "currency": "eur",
      "previewPath": "/abs/path/.mm-state/studio/ventures/v0002",   // landing.html + product.html
      "policyReport": { "pass": true, "checkedAt": "…", "claudeReviewed": true, "findings": [], "notes": [] },
      "requestedAt": "2026-10-05T10:00:00.000Z",
      // set by the studio once it consumed a decision:
      "decision": "approved",            // | "rejected"
      "decidedAt": "2026-10-05T12:00:00.000Z",
      "decidedBy": "dashboard:owner",
      "note": "optional"
    }
  ]
}
```

A request is **pending** while `decision` is absent. The file does not exist until the first venture becomes `ready` (treat a missing file as an empty queue).

### `decisions.jsonl` (how the dashboard/CLI decide)

Append **one JSON object per line** (never rewrite the file):

```json
{"ventureId":"v0002","decision":"approved","decidedAt":"2026-10-05T12:00:00.000Z","decidedBy":"dashboard:owner"}
{"ventureId":"v0003","decision":"rejected","decidedAt":"2026-10-05T12:01:00.000Z","decidedBy":"dashboard:owner","note":"too generic"}
```

Fields: `ventureId` (string), `decision` (`"approved"|"rejected"`), `decidedAt`
(ISO timestamp), `decidedBy` (non-empty string), `note` (optional string; for
rejections it is fed back into ideation history). Each studio cycle applies the
**first** valid line per venture that targets a **pending** request and is not older
than its `requestedAt`; unknown ids, already-decided requests, stale and malformed
lines are ignored, so duplicates are harmless. The decision takes effect on the next
cycle (ready → approved), publishing on the one after (approved → live).

TypeScript helpers in `src/approvals.ts`: `readApprovals()`, `pending()`,
`pendingApprovals()`, `appendDecision()`, `decide()` (append only if pending),
`parseDecisionLine()`; studio-internal: `addRequest()`, `applyDecisions()`.

## Setup

```bash
npm install
cp .env.example .env     # optional
npm run once             # one cycle (offline seed catalog without secrets)
npm run status           # summary + pending approvals
npm run approve -- v0002
npm run reject -- v0003 too generic for the audience
npm run simulate -- --days 60 --seed 1 --auto-approve
```

## Run modes / CLI

| command | what |
|---|---|
| `npm run once` | one cycle (`tsx src/index.ts --once`) |
| `npm start` | loop every `STUDIO_INTERVAL_MS` (default 1 h); single-writer lock per state dir |
| `npm run status` | print `summary.json` |
| `npm run approve -- <id>` / `npm run reject -- <id> [note]` | append a decision line (pending requests only) |
| `npm run simulate -- --days 60 --seed 1 [--auto-approve] [--cycles-per-day 4]` | offline funnel in a temp dir: fake Claude, fake Stripe (test mode), fake deploy, fake analytics collector (shared state dir), virtual clock, seeded per-product visits / click rate / checkout completion; prints per-venture funnel + diagnosis |
| `npm run check` / `npm test` | typecheck / offline tests |

`MODE` (`paper` default, `dry-run`, `live`) only matters for a **live** Stripe key:
`sk_live_…`/`rk_live_…` is used only with `MODE=live` and
`LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK`, otherwise it is ignored
(channel `none`, reason in the summary). The owner gate applies in every mode.

## Environment variables

| var | default | meaning |
|---|---|---|
| `MM_STATE_DIR` | `./.mm-state` | shared state dir |
| `MODE`, `LIVE_TRADING_CONFIRM` | `paper`, – | see above |
| `STUDIO_INTERVAL_MS` | 3600000 | loop interval |
| `STUDIO_MAX_ACTIVE` | 5 | max ventures in idea…live before ideation pauses |
| `STUDIO_IDEAS_PER_DAY` | 3 | ideas per UTC day |
| `STUDIO_AUTONOMY_WEIGHT` | 0.4 | weight of autonomy in the final score |
| `STUDIO_MIN_SCORE` | 60 | min final score |
| `STUDIO_MIN_CRITIC` | 45 | min critic score on its own |
| `STUDIO_MIN_PRODUCT_CHARS` | 4000 | min Markdown length of a digital product |
| `STUDIO_EVAL_DAYS` | 21 | evaluation window after becoming purchasable |
| `STUDIO_WINNER_SALES` | 3 | sales for `winner` |
| `STUDIO_SITE_URL` | – | public base URL (required to publish) |
| `STUDIO_OPERATOR_NAME/ADDRESS/EMAIL` | – | Impressum (required to publish) |
| `STUDIO_DEPLOY_CMD` | – | deploy command (cwd = site dir); unset → site only written locally |
| `STUDIO_DEPLOY_TIMEOUT_MS` | 120000 | deploy timeout (process group is killed) |
| `STUDIO_CURRENCY` | `eur` | Stripe currency |
| `STUDIO_PRICE_NOTE` | `Endpreis / final price` | text under the price (adapt to your VAT status) |
| `STRIPE_API_KEY` | – | sales channel; test key → simulated |
| `ANTHROPIC_API_KEY` | – | Claude; unset → seed catalog, regex-only review |
| `STUDIO_LLM_DAILY_BUDGET_USD` | 3 | hard daily LLM cap |
| `STUDIO_LLM_INPUT_USD_PER_MTOK` / `_OUTPUT_` | 4 / 20 | cost model |
| `STUDIO_ANALYTICS_URL` | – | public collector base URL; enables the beacon + Datenschutz section + funnel traffic |
| `STUDIO_ANALYTICS_SITE` | hostname of `STUDIO_SITE_URL` | site id for beacons / collector files |
| `ANALYTICS_READ_TOKEN` | – | bearer token for `/stats` (only when the collector does not share `MM_STATE_DIR`) |
| `ANALYTICS_RETENTION_DAYS` | 400 | stated in the Datenschutz page (keep equal to the collector) |
| `STUDIO_DIAG_MIN_VISITS` | 50 | below → `no-traffic` |
| `STUDIO_DIAG_MIN_CLICK_RATE` | 0.02 | below → `no-interest` |
| `STUDIO_DIAG_MIN_FRICTION_CLICKS` | 3 | clicks/checkouts needed for `checkout-friction` |
| `STUDIO_DIAG_MIN_CHECKOUT_COMPLETION` | 0.25 | completion below → `checkout-friction` (even with sales) |
| `STUDIO_FRICTION_GRACE_FACTOR` | 2 | friction ventures stay live up to eval × factor |

## Safety / guardrails (always on)

- **Launch gate** (above). No env var turns it off.
- **LLM spend cap**: before every call the worst case (prompt ≈ 2 chars/token + full
  `max_tokens`) is checked against `STUDIO_LLM_DAILY_BUDGET_USD`; actual cost is
  booked from `usage` × $/MTok (failed calls book the worst case).
- **No other spending**: no ads, no purchases, no paid APIs besides Claude.
- **Content policy** in three layers (idea hard filter, Claude review, regex): no
  medical/legal/individual financial advice; no get-rich-quick or income
  guarantees; no testimonials, ratings, user counts; no fake scarcity; no
  trademarks/celebrities in names; no copied content; no adult/gambling/weapons/
  drugs/political targeting; no undeliverable claims; AI-assisted disclosure and
  withdrawal notice are enforced on every landing page.
- **No outreach**: no e-mail, social posting or scraping. Traffic only via SEO
  (sitemap, meta, JSON-LD).
- **Privacy**: no cookies, no third-party scripts. The optional analytics beacon
  talks only to your own collector, which stores aggregates only (see its README).
- **Kill switch / orchestrator pause**: no ideation, build or publish; consuming
  decisions, measuring and killing continue.
- Micro-tools must be one HTML file without any network access (checked by regex).
- Claude: `@anthropic-ai/sdk`, model `claude-opus-5-5`, `client.beta.messages.create`
  with `betas:['server-side-fallback-2026-07-01']`, `fallbacks:'default'`,
  `output_config.effort` `medium` (`low` for policy review), structured outputs via
  `output_config.format = zodOutputFormat(schema)` and zod validation of the text.
  (`messages.parse` is not used because it throws on refusals/invalid JSON before we
  can check `stop_reason === 'refusal'` and book `usage`.) A refusal fails only that
  step.

## Status / limitations

- **Traffic is the bottleneck.** The studio does no marketing by design. New
  domains get little search traffic; SEO takes **weeks to months**. A 21-day
  evaluation window will kill many products that might have sold later.
- **Most products will sell nothing.** The simulator deliberately uses low
  conversion; expect the same in reality. LLM costs (up to the daily cap) can exceed
  revenue.
- **The owner is legally responsible** for everything published: Impressum,
  Datenschutzerklärung (auto-generated template — have it checked), VAT/price
  indication, tax, consumer law. The **withdrawal-right waiver for digital content**
  requires the buyer's express consent at checkout; the studio shows the notice on
  the landing page and in Stripe's checkout text, but you should configure Stripe
  consent collection / terms yourself and verify it meets § 356 Abs. 5 BGB.
- **Download protection is a secret URL** (128-bit token, `noindex`, not in the
  sitemap). Anyone with the link can share it. No license keys, no accounts.
- **Customer support** beyond the FAQ is not automated; refunds and questions reach
  the operator e-mail.
- Regex policy checks have false positives/negatives; the Claude review reduces but
  does not eliminate risk. The owner review is the real safeguard.
- Offline mode uses a tiny hand-written seed catalog (once exhausted, no new ideas
  without Claude) and seed scores; the simulator uses filler content and is only a
  funnel test.
- Stripe test keys produce simulated sales only. Nothing here fabricates sales: sales
  are counted only from Stripe checkout sessions.
- Single studio process per state dir (lock file `studio/.lock`).
- **Analytics numbers are approximate.** Unique visitors are a sum of daily
  estimates (a returning visitor counts once per day; a collector restart mid-day
  can double-count), ad/tracking blockers and DNT/GPC hide visits, and bots that
  look like browsers slip through. Diagnoses on small numbers (a few dozen visits)
  are noisy; thresholds are heuristics, not statistics. `no-traffic` is mostly an SEO
  timing problem on a new domain.
- The re-angle follow-up of an **offline seed** venture can only change price and
  title (same seed content); real re-angles need Claude.
- Stripe's checkout-session list is read in full each cycle per live venture
  (100 per page); very busy links mean more API calls.
