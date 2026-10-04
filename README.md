# money-machine-core

Integrationsschicht des Money-Machine-Systems: gemeinsamer Datenvertrag, Supervisor, Not-Aus und Status-Dashboard für alle Komponenten-Repos.

## Systemüberblick

```text
                     ┌──────────────────────────── money-machine-core ───────────────────────────┐
                     │  Supervisor (Zyklen + Daemons) · Not-Aus (KILL) · Dashboard :8780 · CLI    │
                     └───────────────┬────────────────────────────────────────────────┬──────────┘
                                     │  $MM_STATE_DIR (gemeinsame JSON-Dateien)       │
   Phase 1  solana-trading-agent ──► strategies/solana-trader.json                    │
            liquidation-hunter   ──► strategies/liquidation-hunter.json               │
   Phase 2  revenue-engine       ──► revenue.json  ◄── marketplace.json ◄── agent-marketplace (Daemon, HTTP :8790)
   Phase 3  capital-allocator    ──► allocation-proposal.json
   Phase 4  orchestrator         ──► allocations.json + portfolio.json
                                     │
                                     └──► Strategien lesen ihr Budget aus allocations.json im nächsten Zyklus
```

| Repo | Rolle |
|---|---|
| `solana-trading-agent` | Strategie: Solana-Token-Trading (Paper-Modus standardmäßig) |
| `liquidation-hunter` | Strategie: Liquidationen von Lending-Positionen (derzeit simulierte Datenquelle) |
| `revenue-engine` | Erfasst und aggregiert alle Umsatzströme (Trading, KI-Services, Affiliate, digitale Produkte, SaaS) |
| `agent-marketplace` | Marktplatz, auf dem Agenten Services anbieten/kaufen (Escrow, Reputation, Revenue-Share) |
| `capital-allocator` | Bewertet Strategien und schlägt eine Kapitalverteilung vor |
| `orchestrator` | Governance: Health-Gates, Reserve, Drawdown-Not-Aus, Reinvestition, verbindliche Allokation |
| `money-machine-core` | Dieses Repo |

## Datenvertrag

`contract/mm-contract.ts` ist die einzige Quelle für alle gemeinsamen Typen und Helfer (atomare Schreibvorgänge, Not-Aus-Prüfung, Budget-Abfrage, Event-Log). Jedes Komponenten-Repo hält eine **unveränderte Kopie** unter `src/mm-contract.ts`. Änderungen nur hier vornehmen, dann `npm run sync-contract` ausführen; `npm run doctor` meldet Abweichungen.

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
# alle Repos nebeneinander klonen, installieren, prüfen
git clone https://github.com/KevinKProfina/money-machine-core.git
cd money-machine-core
scripts/bootstrap.sh            # klont die Geschwister-Repos in das übergeordnete Verzeichnis

cp .env.example .env
npm run once                    # ein kompletter Systemzyklus + Statusausgabe
npm start                       # Dauerbetrieb: Zyklen, Marketplace-Daemon, Dashboard auf http://127.0.0.1:8780
```

Jede Komponente hat ihre eigene `.env` (siehe deren `.env.example`). `MM_STATE_DIR` wird vom Supervisor gesetzt und muss dort nicht eingetragen werden.

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
