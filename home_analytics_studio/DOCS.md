# Home Analytics Studio – Benutzerhandbuch

Home Analytics Studio ist ein eigenständiges Analyse- und Visualisierungssystem. Home Assistant dient
ausschließlich als **Datenquelle**: Das Add-on liest Zustände, Historie und Statistiken (einzige, optionale Ausnahme: Fernseher für die Dashboard-Anzeige einschalten, siehe unten), speichert die
ausgewählten Messwerte in einer **eigenen Langzeitdatenbank** und stellt sie in frei gestaltbaren
Dashboards dar. **Es steuert keine Geräte** – die Verbindung zu Home Assistant ist technisch auf lesende
Befehle beschränkt.

## Erste Schritte

1. Add-on starten und über **„Analytics Studio“** in der Seitenleiste öffnen (Ingress, automatisch angemeldet).
2. **Entitäten** öffnen, gewünschte Sensoren suchen und den Schalter **Aufzeichnung** aktivieren
   (Mehrfachauswahl per Checkbox möglich).
3. Optional: Ausgewählte Entitäten markieren → **Historie importieren**.
   * *Langzeitstatistiken*: stündliche Werte aus dem HA-Recorder, meist über Jahre verfügbar.
   * *Rohdaten-Historie*: exakte Einzelwerte, nur so weit, wie der HA-Recorder sie aufbewahrt (Standard 10 Tage).
4. **Kennzahlen** anlegen, z. B. Konstante `strompreis = 0,32 €/kWh` und Kennzahl
   `Stromkosten = sensor.stromzaehler * strompreis`.
5. **Dashboards → Neues Dashboard** → **Bearbeiten** → Widgets aus der Palette anklicken oder per Drag & Drop
   auf die Fläche ziehen, rechts konfigurieren.

## Direkter Zugriff im Netzwerk (ohne HA-Seitenleiste)

Standardmäßig ist zusätzlich Port **8100** freigegeben: `http://<IP-von-Home-Assistant>:8100`
(z. B. `http://192.168.178.101:8100`). Der Port lässt sich im Add-on unter **Netzwerk** ändern oder durch
Leeren des Feldes deaktivieren.

Beim direkten Zugriff ist eine **Anmeldung** nötig:

* Am einfachsten: In der Seitenleiste unter **Einstellungen → Benutzer und Sicherheit** einen Benutzer anlegen.
* Alternativ beim ersten Aufruf über den Direktport einen Administrator anlegen; dafür wird der
  **Einrichtungscode** aus dem Add-on-Protokoll benötigt (Schutz vor unbefugter Ersteinrichtung).

Rollen: **Betrachter** (nur lesen), **Bearbeiter** (Dashboards, Kennzahlen, Entitätenauswahl),
**Administrator** (zusätzlich Einstellungen, Benutzer, Backups).

Den Direktport **nicht ungeschützt ins Internet** freigeben. Für Fernzugriff einen Reverse Proxy mit TLS
verwenden und in der Add-on-Konfiguration `base_url`, `secure_cookies` und `trust_proxy_headers` setzen.
Eine eigene lokale Domain kann per DNS (z. B. im Router oder Pi-hole) auf die HA-IP zeigen.

## Entitäten und Wertetypen

| Wertetyp | Beispiele | Auswertung |
|---|---|---|
| Momentanwert | Leistung (W), Temperatur, Luftfeuchte, CO₂ | zeitgewichteter Mittelwert, Min/Max |
| Zähler (steigend) | Energiezähler kWh, Wasser m³, Gas m³ | **Verbrauch je Zeitabschnitt** (Differenz, resetsicher) |
| Summe (±) | Netto-Zähler, Kontostände | Differenz, darf negativ sein |

Der Typ wird automatisch aus `state_class`/`device_class` erkannt und kann je Entität überschrieben werden.
Zählerresets (z. B. Neustart eines Messgeräts) werden erkannt, kleine Rückwärtssprünge (Messrauschen)
ignoriert, `unavailable`/`unknown` als Datenlücke gespeichert. Einheiten werden normalisiert
(z. B. Wh → kWh, kW → W, L → m³), sodass ein Wechsel der Einheit die Zeitreihe nicht unterbricht.

Nicht aufgezeichnete Entitäten können trotzdem **live** in Widgets verwendet werden; Verläufe stammen dann aus
der Home-Assistant-Historie (max. 10 Tage).

## Datenspeicherung

* Rohwerte (Standard 90 Tage), 5-Minuten-Verdichtung (Standard 2 Jahre), Stundenwerte (unbegrenzt).
  Tages-, Wochen-, Monats- und Jahreswerte werden aus Stundenwerten in Ihrer Zeitzone berechnet
  (Sommerzeit-Tage haben korrekt 23 bzw. 25 Stunden).
