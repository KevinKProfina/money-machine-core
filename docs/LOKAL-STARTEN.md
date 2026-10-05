# Money Machine lokal starten

Diese Anleitung bringt das System auf deinem eigenen Rechner zum Laufen, mit Docker. Danach läuft alles im **Paper-Modus**, also ohne echtes Geld:

- **Solana-Trader:** handelt simuliert mit echten Kursen.
- **Arena:** entwickelt Strategien auf echten Marktdaten.
- **Venture Studio:** baut Produkte und legt sie dir zur Freigabe vor. Veröffentlichen kann es erst, wenn eine Domain eingetragen ist.

Dauer: etwa 30–45 Minuten.

> **Sicherheit:** API-Schlüssel und Tokens gehören nur in die Datei `deploy/mm.env` auf deinem Rechner. Schick sie niemandem, auch nicht in einen Chat, und lade die Datei nirgendwo hoch. Git ignoriert sie automatisch.

---

## 1. Voraussetzungen installieren

1. **Docker Desktop:** https://www.docker.com/products/docker-desktop/ herunterladen und installieren.
   - Windows: Der Installer richtet WSL 2 ein. Danach einmal neu starten.
   - Nach der Installation Docker Desktop öffnen und warten, bis unten links „Engine running“ steht.
   - Empfohlen: in den Einstellungen „Start Docker Desktop when you sign in“ einschalten.
2. **Git:** https://git-scm.com/downloads. Auf dem Mac ist es meist schon da.

## 2. Code herunterladen

Ein Terminal öffnen. Unter Windows nimmst du „PowerShell“, auf dem Mac „Terminal“.

```bash
git clone https://github.com/KevinKProfina/money-machine-core.git
cd money-machine-core
```

