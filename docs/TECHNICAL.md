# Technische Dokumentation

## Architektur

```
Home Assistant ──(WebSocket, nur lesend)──► HAClient ──► Recorder ──► Store (SQLite/WAL)
                                               │             │            │  samples / stats_5m / stats_1h
                                               │             │            ▼
Browser ◄──(HTTP/JSON, WebSocket)── FastAPI ◄──┴── LiveHub   DataEngine ─► Formel-Engine
   React/Vite UI                    (Ingress-Port 8099,          │
                                     Direktport 8100)        AnalysisEngine ─► AI-Export / Provider
```

| Schicht | Technik | Ort |
|---|---|---|
| Backend | Python 3.12, FastAPI, Uvicorn, SQLAlchemy Core, aiohttp | `home_analytics_studio/backend/has` |
| Datenbank | SQLite im WAL-Modus, `synchronous=NORMAL`, `auto_vacuum=INCREMENTAL` | `/data/has.db` |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, ECharts 5, react-grid-layout, zustand, lucide | `home_analytics_studio/frontend` |
| Paketierung | Alpine-Python-Image, vorgebaute UI, tini, Healthcheck | `Dockerfile`, `config.yaml`, `build.yaml` |

Bewusste Entscheidungen:

* **SQLAlchemy Core statt ORM** – Zeitreihen werden in großen Mengen geschrieben/gelesen; Core mit `executemany` ist schneller
  und speichersparender auf schwacher Hardware.
* **Eigene Komponentenbibliothek** (`components/ui`) auf Tailwind-Basis statt einer großen UI-Library – kleineres Bundle,
  volle Kontrolle über das Theming per CSS-Variablen.
* **HashRouter + relative Asset-Pfade** – die UI funktioniert unverändert unter Ingress (`/api/hassio_ingress/<token>/`),
  über den Direktport und hinter Reverse Proxies mit beliebigem Pfadpräfix.
* **Zwei Listener in einem Prozess** – Port 8099 (Ingress) vertraut nur Anfragen vom Supervisor-Gateway `172.30.32.2`
  (HA-Benutzer aus `X-Remote-User-*`), Port 8100 verlangt immer eine Anmeldung.
* **Vorgebaute UI im Repository** (`frontend/dist`) – Installation auf Raspberry Pi & Co. ohne Node-Build.
* **Kennzahlen werden nicht materialisiert**, sondern bei jeder Abfrage aus den verdichteten Messwerten berechnet:
  Formeländerungen wirken rückwirkend, es gibt keine inkonsistenten Zwischenstände.

## Datenmodell

| Tabelle | Inhalt |
|---|---|
| `entities` | Aufzeichnungsstatus, Wertetyp, Einheit (kanonisch), Aufbewahrung, Verdichtungs-Wasserstände `rolled_5m`/`rolled_1h`, `raw_from` |
| `samples` | Rohwerte `(entity_ref, ts_ms) → value` (`NULL` = unavailable), Primärschlüssel verhindert Duplikate, `WITHOUT ROWID` |
| `stats_5m`, `stats_1h` | je Bucket: mean (zeitgewichtet), min, max, first, last, delta (Verbrauch), count, covered (Sekunden mit Daten); `stats_1h.source` = local/ha |
| `metrics`, `constants` | Kennzahlen (Formel, Einheit, Aggregation, Builder-Zustand), Konstanten |
| `dashboards`, `pages` | Dashboard-Metadaten/Theme/Raster; Seiten mit Widgets, Layouts je Breakpoint, Versionszähler |
| `users`, `sessions`, `share_links` | Benutzer (bcrypt), Sitzungen (SHA-256 des Tokens + CSRF-Token), Präsentationslinks |
| `settings`, `jobs`, `audit_log`, `meta` | Einstellungen (JSON je Bereich), Hintergrundjobs, Änderungsprotokoll, Schemaversion |

Migrationen: `db.MIGRATIONS` (aktuell Version 3), werden beim Start transaktional ausgeführt.

## Zeitreihen-Semantik (`core/stats.py`)

* **Momentanwerte**: Treppenfunktion – ein Wert gilt bis zum nächsten. Mittelwert = Integral / abgedeckte Zeit.
  `NULL`-Marker beenden die Gültigkeit (Lücke).
* **Zähler**: Verbrauch = Summe positiver Differenzen. Rückgang > 10 % → Reset (neuer Wert zählt als Verbrauch seit Reset),
  kleinere Rückgänge → Rauschen (Basis wird nicht gesenkt, keine Doppelzählung). Über Lücken hinweg bleibt die Basis erhalten.
* **Summe (±)**: einfache Differenz.
* **Verdichtung**: 5-Minuten-Buckets aus Rohwerten (2 min nach Bucket-Ende), Stunden aus 5-Minuten-Buckets; späte Daten
  (Import) setzen den Wasserstand zurück und lösen Neuberechnung aus.
