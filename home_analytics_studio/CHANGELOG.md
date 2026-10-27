# Changelog

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
