# analytics-collector — cookieless, privacy-friendly visitor counts for the studio sites

A tiny `node:http` daemon that receives beacons from the venture-studio pages and
stores **daily aggregates only** (counts per site, path, event and referrer host).
No cookies, no IP addresses, no user agents and no visitor hashes are ever written to
disk. It exists so the studio can tell *why* a product does not sell: nobody came
(`no-traffic`), people came but did not click buy (`no-interest`), or they clicked but
did not finish the checkout (`checkout-friction`).

It does not promise any traffic or revenue; it only counts.

## What it does

- `POST /e` — beacon `{ "site": "shop.example.com", "path": "/my-product/", "event": "pageview" | "buy_click" | "download", "ref"?: "https://…" }`
  - body `text/plain` (what `navigator.sendBeacon` sends) or `application/json`, max 2 KB
    (413 above), unknown fields → 400
  - **CORS**: only exact origins from `ANALYTICS_ALLOWED_ORIGINS` (preflight `OPTIONS /e`
    too); a missing or foreign `Origin` → 403
  - per-IP **rate limit** (`ANALYTICS_RATE_LIMIT_PER_MIN`, fixed 1-minute window, in
    memory) → 429
  - **bot filter** (User-Agent heuristics: crawlers, CLI/HTTP libraries, headless
    browsers, link previewers, missing UA) → event dropped, only `botsFiltered` counted
  - `204 No Content` on success
- `GET /health` — status, uptime, counters (no personal data)
- `GET /stats?site=…&from=yyyy-mm-dd&to=yyyy-mm-dd` — requires
  `Authorization: Bearer $ANALYTICS_READ_TOKEN` (constant-time compare; 401 otherwise,
  503 when no token is configured). Default window: last 30 days, max 800 days.
  Returns `mm.analytics-stats/v1` with the day aggregates (including not yet flushed
  data) and totals.

### Stored data

`$MM_STATE_DIR/analytics/<site>/<yyyy-mm-dd>.json` (UTC days, atomic writes, flushed
every `ANALYTICS_FLUSH_INTERVAL_MS` and on SIGINT/SIGTERM; a restart reloads the day
and keeps counting):

```jsonc
{
  "schema": "mm.analytics-day/v1",
  "site": "shop.example.com",
  "day": "2026-10-05",
  "updatedAt": "2026-10-05T18:00:00.000Z",
  "uniqueVisitors": 41,                       // approximate, see below
  "events": { "pageview": 57, "buy_click": 3, "download": 1 },
  "paths": { "/my-product/": { "pageview": 50, "buy_click": 3, "download": 1, "uniqueVisitors": 38 } },
  "referrers": { "google.com": 20, "duckduckgo.com": 4 },   // host only, pageviews only
  "botsFiltered": 12
}
```

Paths are cut at `?`/`#`, and any long hex/base64-like segment is replaced by `:token`
(defence in depth: the studio beacon already sends the landing path instead of the
secret download URL). Distinct paths/referrers per day are capped
(`ANALYTICS_MAX_PATHS_PER_DAY`, `ANALYTICS_MAX_REFERRERS_PER_DAY`, overflow → `(other)`).
Files older than `ANALYTICS_RETENTION_DAYS` are deleted on start, once per day and by
`--once`.

The running daemon also writes a heartbeat `$MM_STATE_DIR/analytics/collector.json`
(`mm.analytics-collector/v1`, `updatedAt`) on start and every flush. venture-studio
reads the day files only while this heartbeat is fresh (< 36 h), so a stopped
collector is reported as "analytics unavailable" rather than as zero traffic.
`--once` writes no heartbeat.

## Privacy by design

| data | what happens |
|---|---|
| Cookies, localStorage, fingerprinting | none — the page stores nothing on the device |
| IP address | used in memory only, per request: rate limit (map cleared every minute) and the daily visitor hash. Never written, never logged |
| User agent | used in memory only: bot filter and the daily visitor hash. Never written |
| Unique visitors | `sha256(daily_salt, ip, ua, site)`; the salt is 32 random bytes generated in memory and **replaced** (not derived) when the UTC day changes, so hashes of different days cannot be linked and nothing can be recomputed later. The set of today's hashes lives in memory only (capped) and is dropped at day change; only the resulting **counts** are stored |
| Referrer | reduced to the hostname (no path, query or search terms); self-referrals dropped |
| DNT / GPC | the studio beacon sends nothing; if a request still carries `DNT: 1` or `Sec-GPC: 1`, the event is counted but no visitor hash is computed |
| Request logs | the collector logs no requests. Your reverse proxy might — configure it to not log IPs for this host |

Unique-visitor numbers are therefore an **approximation**: a person visiting on
several days counts once per day, a collector restart mid-day starts a new salt
(the same person may be counted twice that day), shared IPs/UAs merge people, and
blockers hide visits.

### Suggested Datenschutz paragraph (German)

venture-studio generates this text automatically when `STUDIO_ANALYTICS_URL` is set.
For other sites, adapt:

