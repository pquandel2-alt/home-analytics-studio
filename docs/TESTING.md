# Tests und Ergebnisse

Stand: 2026-10-27, Version 1.0.0. Alle Ergebnisse unten wurden tatsächlich ausgeführt (Entwicklungsrechner
x86_64, Ubuntu 24.04, Python 3.12, Node 18, Docker mit BuildKit).

## Ergebnisse

| Bereich | Werkzeug | Ergebnis |
|---|---|---|
| Backend-Unit/DB/API/Integration | pytest (107 Tests) | **107 bestanden** |
| Frontend (Editor-Store, Widgets, Formel-Builder, Formatierung, Markdown-Sicherheit, Szenen-Rechner/Sandbox) | vitest (35 Tests) | **35 bestanden** |
| TypeScript-Typprüfung | `tsc -b` | fehlerfrei |
| Produktions-Build Frontend | `vite build` | erfolgreich |
| Browser-End-to-End (Chromium/Playwright, gegen HA-Simulator) | `tests/e2e/ui_smoke.py` | **alle 14 Schritte erfolgreich, keine Konsolenfehler** |
| Animierte Szenen (Live-Werte, Animation, Sandbox blockiert Skripte/Speicher, Drag & Drop freier Werte) | `tests/e2e/scene_widget.py` | **22 Prüfungen erfolgreich** (nur aktuelles Chromium; ältere TV-Browser nicht automatisiert getestet) |
| Add-on-Image `amd64` | `docker build` (Alpine, nur Binär-Wheels) | erfolgreich, 155 MB |
| Container-Start, Healthcheck, `/data`-Persistenz über Neustart, Direktport verlangt Anmeldung | manuell/Skript | erfolgreich |
| Abhängigkeiten `aarch64` (musllinux-Wheels vorhanden) | `pip download --platform musllinux_*_aarch64` | alle verfügbar |
| Release-Check (Tests + Build + Image + Start) | `scripts/release-check.sh` | erfolgreich |

## Abgedeckte Szenarien (Auswahl)

* **Zählerresets** (auf 0, auf Wert > 0), Messrauschen ohne Doppelzählung, Verbrauch über Datenlücken
* **Fehlende Messwerte / unavailable** als Lücke, Abdeckung (coverage), unvollständige Tage in Analysen
* **Zeitzonen und Sommerzeit**: 23-/25-Stunden-Tage (Europe/Berlin), Stunden-Buckets bei Zeitumstellung, Zeitzone mit
  30-Minuten-Versatz, Wochenbeginn Montag, DST-Tag wird nicht als Anomalie gemeldet
* **Duplikate** (gleicher Zeitstempel, erneuter Import), **Einheitenwechsel** Wh → kWh
* **Verdichtung** vs. Rohdaten identisch; Aufbewahrung behält Stundenwerte; Kennzahl-Abfragen nach Bereinigung
* **Datenbankmigrationen** v1 → v3, idempotent, neueres Schema wird verweigert; WAL aktiv
* **Verbindungsabbrüche**: Abbruch, automatische Wiederverbindung, Lücke wird aus HA-Historie nachgeladen;
  falsches Token → Status `auth_failed`
* **Nur lesend**: `call_service` und nicht erlaubte Event-Abos werden abgewiesen; alle an HA gesendeten Befehle
  stammen aus der Allow-List
* **Formeln**: Operatorrangfolge, Division durch 0, gleitende Funktionen, Lags, Bedingungen, Kennzahl-Abhängigkeiten,
  **Zirkelbezüge**, **ungültige Formeln** mit verständlichen Meldungen, keine Codeausführung möglich, Einheitenableitung
* **Dashboard-Speicherung**: CRUD, Seiten, Reihenfolge, Versionskonflikt (409), Duplizieren, Export/Import
* **Editor**: Hinzufügen, Undo/Redo, Duplizieren, Copy/Paste über Seiten, Sperren, Ebenen, Ausrichten/Verteilen,
  Drag-Checkpoint, responsive Layout-Ergänzung; im Browser: Drag & Drop wird gespeichert
* **Backup-Wiederherstellung**: komplett / nur Konfiguration, manipulierte Sicherung (Prüfsumme), kaputtes ZIP,
  Pfad-Traversal, automatische Sicherungsrotation, Wiederherstellung einer beschädigten Datenbank beim Start,
  HA-Backup-Hooks + Snapshot-Übernahme, **Persistenz über Neustart**
* **Sicherheit**: Einrichtungscode, Login, Ratenbegrenzung, CSRF, Rollen, Ingress nur von vertrauter IP,
  Präsentationslink nur lesend und auf ein Dashboard beschränkt, Widerruf, Geheimnisse maskiert, Upload-Filter
* **KI**: Export-Paket mit echten Werten, Ollama- und OpenAI-kompatibler Anbieter gegen lokale Testserver

## Nicht getestet / noch durchzuführende Integrationstests

Diese Punkte konnten in der Entwicklungsumgebung **nicht** ausgeführt werden und sind ausdrücklich ungetestet:

1. **Installation auf einem echten Home Assistant** (Supervisor-Build über das Add-on-Repository, Ingress-Proxy,
   Seitenleiste, `SUPERVISOR_TOKEN`-Verbindung zu `ws://supervisor/core/websocket`). Getestet wurde stattdessen gegen
   einen Simulator der HA-WebSocket-API. Prüfen: Add-on installieren, starten, Seitenleiste öffnen, Entität aufzeichnen.
2. **Echte HA-Antwortformate** von `history/history_during_period` und `recorder/statistics_during_period` der
   installierten HA-Version (der Simulator bildet das dokumentierte komprimierte Format nach).
3. **HA-Backup/-Restore** mit den `backup_pre`/`backup_post`-Hooks im Supervisor (lokal wurden Hooks und Snapshot-Übernahme
   getestet, nicht der Supervisor-Ablauf).
4. **aarch64-Image-Build und -Lauf** (keine ARM-Emulation vorhanden; alle Abhängigkeiten sind als aarch64-Wheels verfügbar,
   die vorbereitete CI-Pipeline `docs/ci/ci.yaml` (nach `.github/workflows/` kopieren) baut beide Architekturen).
5. **Direktzugriff über die HA-Host-IP** (`http://<HA-IP>:8100`) inkl. Portmapping des Supervisors.
6. **Langzeitverhalten** (Monate Laufzeit, große Datenmengen auf SD-Karte), Darstellung auf echten Tablets/Fernsehern.
7. Optionale KI-Anbieter gegen eine echte Ollama-Instanz bzw. echte OpenAI-kompatible API.

## Ausführen

```bash
cd home_analytics_studio/backend && python -m pytest -q
cd home_analytics_studio/frontend && npx vitest run
VENV=.venv scripts/dev-run.sh & python home_analytics_studio/backend/tests/e2e/ui_smoke.py http://localhost:18099 /tmp/shots
scripts/release-check.sh
```
