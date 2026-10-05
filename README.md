# money-machine-core

Das komplette Money-Machine-System in einem Repo: gemeinsamer Datenvertrag, Supervisor, Not-Aus, Dashboard und alle Komponenten unter `components/`.

## Systemüberblick

```text
                 ┌────────────────────────────── money-machine-core ──────────────────────────────┐
                 │  Supervisor (Zyklen + Daemons) · Not-Aus · Dashboard :8780 · Alarme · Backups   │
                 └──────────────┬──────────────────────────────────────────────────────┬─────────┘
                                │  $MM_STATE_DIR (gemeinsame JSON-Dateien)              │
  Phase 1  solana-trading-agent ─► strategies/solana-trader.json   ◄── arena/promotions.json (beförderte Strategie)
           agent-arena          ─► strategies/agent-arena.json + arena/summary.json
           venture-studio       ─► studio/summary.json, Website, Stripe-Links (nach Freigabe)
  Phase 2  revenue-engine       ─► revenue.json  ◄── marketplace.json ◄── agent-marketplace (Daemon :8790)
  Phase 3  capital-allocator    ─► allocation-proposal.json
  Phase 4  orchestrator         ─► allocations.json + portfolio.json ──► Budgets für den nächsten Zyklus
  Daemons  agent-marketplace (:8790), analytics-collector (:8791, cookielose Besucherzählung fürs Studio)
```

| Komponente (`components/…`) | Rolle |
|---|---|
| `solana-trading-agent` | Solana-Token-Trading, Paper-Modus standardmäßig; kann die von der Arena beförderte Strategie übernehmen (`STRATEGY_SOURCE=arena`) |
| `agent-arena` | Evolutionäre Agenten-Arena: viele kleine Agenten mit eigenem Budget, Verlierer sterben, Gewinner vermehren sich mit mutierter Strategie; Backtests auf GeckoTerminal-Historie, Beförderung nur bei positivem Out-of-Sample-Ergebnis |
| `venture-studio` | Findet selbst Einnahmeideen (bevorzugt komplett selbst umsetzbare), baut digitale Produkte + Verkaufsseiten, verkauft über Stripe, misst den Funnel, stellt Flops ein. **Live geht nur, was du im Dashboard freigibst.** |
| `analytics-collector` | Cookielose, datensparsame Besucherzählung für die Studio-Website |
| `revenue-engine` | Erfasst und aggregiert alle Umsatzströme |
| `agent-marketplace` | Marktplatz, auf dem Agenten Services anbieten/kaufen (Escrow, Reputation, Revenue-Share; interne Guthaben) |
| `capital-allocator` | Bewertet Strategien und schlägt eine Kapitalverteilung vor |
| `orchestrator` | Governance: Health-Gates, Reserve, Drawdown-Not-Aus, Reinvestition, verbindliche Allokation |
| `liquidation-hunter` | Liquidationen von Lending-Positionen — **deaktiviert**, bis es eine echte Datenquelle gibt |

Die früheren Einzel-Repos (`solana-trading-agent`, `liquidation-hunter`, `capital-allocator`, `orchestrator`, `revenue-engine`, `agent-marketplace`) sind hier unter `components/` enthalten und werden nicht mehr gebraucht.

## Datenvertrag

`contract/mm-contract.ts` ist die einzige Quelle für alle gemeinsamen Typen und Helfer (atomare Schreibvorgänge, Not-Aus-Prüfung, Budget-Abfrage, Event-Log). Jede Komponente hält eine **unveränderte Kopie** unter `src/mm-contract.ts` (so bleibt jede Komponente einzeln lauffähig; die CI prüft, dass alle Kopien identisch sind). Änderungen nur hier vornehmen, dann `npm run sync-contract` ausführen; `npm run doctor` meldet Abweichungen.

Dateien in `$MM_STATE_DIR`:

| Datei | Schreiber | Leser |
|---|---|---|
| `strategies/<name>.json` | Strategien | Allocator, Orchestrator, Revenue-Engine, Dashboard |
| `allocation-proposal.json` | capital-allocator | Orchestrator |
| `allocations.json` | Orchestrator | Strategien (Budget/Pause) |
| `portfolio.json` | Orchestrator | Dashboard |
| `revenue.json` | revenue-engine | Orchestrator (Reinvestition), Dashboard |
| `marketplace.json` | agent-marketplace | revenue-engine, Dashboard |
| `events.jsonl` | alle | Dashboard |
| `KILL` | CLI/Dashboard | alle |
| `core/supervisor.json` | Supervisor | Dashboard |

## Schnellstart

```bash
git clone https://github.com/KevinKProfina/money-machine-core.git
cd money-machine-core
scripts/bootstrap.sh            # installiert alle Komponenten und prüft sie (npm run doctor)

cp .env.example .env
npm run once                    # ein kompletter Systemzyklus + Statusausgabe
npm start                       # Dauerbetrieb: Zyklen, Daemons, Dashboard auf http://127.0.0.1:8780
```

Jede Komponente kann zusätzlich ihre eigene `.env` haben (siehe deren `.env.example`). `MM_STATE_DIR` setzt der Supervisor; im Docker-Betrieb steht alles in einer Datei `deploy/mm.env`.

## Deployment

**Docker (empfohlen):** im Repo-Verzeichnis:

```bash
cp deploy/mm.env.example deploy/mm.env   # ausfüllen
docker compose -f deploy/docker-compose.yml up -d --build
```

Dashboard und Marketplace-API sind nur auf `127.0.0.1` erreichbar. Der Zustand liegt im Volume `mm-state`.

