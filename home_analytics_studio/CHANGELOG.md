# Changelog

## 1.0.9 – 2026-10-27

- Neu: „Historie aufteilen“ (Entitäten → Details) für umgehängte oder ausgetauschte Geräte. Werte vor dem Wechsel wandern in eine eigene Archiv-Reihe (`<entität>::archiv_JJJJMMTT`), die in Widgets und Formeln nutzbar bleibt; die Entität enthält danach nur Werte ab dem Wechsel.

## 1.0.8 – 2026-10-27

- Neu: Thermostate (`climate.*`) liefern zusätzliche aufzeichenbare Werte „Sollwert“ (`climate.x::temperature`) und „Heizanteil“ (`climate.x::heating`, Anteil der Zeit mit `hvac_action = heating` in %). Live, mit Historien-Import und in Formeln nutzbar (z. B. `sensor.buro - climate.buro::temperature`).

## 1.0.7 – 2026-10-27

- Neu: Plausibilitätsgrenze je Zähler („max. Verbrauch pro Stunde“, Entitäten → Details). Unplausible Sprünge – z. B. nach Ausfall des Lesekopfs oder Zählertausch – werden bei allen Auswertungen ignoriert; rückwirkend und umkehrbar, Rohdaten bleiben unverändert.
- Analysen: keine Vergleichsaussagen mehr, wenn der Vergleichszeitraum zu wenig Daten hat (vorher z. B. „+127.976 %“).
- Vergleichskarte warnt bei unvollständiger Datenbasis; KPI-Karte zeigt dann keine Prozentänderung.
- Farblogik korrigiert: Ein Anstieg wird standardmäßig rot dargestellt (Verbrauch/Kosten), mit „Anstieg ist gut“ grün – wie im Editor beschrieben.
- Statistikübersicht für Zähler: Ø pro Tag, niedrigster und höchster Tag statt leerer Mittelwerte.
- Heatmaps: robuste Farbskala, einzelne Ausreißer machen die Darstellung nicht mehr unbrauchbar.

## 1.0.6 – 2026-10-27

- Fix: Heatmap (Stunde × Tag) zeichnete keine Zellen. Die Stunde wurde aus dem deutschen Zeitformat („18 Uhr“) gelesen und ergab keine Zahl.
- Gauge-Skala im deutschen Zahlenformat.
- KPI-Karte „Woche“: Verlauf stündlich statt nur ein Punkt pro Tag.

## 1.0.5 – 2026-10-27

- Fix: Kacheln verschoben sich nach „Fertig“. Der Editor wählte das Layout nach der Fensterbreite, die Ansicht nach der Breite der Arbeitsfläche (ohne Navigation) – auf großen Monitoren wurde so ein anderes Layout bearbeitet als angezeigt. Der Editor bearbeitet jetzt immer das gerade angezeigte Layout.

## 1.0.4 – 2026-10-27

- Linien-, Flächen- und Verlaufsdiagramme zeigen Zähler (kWh, m³ …) standardmäßig als Zählerstand/Sensorwert wie der Home-Assistant-Verlauf; umschaltbar auf „Verbrauch je Intervall“. Neue Statistik „Verlauf wie in HA“.
- Y-Achse endet am höchsten (Linien: beginnt am niedrigsten) Wert, der Höchstwert ist immer beschriftet; abschaltbar.
- Achsenbeschriftung ohne überflüssige Nullen (0,8 statt 0,800).

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