* Schreibpuffer (Standard 5 s) schont SD-Karten; unveränderte Werte werden nicht doppelt gespeichert.
* Speicherplatzüberwachung: Unterschreitet der freie Speicher die Grenze, pausiert die Aufzeichnung automatisch.
* Datenbankwartung läuft stündlich (Aufbewahrung, Speicherfreigabe) und täglich (Integritätsprüfung).

## Formel-Editor

Zwei Editoren: **Visueller Formel-Builder** (Bausteine: Wert → Rechenschritte → Umwandlung, optional
Bedingung) und **Erweiterter Formel-Editor** (Text mit Live-Validierung, Fehlerposition und Einheitenprüfung).

| Ausdruck | Bedeutung |
|---|---|
| `sensor.x` | Verbrauch (Zähler) bzw. Mittelwert (Momentanwert) je Zeitabschnitt |
| `strompreis` | Konstante oder andere Kennzahl |
| `+ - * / ^ %`, `< <= > >= == !=`, `and or not` | Rechen-/Vergleichsoperatoren |
| `SUM/AVG/MIN/MAX(x, 7d)` | gleitend über Zeitraum; mit Entität ohne Zeitraum: Abschnittsstatistik |
| `COUNT`, `FIRST`, `LAST`, `DELTA`, `COVERAGE` | Messwertanzahl, erster/letzter Wert, Differenz, Abdeckung |
| `DIFFERENCE(x[, 7d])`, `CHANGE_PCT(x[, 7d])`, `PREV(x)` | Vergleich mit Vorabschnitt / vor Zeitraum |
| `PERCENT(a, b)`, `MOVING_AVG(x, 7d)`, `CUMSUM(x)`, `INTEGRAL(x)` | Anteil, gleitender Mittelwert, laufende Summe, W→Wh |
| `IF(bed, a, b)`, `COALESCE(a, b)`, `ISNULL(x)` | Bedingungen, Ersatzwerte |
| `ABS ROUND FLOOR CEIL SQRT POW LOG EXP CLAMP NONNEG` | Mathematik |
| `HOURS() HOUR() WEEKDAY() DAY() MONTH()` | Zeitfunktionen des Abschnitts |

Beispiele: `Eigenverbrauchsquote = PERCENT(sensor.pv - sensor.einspeisung, sensor.pv)`,
`Durchschnittstemperatur = AVG(sensor.temp, 7d)`, `Heizkosten = sensor.heizenergie * energiepreis`.

Kennzahlen werden **bei jeder Abfrage aus den gespeicherten Messwerten berechnet** – Änderungen an Formeln
wirken daher automatisch rückwirkend. Division durch 0 oder fehlende Daten ergeben „–“ statt eines Fehlers.
Zirkelbezüge zwischen Kennzahlen werden erkannt. Die Auswertung ist ein eigener Interpreter ohne
Codeausführung.

**Aggregation über einen Zeitraum** (z. B. KPI „diesen Monat“): *Automatisch* berechnet die Formel über den
Gesamtzeitraum als Ganzes (richtig für Quoten), zeitabhängige Formeln werden tageweise berechnet und mit der
eingestellten Aggregation (Summe/Mittel/Letzter …) zusammengefasst.

## Dashboard-Editor

* Mehrere Dashboards, je Dashboard mehrere Seiten (Reihenfolge, Ausblenden, eigenes Design je Seite).
* Raster mit Drag & Drop, Größenänderung, freier Positionierung (Nachrücken abschaltbar), optional Überlappung
  mit **Ebenen** (Vorder-/Hintergrund, Sperren, Ausblenden).
* Ausrichtungshilfen (links/rechts/oben/unten/zentrieren, gleiche Größe, verteilen), Rasterlinien.
* **Responsive Layouts** für Smartphone, Tablet hoch/quer, Desktop, großen Monitor und Fernseher: über die
  Gerätesymbole wird das jeweilige Layout getrennt bearbeitet (mit maßstäblicher Vorschau).
* Tastenkürzel: Strg+Z/Y, Strg+C/V (auch seiten- und dashboardübergreifend), Strg+D, Strg+A, Entf, Esc.
* Automatisches Speichern; gleichzeitige Änderungen werden erkannt (Versionsprüfung).
* Export/Import einzelner Dashboards als JSON inkl. benötigter Kennzahlen und Konstanten.

## Widgets (35 Typen)