**Ohne Docker:** `deploy/money-machine.service` (systemd) — Anleitung steht in der Datei.

**Alarme:** Mit `TELEGRAM_BOT_TOKEN` und `TELEGRAM_CHAT_ID` meldet der Supervisor ausfallende/wiederhergestellte Komponenten, Not-Aus an/aus und jede Strategie im Live-Modus — jeweils einmal pro Zustandswechsel, nicht jeden Zyklus.

## Betrieb

- **Sicherungen:** Der Supervisor sichert den Zustand einmal täglich als `tar.gz` nach `MM_BACKUP_DIR` (Standard `backups/`, im Container das Volume `mm-backups`) und behält `MM_BACKUP_KEEP` Stück. Manuell: `npm run backup`. Wiederherstellen: `npx tsx src/cli.ts restore <datei> <leeres-verzeichnis>` und `MM_STATE_DIR` darauf zeigen lassen. Caches (`arena/history`) werden nicht gesichert.
- **Logs:** `logs/<komponente>.log` rotiert ab `MM_LOG_MAX_BYTES` (3 alte Dateien bleiben). `events.jsonl` wird ab `MM_EVENTS_MAX_BYTES` auf die neuere Hälfte gekürzt.
- **Health:** `GET /health` liefert 503, wenn länger kein Zyklus fertig wurde; der Docker-`HEALTHCHECK` nutzt das, externe Uptime-Monitore können es auch.
- **Liquidation Hunter** ist in `system.config.json` deaktiviert (`"enabled": false`), bis er eine echte Datenquelle hat — er lief nur auf simulierten Positionen.

## Venture Studio: Freigaben

Alles bis „bereit zum Start“ läuft automatisch. Fertige Produkte erscheinen im Dashboard unter **Venture Studio** mit Vorschau (Verkaufsseite + Produkt). Admin-Token eintragen, **Freigeben** oder **Ablehnen** klicken; das Studio veröffentlicht im nächsten Zyklus. Einstellen von Flops (keine Verkäufe nach `STUDIO_EVAL_DAYS`) passiert ohne Rückfrage.

Damit wirklich verkauft werden kann, braucht das Studio (siehe `components/venture-studio/.env.example`):
- `STRIPE_API_KEY` (Testschlüssel reicht zum Ausprobieren; Live-Schlüssel nur zusammen mit `MODE=live` + `LIVE_TRADING_CONFIRM`)
- `STUDIO_OPERATOR_NAME`, `STUDIO_OPERATOR_ADDRESS`, `STUDIO_OPERATOR_EMAIL` (Impressum — ohne wird nichts veröffentlicht)
- `STUDIO_SITE_URL` und `STUDIO_DEPLOY_CMD` (z. B. `npx wrangler pages deploy . --project-name=meinshop`)
- `ANTHROPIC_API_KEY` (sonst nur eingebaute Beispielideen)

## CLI

```text
npm run once             ein Systemzyklus, danach Status
npm start                Supervisor + Daemons + Dashboard
npm run status           aktueller Status (oder: npx tsx src/cli.ts status --json)
npm run kill -- Grund    Not-Aus: keine neuen Positionen mehr in irgendeiner Strategie
npm run resume           Not-Aus aufheben
npm run install-all      npm ci in allen Repos
npm run sync-contract    Vertrag in alle Repos kopieren
npm run doctor           Checkouts, Abhängigkeiten und Vertragskopien prüfen
```

Das Dashboard ist lesend öffentlich (nur an `127.0.0.1` gebunden, solange `MM_DASHBOARD_HOST` nicht geändert wird). `POST /api/kill` und `POST /api/resume` erfordern `Authorization: Bearer $MM_ADMIN_TOKEN`; ohne gesetzten Token sind sie deaktiviert.

## Zyklus und Fehlerverhalten

- Komponenten derselben Phase laufen parallel, Phasen nacheinander.
- Jeder Schritt hat ein Zeitlimit (`MM_STEP_TIMEOUT_MS`); bei Überschreitung wird der gesamte Prozessbaum beendet.
- Ein fehlschlagender Schritt blockiert spätere Phasen nicht. Der Orchestrator behandelt fehlende oder veraltete Berichte als ungesund und pausiert die betroffene Strategie; das ist der sichere Standard.
- Daemons werden mit exponentiellem Backoff (bis 60 s) neu gestartet.
- Logs pro Komponente liegen in `logs/<name>.log`.

## Sicherheit

- Alle Strategien starten im **Paper-/Dry-Run-Modus**. Echtgeld-Ausführung erfordert in der jeweiligen Komponente `MODE=live` **und** `LIVE_TRADING_CONFIRM=I_UNDERSTAND_REAL_MONEY_RISK`.
- Der Not-Aus stoppt neue Positionen sofort beim nächsten Zyklus; der Orchestrator setzt alle Budgets auf 0 und löst ihn zusätzlich selbst aus, wenn der Portfolio-Drawdown `MAX_PORTFOLIO_DRAWDOWN` überschreitet.
- Das Dashboard warnt deutlich, sobald eine Strategie im Live-Modus läuft.

## Status / Grenzen

- Keine der Strategien hat eine nachgewiesene positive Erwartung. Vor Echtgeld: lange Paper-Phase, dann kleine Beträge.
- Der Liquidation Hunter hat noch keine echte Datenquelle (siehe dessen README).
- Echte Zahlungsschienen im Marketplace sind nicht angebunden (interne Guthaben).