> Falls der PR [KevinKProfina/money-machine-core#1](https://github.com/KevinKProfina/money-machine-core/pull/1) noch nicht gemergt ist, zusätzlich: `git checkout claude/focused-mendel-7u0xve`

## 3. Telegram-Bot anlegen (für Alarme aufs Handy)

1. **Bot erstellen:**
   1. In Telegram den Kontakt **@BotFather** öffnen und `/newbot` senden.
   2. Einen Namen vergeben, z. B. „Money Machine Alarm“.
   3. Einen Benutzernamen vergeben, der auf `bot` endet, z. B. `meine_mm_alarm_bot`.
   4. BotFather antwortet mit einem **Token**, etwa `123456789:AAH...`. Das ist dein `TELEGRAM_BOT_TOKEN`.
2. **Bot einmal anschreiben:** Öffne deinen neuen Bot und schick ihm irgendeine Nachricht, z. B. „hallo“. Das ist nötig, sonst darf er dir nicht schreiben.
3. **Chat-ID herausfinden:**
   1. Im Browser öffnen, mit deinem Token statt `<TOKEN>`: `https://api.telegram.org/bot<TOKEN>/getUpdates`
   2. In der Antwort steht `"chat":{"id":123456789,...`. Die Zahl ist deine `TELEGRAM_CHAT_ID`.

## 4. Stripe im Testmodus (optional, aber empfohlen)

1. Konto anlegen auf https://dashboard.stripe.com/register. Für den Testmodus brauchst du keine Firmendaten.
2. Oben rechts muss **„Testmodus“** aktiv sein.
3. Unter **Entwickler → API-Schlüssel** den **Geheimschlüssel** kopieren. Er beginnt mit `sk_test_`. Das ist dein `STRIPE_API_KEY`.

> Nimm hier nur den `sk_test_`-Schlüssel. Mit Testschlüsseln fließt kein echtes Geld.

## 5. Konfiguration ausfüllen

```bash
cp deploy/mm.env.example deploy/mm.env
```

Unter Windows/PowerShell geht `cp` ebenfalls, alternativ `copy deploy\mm.env.example deploy\mm.env`.

Öffne `deploy/mm.env` in einem Texteditor und trag ein:

| Zeile | Was hinein muss |
|---|---|
| `MM_ADMIN_TOKEN=` | ein zufälliger Token (siehe unten), damit kannst du im Dashboard freigeben und den Not-Aus bedienen |
| `ADMIN_TOKEN=` | ein **weiterer** zufälliger Token (für den Marketplace) |
| `ANALYTICS_READ_TOKEN=` | ein **weiterer** zufälliger Token |
| `TELEGRAM_BOT_TOKEN=` | aus Schritt 3 |
| `TELEGRAM_CHAT_ID=` | aus Schritt 3 |
| `ANTHROPIC_API_KEY=` | dein Anthropic-API-Key (`sk-ant-…`) |
| `STRIPE_API_KEY=` | aus Schritt 4 (`sk_test_…`), oder leer lassen |
| `STUDIO_OPERATOR_NAME=` | dein Name (fürs Impressum) |
| `STUDIO_OPERATOR_ADDRESS=` | deine Anschrift, z. B. `Musterstr. 1, 12345 Berlin` |
| `STUDIO_OPERATOR_EMAIL=` | deine E-Mail |

Diese Zeilen bleiben vorerst **leer**: `STUDIO_SITE_URL`, `STUDIO_DEPLOY_CMD`, `STUDIO_ANALYTICS_URL`, `ANALYTICS_ALLOWED_ORIGINS`, `GUMROAD_ACCESS_TOKEN`. Sie kommen dazu, sobald die Domain da ist.

**Zufällige Tokens erzeugen** (jeweils einmal pro Token ausführen und das Ergebnis eintragen):

- Windows (PowerShell): `[guid]::NewGuid().ToString('N')`
- Mac/Linux: `openssl rand -hex 24`

**Nicht eintragen** und auch nicht hinzufügen: `MODE=live` oder `LIVE_TRADING_CONFIRM`. Ohne diese beiden Zeilen läuft garantiert alles simuliert.

## 6. Starten

Im Ordner `money-machine-core`:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
```

Der erste Start dauert einige Minuten, weil alles gebaut wird. Danach:

- **Dashboard:** http://127.0.0.1:8780 im Browser öffnen. Der erste Zyklus ist nach ca. 1–2 Minuten fertig, das Dashboard aktualisiert sich alle 10 Sekunden.
- **Telegram testen:**

  ```bash
  docker compose -f deploy/docker-compose.yml exec money-machine node --import tsx src/cli.ts test-alert
  ```

  Auf dem Handy sollte „Testalarm“ ankommen.
- **Status im Terminal:**

  ```bash
  docker compose -f deploy/docker-compose.yml exec money-machine node --import tsx src/cli.ts status
  ```

## 7. Was du im Dashboard siehst und tun kannst

- **Strategien:** Solana-Trader und Arena, jeweils mit Modus `paper`, Budget, Gewinn/Verlust und Drawdown.
- **Agenten-Arena:** Population, Generationen und die besten Agenten.
- **Venture Studio:** Produkte, die auf deine Freigabe warten, mit „Verkaufsseite“- und „Produkt“-Vorschau.
  - Admin-Token (`MM_ADMIN_TOKEN`) oben im Feld eintragen.
  - Ohne Domain bleiben freigegebene Produkte mit dem Hinweis „STUDIO_SITE_URL missing“ blockiert. Das ist gewollt, sie gehen automatisch live, sobald die Domain eingetragen ist.
- **Ereignisse:** alles Wichtige im Zeitverlauf.

## 8. Einmalig: Arena mit historischen Daten vortrainieren (empfohlen)

Damit die Arena nicht bei null anfängt, lass sie einmal auf den Kursen der letzten Tage üben. Das lädt Daten von GeckoTerminal und dauert einige Minuten:

```bash
docker compose -f deploy/docker-compose.yml exec -w /opt/mm/money-machine-core/components/agent-arena money-machine npm run backtest -- --pools 20 --days 7 --timeframe minute --aggregate 5 --evolve
```

Die besten Strategien übernimmt die Arena danach automatisch als Startpopulation, aber nur solche, die auf einem nicht zum Training genutzten Zeitraum Gewinn gezeigt haben.

## 9. Alltag

| Was | Befehl |
|---|---|
| Logs ansehen | `docker compose -f deploy/docker-compose.yml logs -f` |
| Not-Aus (keine neuen Positionen mehr) | im Dashboard oder `docker compose -f deploy/docker-compose.yml exec money-machine node --import tsx src/cli.ts kill Grund` |
| Not-Aus aufheben | `… exec money-machine node --import tsx src/cli.ts resume` |
| Stoppen | `docker compose -f deploy/docker-compose.yml down` (der Zustand bleibt erhalten) |
| Updates einspielen | `git pull` und danach `docker compose -f deploy/docker-compose.yml up -d --build` |

Gut zu wissen:

- Das System arbeitet nur, solange dein Rechner läuft. Im Ruhezustand pausiert es und macht danach einfach weiter. Für Dauerbetrieb ziehen wir später auf einen kleinen Server um.
- Sicherungen des Zustands entstehen täglich automatisch im Docker-Volume `mm-backups`.
- Bekommst du über Telegram „component failing“, schick mir die Ausgabe von `docker compose -f deploy/docker-compose.yml logs --tail 200`. Prüfe vorher, dass darin keine Schlüssel stehen.

## 10. Was als Nächstes kommt

1. **1–2 Wochen beobachten:** Läuft die Datenanbindung? Was macht der Trader im Paper-Modus? Welche Produkte schlägt das Studio vor?
2. **Domain:** Sobald sie feststeht, tragen wir `STUDIO_SITE_URL` und den Deploy-Befehl ein, und die freigegebenen Produkte gehen online. Mit Stripe im Testmodus testen wir einen Kauf selbst.
3. **Echtes Geld** kommt erst, wenn die Zahlen es rechtfertigen: zuerst Stripe live, beim Trading frühestens nach 4–8 Wochen Paper-Betrieb und nur mit kleinen Beträgen.
