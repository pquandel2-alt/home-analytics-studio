# Changelog

## 1.5.0 – 2026-10-28

- **Neu: Animierte Szenen.** Drei neue Widgets:
  - **Haus mit Solaranlage:** Sonne, PV-Module, Strommast, Batterie (Ladestand), Wallbox/E-Auto. Energieflüsse laufen als Punkte entlang der Leitungen – Tempo und Dicke folgen der Leistung, die Richtung dem Vorzeichen (Bezug/Einspeisung, Laden/Entladen). Hausverbrauch und Autarkie werden berechnet, wenn kein eigener Sensor da ist.
  - **Wärmepumpe:** Außeneinheit mit Lüfter (dreht schneller bei höherer Stromaufnahme), Vor-/Rücklauf, Puffer, Heizkörper mit Wärmewellen, Warmwasserspeicher, Temperaturen, Betriebsart, COP aktuell und Arbeitszahl im Zeitraum.
  - **Eigene Szene (HTML/SVG/CSS):** Werte per `{{name}}`, CSS-Variablen (`var(--name)`, `--name-dur`, `--name-play`), Klassen (`name-an`, `name-neg`), `data-show-if`. Berechnete Werte (z. B. `heat / power`) mit einem sicheren Formel-Rechner.
- **Freie Werte:** beliebige Sensoren/Kennzahlen an beliebiger Stelle einer Szene, per Drag & Drop in der Editor-Vorschau platziert.
- Nicht zugeordnete Teile einer Vorlage werden automatisch ausgeblendet; „Als eigenen Code bearbeiten“ erzeugt eine anpassbare Kopie.
- **Sicherheit:** Szenen laufen in einem abgeschotteten Sandbox-Rahmen (eigener Ursprung, keine Netzwerkzugriffe, kein Zugriff auf Anmeldung, Home Assistant oder die Add-on-API). Eigenes JavaScript ist standardmäßig blockiert und nur optional zuschaltbar.

## 1.4.0 – 2026-10-28

- **Echte Live-Aktualisierung aller Kacheln:** Diagramme, Tages-/Monatswerte, Kosten und Kennzahlen rechnen sofort neu, sobald sich einer der beteiligten Sensoren in Home Assistant ändert (bei Kennzahlen alle Sensoren der Formel). Vorher nur im Intervall (60 s). Entprellt, max. alle 5 s je Kachel; abschaltbar je Widget.
- **Fix Ø-Werte:** Kennzahlen mit Aggregation Mittelwert/Min/Max über mehrere Tage verwenden nur vollständige Tage (bzw. Stunden). Vorher zogen der angebrochene heutige Tag und ein angeschnittener erster Tag den Durchschnitt nach unten (z. B. Ø Tagesverbrauch 17,5 statt 17,8 kWh).

## 1.3.0 – 2026-10-28

- **Teilen-Fenster:** Ein „Teilen“-Symbol im Dashboard zeigt alle Geräte; ein Tipp auf ein Gerät zeigt das Dashboard dort an. Geeignete, noch nicht verknüpfte Fernseher aus Home Assistant lassen sich direkt hinzufügen. Präsentationslink als Unterpunkt.
- **Fernseher ohne Adress-Start** (z. B. Samsung-Standardintegration): automatischer Rückfall auf den Start der Browser-App (`org.tizen.browser` bzw. `3201907018807`); die funktionierende Startart wird gemerkt. Erlaubt bleibt ausschließlich der Start der Browser-App, keine anderen Apps.
- Gekoppelte Browser lassen sich einem verknüpften Fernseher zuordnen (kein doppelter Eintrag mehr); vorhandene Bildschirme können nachträglich mit einem Fernseher verknüpft werden.
- Fernseher-Auswahl zeigt nur Entitäten, die laut Home Assistant Medien/Apps starten können.

## 1.2.0 – 2026-10-28

- Neu (optional, standardmäßig aus): **Fernseher automatisch einschalten und Dashboard öffnen.** Verknüpfte Fernseher (z. B. Samsung mit „Samsung Smart TV Enhanced“) werden beim Senden über Home Assistant eingeschaltet und öffnen das Dashboard im Browser – ohne Eingabe oder Kopplung am Fernseher. Einzige erlaubte Steueraktionen: `media_player.turn_on` und `media_player.play_media` (Typ „browser“) für ausdrücklich verknüpfte Fernseher.
- Erfolgs-/Fehlermeldung des Fernseherstarts erscheint überall in der App.

## 1.1.0 – 2026-10-28

- Neu: **Auf Bildschirm anzeigen** – Dashboards vom Handy aus auf Fernsehern, Wandtablets oder PCs im Netzwerk anzeigen. Bildschirm öffnet einmalig `http://<HA-IP>:8100/tv`, wird per 4-stelligem Code gekoppelt und empfängt Dashboards live (WebSocket). Dauerhaft gekoppelt, automatische Wiederverbindung, nur Lesezugriff. Verwaltung unter Einstellungen → Bildschirme (TV).
- Oberfläche für ältere TV-Browser kompatibel übersetzt (Samsung Tizen, LG webOS, Fire TV).
- Sicherheit: Präsentations- und Bildschirm-Token haben stets Vorrang vor der Ingress-Anmeldung.

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