* **Kennzahlen:** Einzelwert, Mehrere Kennzahlen, KPI-Karte (Vergleich + Ziel), Vergleichskarte, Prozentanzeige, Trendanzeige
* **Diagramme:** Linie, Fläche, Balken, gestapelte Balken, Kreis, Donut, Gauge, Radial Gauge, Heatmap (Stunde × Tag),
  Kalender-Heatmap, Verlaufskurve, Vergleichsdiagramm
* **Energie:** Energiefluss (Solar/Netz/Batterie/Haus, live), Stromverbrauch, Kostenübersicht, Verbrauchsverteilung,
  Solarproduktion, Eigenverbrauch/Autarkie, Netzbezug, Netzeinspeisung
* **Weitere:** Tabelle, Historische Daten, Statistikübersicht, Text (Markdown mit Live-Werten `{{sensor.x}}`),
  Überschrift, Bild, Datum/Uhrzeit, Info-Karte, Analyse-Ergebnis

Jedes Widget hat einen Editor mit den Bereichen *Daten* (Quellen, Statistik, Zeitraum, Intervall,
Aktualisierung), *Darstellung*, *Format* (Einheit, Nachkommastellen, Tausendertrennung, Präfix/Suffix,
Farbpalette) und *Stil* (Hintergrund, Transparenz, Glas-Effekt, Rahmen, Radius, Schatten, Abstände, Titel).

## Design

Presets: Dark Analytics, Modern Minimal, Futuristic Neon, Glass Dashboard, Energy Control Center,
Nordic Light, Midnight OLED. Jedes Preset ist anpassbar: Hell/Dunkel, Akzentfarben, Hintergrundfarbe/-verlauf/-bild
(Upload), Transparenz, Glassmorphism, Schatten, Rahmen, Radius, Schriftart/-größe, Diagrammpalette,
Animationen, Leuchteffekte. Ebenen: global → Dashboard → Seite → Widget.

## Automatische Analysen

Ohne KI, aus den echten Messwerten: Verbrauch heute/Woche/Monat/Jahr mit Vergleich zum Vorzeitraum
(bei laufenden Zeiträumen fair zum *gleichen Zeitabschnitt*), Tagesdurchschnitt, höchster/niedrigster Tag,
Spitzenzeitfenster („Dienstag zwischen 18 und 20 Uhr“), Tages- und Wochenprofil, langfristiger Trend
(lineare Regression mit R²), auffällige Tage (gleitender Z-Wert, Sommerzeit-bereinigt), freier
Zeitraumvergleich. Unvollständige Daten werden gekennzeichnet und bei Extremwerten nicht berücksichtigt.

## Mit ChatGPT analysieren

Unter **ChatGPT-Export** Datenquellen, Zeitraum und Schwerpunkt wählen → *Auswertung & Prompt erstellen* →
**Prompt kopieren** und **ChatGPT öffnen**, dann einfügen. Alternativ Bericht (.md), Daten (.json) oder
Prompt (.txt) herunterladen und in ChatGPT hochladen. Es gibt **keine** direkte Verbindung zu ChatGPT, keine
Cookies, keinen API-Key. Optional (standardmäßig aus) lassen sich unter *Einstellungen → KI-Anbieter* eine
lokale **Ollama**-Instanz oder eine **OpenAI-kompatible API** für direkte Analysen eintragen.

## Präsentationsmodus

Symbol *Präsentation* im Dashboard: Vollbild, ausgeblendete Navigation, automatischer Seitenwechsel,
Übergänge, automatische Aktualisierung, Anpassung an die Bildschirmhöhe (FIT), Uhr, Bildschirm-Wachhaltung,
Mauszeiger blendet sich aus. Tasten: ←/→ Seite, Leertaste Pause, F Vollbild.

**Wanddisplays/Kiosk:** Über das Link-Symbol einen **schreibgeschützten Präsentationslink** erzeugen. Er öffnet
nur dieses Dashboard ohne Anmeldung, kann keine Einstellungen ändern und ist jederzeit widerrufbar.

## Auf Bildschirm anzeigen (Fernseher, Wandtablet)

Dashboards lassen sich vom Handy oder PC aus auf einem anderen Bildschirm im Netzwerk anzeigen:

1. **Einmalig am Fernseher/Tablet** im Browser `http://<HA-IP>:8100/tv` öffnen (z. B. `http://192.168.178.101:8100/tv`)
   und als Lesezeichen/Startseite speichern. Es erscheint ein 4-stelliger Kopplungscode.
2. Am Handy ein Dashboard öffnen → **„Teilen“** → „Gerät per Code koppeln“ → Code und Name eingeben
   (alternativ *Einstellungen → Bildschirme (TV)*).
