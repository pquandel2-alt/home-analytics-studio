# Changelog

## 1.0.3 – 2026-10-27

- Beim Aktivieren der Aufzeichnung wird die vorhandene Home-Assistant-Historie jetzt automatisch importiert (Langzeitstatistiken 365 Tage, Rohdaten 10 Tage; einstellbar unter Einstellungen → Datenspeicherung). Vorher zeigten neue Karten nur Daten ab Aufzeichnungsbeginn.
- Datenabdeckung bei importierten Zähler-Statistiken wurde als 0 % berechnet; Analysen hätten diese Zeiträume als unvollständig markiert.
- Anmeldung: Benutzername ohne Beachtung der Groß-/Kleinschreibung.

## 1.0.2 – 2026-10-27

- Build behoben: Neuere Supervisor-Versionen übergeben `ghcr.io/home-assistant/base` als Basis-Image (ohne Python → `pip: not found`). Das Dockerfile verwendet jetzt fest das multi-arch Image `python:3.12-alpine3.20`.

## 1.0.1 – 2026-10-27

- Installation behoben: `config.yaml` verwies auf ein nicht veröffentlichtes Container-Image (ghcr.io). Das Add-on wird jetzt wie vorgesehen lokal gebaut.

## 1.0.0 – 2026-10-27

Erste Veröffentlichung.

- Eigene Langzeitdatenbank (SQLite/WAL) mit Rohwerten, 5-Minuten- und Stundenverdichtung, konfigurierbarer Aufbewahrung
- Korrekte Auswertung von Momentanwerten (zeitgewichtet) und Zählern (resetsicher), Einheiten-Normalisierung, Zeitzonen/Sommerzeit
- Import von HA-Historie und Langzeitstatistiken, automatisches Nachladen von Lücken nach Verbindungsabbrüchen
- Entitätenverwaltung mit Suche, Filtern, Gruppierung, Mehrfachauswahl, Speicherverbrauch
- Formel-Engine mit visuellem Builder und erweitertem Editor, Konstanten, Kennzahlen-Abhängigkeiten
- Analyse-Engine (Vergleiche, Trends, Spitzen, Auffälligkeiten) ohne KI
- Visueller Dashboard-Editor mit 35 Widget-Typen, responsiven Layouts, Ebenen, Undo/Redo, Kopieren/Einfügen
- 7 Design-Presets, vollständig anpassbar
- ChatGPT-Export (Prompt/Bericht/JSON), optionale Ollama-/OpenAI-kompatible Anbieter
- Präsentations-/Kioskmodus mit schreibgeschützten Links
- Ingress + Direktport mit Benutzeranmeldung, Rollen, CSRF-Schutz
- Backups mit Integritätsprüfung, HA-Backup-Integration, automatische Wiederherstellung bei Beschädigung