> **Reichweitenmessung (cookielos, ohne Dritte).** Beim Aufruf einer Seite, beim Klick
> auf den Kauf-Button und beim Aufruf der Download-Seite sendet ein kleines Skript eine
> Meldung an unseren eigenen Statistik-Dienst unter `stats.example.com`. Sie enthält nur
> die Seite (ohne Parameter), die Art des Ereignisses und – beim Seitenaufruf – die
> Domain der verweisenden Website. Technisch bedingt erhält der Dienst deine IP-Adresse
> und die Browser-Kennung (User-Agent); diese werden ausschließlich im Arbeitsspeicher
> kurzzeitig verarbeitet, um Bots auszufiltern, Missbrauch zu begrenzen und mit einem
> täglich neu erzeugten, nicht gespeicherten Zufallsschlüssel die Zahl verschiedener
> Besucher eines Tages zu schätzen. IP-Adressen, Browser-Kennungen und Prüfwerte werden
> nicht gespeichert. Gespeichert werden nur zusammengefasste Tageszahlen je Seite, die
> nach 400 Tagen gelöscht werden. Es werden keine Cookies gesetzt, keine Profile
> gebildet und keine Daten an Dritte weitergegeben. Bei aktivem „Do Not Track“ oder
> „Global Privacy Control“ findet keine Messung statt. Rechtsgrundlage: Art. 6 Abs. 1
> lit. f DSGVO (berechtigtes Interesse an datensparsamer Reichweitenmessung);
> Widerspruch nach Art. 21 DSGVO jederzeit möglich.

This is a template, not legal advice. Whether a consent requirement under § 25 TDDDG
applies to a cookieless first-party script is debated; have the text and setup checked
for your case.

## How it fits into the system

A **daemon** component (`type: "daemon"`, script `start`). It writes only below
`$MM_STATE_DIR/analytics/` and emits `analytics.started` / `fatal` events. It does not
read allocations or the kill switch: it never spends money or publishes anything.

- **venture-studio** embeds the beacon when `STUDIO_ANALYTICS_URL` points at this
  collector's public URL and reads the day files directly when both share
  `MM_STATE_DIR`, otherwise via `GET /stats` with `ANALYTICS_READ_TOKEN`.
- Publicly expose only `/e` (and optionally `/stats`, token-protected) through your
  reverse proxy with TLS, e.g. `https://stats.example.com → 127.0.0.1:8791`, and set
  `ANALYTICS_TRUST_PROXY=1` there.

## Setup

```bash
npm install
cp .env.example .env
npm start                        # daemon
MM_STATE_DIR=$(mktemp -d) npm run once   # retention/compaction only, exit 0
```

## Env vars

| var | default | meaning |
|---|---|---|
| `MM_STATE_DIR` | `./.mm-state` | shared state dir |
| `PORT` / `HOST` | `8791` / `127.0.0.1` | listen address |
| `ANALYTICS_ALLOWED_ORIGINS` | – | comma-separated exact origins allowed to send beacons; empty → all refused |
| `ANALYTICS_SITES` | – | optional allow-list of site ids |
| `ANALYTICS_READ_TOKEN` | – | bearer token for `/stats` (≥ 16 chars); empty → `/stats` disabled |
| `ANALYTICS_TRUST_PROXY` | `0` | use first `X-Forwarded-For` entry as client IP |
| `ANALYTICS_RETENTION_DAYS` | 400 | delete day files older than this |
| `ANALYTICS_FLUSH_INTERVAL_MS` | 60000 | write interval |
| `ANALYTICS_RATE_LIMIT_PER_MIN` | 60 | events per IP per minute |
| `ANALYTICS_MAX_PATHS_PER_DAY` / `ANALYTICS_MAX_REFERRERS_PER_DAY` | 500 / 200 | caps per site and day |

## Run modes

| command | what |
|---|---|
| `npm start` | HTTP daemon; flushes periodically and on SIGINT/SIGTERM |
| `npm run once` | `--once`: apply retention, remove stale temp/corrupt files, exit 0 (fits a supervisor cycle) |
| `npm run check` / `npm test` | typecheck / offline tests (real HTTP on 127.0.0.1, temp state dir) |

## Safety

- No money, no external calls, no secrets required. Missing token → `/stats` off;
  missing origins → beacons refused (logged at start).
- Hard input limits (2 KB body, field whitelist, path/referrer normalisation, request
  timeouts) and a per-IP rate limit.
- Single writer per state dir: run one collector per `MM_STATE_DIR`.

## Status / limitations

- Counts are approximate (see above) and miss visitors with blockers, DNT/GPC or
  without JavaScript. Bot filtering is heuristic; sophisticated bots look like browsers.
- Data received since the last flush is lost on a hard crash (SIGKILL / power loss);
  SIGINT/SIGTERM flush.
- In-memory state (salt, today's hashes, rate-limit map) is per process; running
  several instances behind a load balancer would overcount uniques and weaken the
  rate limit.
- The beacon cannot prove a human saw the page; the studio uses these numbers only for
  coarse diagnoses, never as revenue.
- No dashboard of its own; numbers appear in the studio summary (`traffic`, per-venture
  `funnel`).