3. Danach jederzeit: **„Teilen“** → Gerät antippen. Oben lässt sich wählen, ob nur die aktuelle Seite oder das ganze Dashboard
   (optional mit automatischem Seitenwechsel) angezeigt wird. Der Bildschirm wechselt sofort.

Der Bildschirm bleibt dauerhaft gekoppelt, verbindet sich nach WLAN-Abbruch oder Neustart selbst neu und zeigt wieder das
zuletzt gesendete Dashboard. Mit „Identifizieren“ blendet ein Bildschirm seinen Namen groß ein. Bildschirme haben nur
Lesezugriff und lassen sich unter *Einstellungen → Bildschirme* umbenennen, neu laden oder entkoppeln.

### Fernseher automatisch einschalten und öffnen (optional, Gerätesteuerung)

Unter *Einstellungen → Bildschirme (TV)* lässt sich ein Fernseher aus Home Assistant verknüpfen (z. B. Samsung über die
Integration „Samsung Smart TV Enhanced“). Ist **„Fernseher-Steuerung erlauben“** aktiviert, schaltet „Auf Bildschirm → Senden“
den Fernseher bei Bedarf ein und öffnet dort das Dashboard im Browser – am Fernseher ist nichts zu tun, auch keine Kopplung.

Dies ist die einzige Stelle, an der das Add-on Geräte steuert, und sie ist standardmäßig ausgeschaltet. Erlaubt sind
ausschließlich `media_player.turn_on` und `media_player.play_media` (Typ „browser“, Dashboard-Adresse) für ausdrücklich
verknüpfte Fernseher; alle anderen Aktionen bleiben technisch gesperrt. Die Adresse, die der Fernseher öffnet, wird aus der
internen URL von Home Assistant und dem Direktport abgeleitet oder kann eingetragen werden (z. B. `http://192.168.178.101:8100`).
Kann die Fernseher-Integration keine Adresse öffnen (z. B. die Standard-Samsung-Integration: „can only play media of type app“),
startet das Add-on automatisch die **Internet-App** des Fernsehers; sie öffnet ihre zuletzt besuchte Seite. Dafür einmalig am
Fernseher `…:8100/tv` öffnen und den Code unter „Teilen → Gerät per Code koppeln“ dem verknüpften Fernseher zuordnen. Die
funktionierende Startart wird gespeichert. Nicht verknüpfte, aber geeignete Fernseher aus Home Assistant erscheinen im
Teilen-Fenster und lassen sich mit einem Tipp hinzufügen.

Geeignet sind alle Geräte mit Browser: Samsung-/LG-Fernseher (eingebauter Browser muss geöffnet bleiben),
Fire TV / Android TV (Silk-Browser oder eine Kiosk-App wie „Fully Kiosk Browser“), Tablets, PCs. Chromecast/AirPlay wird
bewusst nicht verwendet, da dies eine Gerätesteuerung über Home Assistant erfordern würde.

## Backup und Export

* **Einstellungen → Backup:** vollständige Sicherung (Datenbank + Konfiguration) oder nur Konfiguration;
  Prüfsummen (SHA-256) und SQLite-Integrität werden geprüft; Wiederherstellung komplett oder nur Konfiguration;
  vor einer vollständigen Wiederherstellung wird automatisch eine Sicherheitskopie erstellt. Tägliche automatische
  Sicherung mit einstellbarer Anzahl.
* **Home-Assistant-Backups:** Vor einem HA-Backup erstellt das Add-on einen konsistenten Snapshot der Datenbank
  (die laufende Datenbankdatei selbst wird ausgeschlossen). Nach einer Wiederherstellung über HA wird dieser
  Snapshot beim Start automatisch übernommen.
* **Beschädigte Datenbank:** Schlägt beim Start die Integritätsprüfung fehl, wird die Datei beiseitegelegt und
  automatisch die neueste Sicherung wiederhergestellt.
* **Export:** Messwerte als CSV (Excel-kompatibel) oder JSON, Konfiguration als JSON, Dashboards als JSON.

## Add-on-Optionen

| Option | Bedeutung |
|---|---|
| `log_level` | Protokollstufe |
| `base_url` | Öffentliche Adresse hinter einem Reverse Proxy (für Präsentationslinks) |
| `secure_cookies` | Sitzungscookies nur über HTTPS |
| `trust_proxy_headers` | `X-Forwarded-*` eines vorgeschalteten Proxys auswerten |

Alle übrigen Einstellungen werden in der Oberfläche unter **Einstellungen** vorgenommen und in `/data` gespeichert.
