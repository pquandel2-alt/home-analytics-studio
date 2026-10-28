# Entwicklungsstatus – Home Analytics Studio

**Version:** 1.0.0 · **Stand:** 2026-10-27 · **Status:** alle 20 Phasen umgesetzt; offen sind nur Tests auf echter
HA-Hardware (siehe unten).

## Fertige Funktionen

| Phase | Inhalt | Status |
|---|---|---|
| 1–2 | Architektur, Repo-/Add-on-Struktur (`repository.yaml`, `config.yaml`, `build.yaml`, `Dockerfile`, `run.sh`) | ✅ |
| 3 | FastAPI-Backend, Router, Fehlerbehandlung, Security-Header, OpenAPI | ✅ |
| 4 | HA-WebSocket-Client (nur lesend, Allow-List), Reconnect, Registry, Live-Events, Historie/Statistik-Import | ✅ |
| 5 | SQLite/WAL-Langzeitspeicher, Verdichtung 5 min/1 h, Aufbewahrung, Speicherüberwachung, Wartung, Migrationen | ✅ |
| 6 | Entitätenverwaltung (Suche, Filter, Gruppierung, Mehrfachauswahl, Speicher, letzter Datenpunkt, Import) | ✅ |
| 7 | Formel-Engine, Konstanten, Kennzahlen, visueller + erweiterter Editor, Validierung, Vorschau | ✅ |
| 8 | Analyse-Engine (Vergleiche, Trends, Peaks, Anomalien, Profile, freie Vergleiche) | ✅ |
| 9 | Frontend-Grundgerüst, Designsystem, Komponenten, Navigation, Login/Setup | ✅ |
| 10 | Dashboard-Editor (DnD, Resize, Ebenen, Ausrichtung, Undo/Redo, Copy/Paste, Autosave, Breakpoints, Seiten) | ✅ |
| 11 | 38 Widget-Typen mit schemagesteuertem Editor (inkl. animierter Szenen, 1.5.0) | ✅ |
| 12 | 7 Design-Presets, Theme-Editor (global/Dashboard/Seite/Widget), Hintergrundbilder | ✅ |
| 13 | ChatGPT-Export (Prompt/MD/JSON), Provider-Architektur (Ollama, OpenAI-kompatibel) | ✅ |
| 14 | Präsentations-/Kioskmodus, Auto-Seitenwechsel, Fit-to-Screen, Wake-Lock, Share-Links | ✅ |
| 15 | Ingress + Direktport, Benutzer/Rollen, Sitzungen, CSRF, Ratenbegrenzung, Reverse-Proxy-Optionen | ✅ |
| 16 | Backups (Prüfsummen, Restore voll/Konfig), HA-Backup-Hooks, Auto-Recovery, CSV/JSON-Export | ✅ |
| 17 | Integration aller Komponenten (Browser-E2E gegen HA-Simulator) | ✅ |
| 18 | Tests: 93 Backend, 19 Frontend, E2E-Smoke | ✅ |
| 19 | Docker-Build amd64 + Container-Smoke, CI für amd64/aarch64 | ✅ (aarch64 nur in CI, lokal ungetestet) |
| 20 | README, DOCS (Benutzerhandbuch), TECHNICAL, TESTING, CHANGELOG, Übersetzungen, Icons | ✅ |

## Architekturentscheidungen

Siehe [docs/TECHNICAL.md](docs/TECHNICAL.md). Kurz: SQLAlchemy Core, Treppenfunktions-Semantik für Momentanwerte,
resetsichere Zählerauswertung, kanonische Einheiten, Kennzahlen on-the-fly (rückwirkend), zwei Listener
(Ingress vertraut nur Gateway-IP), vorgebaute UI im Repo, HashRouter + relative Pfade.

## Bekannte Einschränkungen / Fehler

* Oberfläche nur auf Deutsch.
* Minutenauflösung nur im Rohdaten-Zeitraum (Standard 90 Tage); danach 5-Minuten- bzw. Stundenwerte.
* Zeitzonen mit 30-Minuten-Versatz: Tagesgrenzen werden für Zeiträume außerhalb der Rohdaten auf Stunden gerundet.
* Nicht aufgezeichnete Entitäten: Verläufe aus HA-Historie max. 10 Tage.
* Präsentationslinks erlauben lesende Datenabfragen für beliebige Entitäten (nicht nur die des Dashboards).
* „Bedingte Berechnung“ im visuellen Builder unterstützt eine Bedingung; komplexere Logik im Texteditor.
* Kennzahlen sind nicht materialisiert – sehr komplexe Formeln über Jahre können auf schwacher Hardware einige Sekunden dauern.
* Frontend-Bundle: ECharts-Chunk ~660 kB (218 kB gzip).

## Letzter erfolgreicher Test

2026-10-27: `scripts/release-check.sh` (93 Backend-Tests, Typprüfung, 19 Frontend-Tests, Vite-Build, Docker-Build amd64,
Container-Healthcheck) und `tests/e2e/ui_smoke.py` (14 Schritte, keine Konsolenfehler).

## Nächste Schritte

1. CI aktivieren: `docs/ci/ci.yaml` nach `.github/workflows/` kopieren (benötigt Token mit `workflow`-Scope), baut auch aarch64.
2. Installation auf echtem Home Assistant (HA-Host 192.168.178.101) und Abarbeitung der Liste in
   [docs/TESTING.md](docs/TESTING.md#nicht-getestet--noch-durchzuführende-integrationstests).
3. Optional: vorgebaute Images in GHCR veröffentlichen und `image:` in `config.yaml` setzen.

## Entwicklungsumgebung (Hinweise für Fortsetzung)

* Python-venv und `node_modules` lagen wegen knappem Plattenplatz in `/dev/shm/has` (flüchtig!). Neu anlegen:
  `python3 -m venv .venv && .venv/bin/pip install -r home_analytics_studio/backend/requirements.txt -r requirements-dev.txt`,
  `cd home_analytics_studio/frontend && npm ci`.
* Nach Frontend-Änderungen `npx vite build` ausführen und `frontend/dist` mit committen (wird vom Dockerfile verwendet).