* **Abfragen** (`Store.query_edges`): beliebige Bucket-Grenzen; Quelle automatisch: Rohdaten (kurze Zeiträume, wenn
  vorhanden), sonst 5-Minuten- oder Stundenwerte plus Live-Ende aus Rohdaten. Kalender-Buckets werden in der lokalen
  Zeitzone erzeugt (`core/timeutil.py`), DST-Tage haben 23/25 h.
* **Einheiten** (`core/units.py`): Werte werden beim Speichern in eine kanonische Einheit der Dimension umgerechnet.

## Formel-Engine (`core/formula.py`)

Tokenizer → rekursiver Abstiegsparser → AST → Analyse (Funktionssignaturen, Zeitraum-Argumente, Abhängigkeiten,
Lookback) → Interpreter über Bucket-Vektoren. Keine Nutzung von `eval`/`exec`; nur die definierten Operationen sind
möglich. Fehler enthalten eine deutschsprachige Meldung und die Zeichenposition. Gleitende Funktionen erweitern den
Abfragezeitraum automatisch rückwärts. Eine einfache Dimensionsanalyse leitet die Ergebniseinheit ab
(`kWh × €/kWh = €`) und warnt bei inkompatiblen Additionen.

## Home-Assistant-Anbindung (`ha/`)

* Verbindung: im Add-on über `ws://supervisor/core/websocket` mit `SUPERVISOR_TOKEN` (`homeassistant_api: true`),
  alternativ manuell (URL + Langzeit-Token) oder per Umgebungsvariablen.
* Allow-List lesender Befehle (`READ_ONLY_COMMANDS`); alles andere (z. B. `call_service`) wird lokal mit
  `PermissionError` abgewiesen. Nur Zustands- und Registry-Events werden abonniert.
* Wiederverbindung mit Backoff (1 s … 60 s); nach (Wieder-)Verbindung: Metadaten-Abgleich, aktuelle Zustände,
  **Lücken-Nachladen** aus der HA-Historie (bis 10 Tage) als Hintergrundjob.
* Importer: `history/history_during_period` (tageweise) und `recorder/statistics_during_period` (stündlich, inkl.
  Einheitenumrechnung über `recorder/get_statistics_metadata`; lokale Stunden werden nie überschrieben).

## Sicherheit

* Ingress-Vertrauen nur für Port 8099 **und** Gateway-IP; alle anderen Anfragen benötigen Sitzung oder Präsentationstoken.
* Sitzungs-Cookie `HttpOnly`, `SameSite=Lax`, optional `Secure`; Tokens nur gehasht gespeichert.
* CSRF: jede schreibende Anfrage braucht `X-Requested-With: has` (erzwingt CORS-Preflight) und bei Login-Sitzungen
  zusätzlich das sitzungsgebundene `X-CSRF-Token`. WebSocket prüft Origin.
* Erst-Einrichtung über den Direktport nur mit Einrichtungscode aus dem Protokoll.
* Login-Ratenbegrenzung, bcrypt, Schutz des letzten Administrators, Geheimnisse werden in API/Exports maskiert.
* Präsentationslinks: Rolle „viewer“, nur ein Dashboard, nur lesende Datenabfragen, widerrufbar, optional befristet.
* Uploads: nur Bilder, SVG ohne Skripte, zufällige Dateinamen, `Content-Security-Policy: script-src 'none'`.

## Backups (`core/backup.py`, `cli.py`)

ZIP mit `manifest.json` (Version, Schema, SHA-256 je Datei), `config.json` und optional `has.db` (konsistente
Kopie per SQLite-Backup-API). Prüfung: ZIP-CRC, Prüfsummen, `PRAGMA integrity_check`, Schemakompatibilität.
HA-Backups: `backup_pre` erzeugt `ha_backup_snapshot.db`, die Live-Datenbank ist per `backup_exclude` ausgenommen;
beim Start nach einer Wiederherstellung wird der Snapshot übernommen. Beim Start wird eine beschädigte Datenbank
automatisch beiseitegelegt und aus der neuesten gültigen Sicherung ersetzt.

## Erweiterbarkeit

* **Neues Widget**: Renderer-Komponente + Eintrag in `frontend/src/widgets/registry.tsx` (Felder-Schema für den Editor,
  `requests(cfg)` für Datenabfragen). Der Editor wird automatisch aus dem Schema erzeugt.
* **Neue Formelfunktion**: Eintrag in `FUNCTIONS` + Implementierung in `Evaluator._call`.
* **Neuer KI-Anbieter**: Klasse von `BaseProvider` ableiten, in `PROVIDERS` registrieren, Einstellungen ergänzen.

## API

OpenAPI-Schema unter `/api/openapi.json`. Wichtige Endpunkte: `/api/data/{series,scalar,batch}`,
`/api/entities`, `/api/metrics`, `/api/analysis/*`, `/api/dashboards`, `/api/pages/{id}`, `/api/backups`,
`/api/ai/export`, `/api/ws` (Live-Zustände, HA-Status, Jobfortschritt).
