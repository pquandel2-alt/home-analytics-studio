# REST-API mit persönlichen API-Tokens

Seit 1.6.0 akzeptieren **alle bestehenden REST-Endpunkte** (`/api/...`) zusätzlich zum Login-Cookie den Header

```
Authorization: Bearer has_<token>
```

Es gibt keine zweite API: Dashboards, Seiten, Kennzahlen, Konstanten, Daten und Analysen laufen über dieselben
Endpunkte und Datenmodelle wie die Oberfläche (Beschreibung aller Routen: `GET /api/openapi.json`).

## Sicherheitsmodell

* Tokens erzeugen/widerrufen: **Einstellungen → Benutzer und Sicherheit → API-Zugänge** (nur Administratoren, nur über
  Anmeldung/Seitenleiste – ein Token kann keine Tokens verwalten).
* Jeder Token gehört einem Benutzer und hat eine Rolle (`viewer`, `editor`, `admin`). Wirksam ist immer das
  **Minimum** aus Token-Rolle und aktueller Benutzerrolle (Herabstufen wirkt sofort). Kein automatischer Admin-Zugriff.
* In der Datenbank liegt nur der SHA-256-Hash; der volle Token wird **einmalig** bei der Erstellung angezeigt.
* Optionaler Ablauf (Tage). Abgelaufen, widerrufen, unbekannt oder Benutzer gelöscht → `401`. Zu geringe Rolle → `403`.
* Ein mitgesendeter, ungültiger Bearer-Header fällt **nicht** auf Ingress/Cookie zurück (kein stilles Admin-Recht).
* Cookie-Sitzungen behalten CSRF-Schutz (`X-Requested-With` + `X-CSRF-Token`). Für Bearer-Anfragen sind diese Header nicht
  nötig, da Browser den Header nicht von selbst mitsenden.
* Tokens erscheinen weder in Protokollen noch in Fehlermeldungen; Erstellen/Widerrufen steht im Audit-Log.
* Rotation: neuen Token erstellen, Client umstellen, alten widerrufen. Die Tabelle `api_tokens` ist nicht Teil des Backup-Exports.

## Token per API verwalten (mit Admin-Anmeldung, nicht per Token)

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/auth/tokens` | Liste (Name, Benutzer, Rolle, erstellt, Ablauf, zuletzt genutzt, Status) |
| POST | `/api/auth/tokens` | `{"name","user_id","role"?,"days"?}` → enthält **einmalig** `token` |
| DELETE | `/api/auth/tokens/{id}` | Widerrufen |
| DELETE | `/api/auth/tokens/{id}/entry` | Eintrag aus der Liste entfernen |

## Beispiele (Editor-Token)

```bash
H="Authorization: Bearer has_XXXX"; B=http://homeassistant.local:8100

curl -H "$H" $B/api/auth/me                         # {"kind":"api","role":"editor",...}
curl -H "$H" $B/api/dashboards                      # Dashboards + Seiten lesen
curl -H "$H" $B/api/dashboards/1

curl -H "$H" -H 'Content-Type: application/json' -d '{"name":"Energie (ChatGPT)"}' $B/api/dashboards
curl -H "$H" -X POST $B/api/dashboards/1/duplicate
curl -H "$H" -H 'Content-Type: application/json' -X PUT $B/api/pages/5 \
  -d '{"widgets":[{"id":"w1","type":"value","title":"Kosten","config":{"sources":[{"type":"metric","id":"kosten"}]}}],
       "layouts":{"lg":[{"i":"w1","x":0,"y":0,"w":4,"h":3}]},"version":3}'   # version = aktueller Stand (sonst 409)

curl -H "$H" $B/api/metrics ; curl -H "$H" $B/api/constants ; curl -H "$H" $B/api/metrics/functions
curl -H "$H" -H 'Content-Type: application/json' -d '{"formula":"preis * 2"}' $B/api/metrics/validate
curl -H "$H" -H 'Content-Type: application/json' \
  -d '{"name":"Kosten","key":"kosten","formula":"preis * 2","unit":"€"}' $B/api/metrics

curl -H "$H" -H 'Content-Type: application/json' \
  -d '{"source":{"type":"metric","id":"kosten"},"range":"today"}' $B/api/data/scalar
curl -H "$H" -H 'Content-Type: application/json' \
  -d '{"source":{"type":"metric","id":"kosten"},"range":"last_7d"}' $B/api/data/series
curl -H "$H" -H 'Content-Type: application/json' -d '{"sources":[...],"range":"last_30d"}' $B/api/analysis/run
```

Fehler: `401` Token ungültig/abgelaufen/widerrufen (Header `WWW-Authenticate: Bearer`), `403` Rolle reicht nicht,
`409` veraltete Seiten-`version`.

## MCP-Anbindung für ChatGPT (seit 1.7.0)

### Architektur und Blocker

Der vorhandene Home-Assistant-MCP-Server (Add-on „HA MCP“ v9.0.0) hat eine **feste Werkzeugliste** und bietet keinen
Erweiterungsmechanismus für fremde Add-ons; ihn zu patchen wäre nicht updatefest. Darum bringt **Analytics Studio
seinen eigenen MCP-Endpunkt mit** (`/mcp`, Streamable HTTP, zustandslos) – ohne Fremdcode zu ändern. Konsequenz: Das ist ein
**zweiter Connector** neben dem HA-MCP (einmalig in ChatGPT hinzufügen); die Werkzeuge erscheinen danach in jeder
neuen Unterhaltung. In den bestehenden HA-MCP-Connector lassen sie sich nicht injizieren.
Außerdem muss der Direktport 8100 für ChatGPT erreichbar sein – auf demselben Weg, auf dem der HA-MCP erreichbar ist
(z. B. Cloudflare-Tunnel/Reverse Proxy mit HTTPS auf `homeassistant:8100`). **Dieser Erreichbarkeits-Schritt konnte in
der Entwicklungsumgebung nicht getestet werden** (keine Home-Assistant-Instanz, kein ChatGPT-Zugriff); Protokoll,
Sicherheit und Neustartverhalten sind automatisiert getestet (`tests/test_mcp.py`).

### Wo der Token einmalig eingetragen wird

Es gibt zwei Geheimnisse, beide **nur** in der Add-on-Konfiguration (*Einstellungen → Add-ons → Home Analytics Studio →
Konfiguration*, Supervisor-geschützt, nicht im Git-Repository, nicht in Backups des Datenbestands):

| Feld | Inhalt | Zweck |
|---|---|---|
| `mcp_api_token` | Analytics-Studio-API-Token `has_…` | wird von den Werkzeugen intern verwendet |
| `mcp_access_key` | frei gewählter Zufallsschlüssel, mind. 24 Zeichen | schützt den Endpunkt `/mcp` (ChatGPT → Add-on) |

Schritte:

1. In Analytics Studio (Ingress) einen Benutzer `chatgpt` mit Rolle **Bearbeiter** anlegen.
2. *Einstellungen → Benutzer und Sicherheit → API-Zugänge* → Token für diesen Benutzer erstellen (Rolle Bearbeiter, z. B.
   90 Tage) und **einmalig kopieren**.
3. Add-on-Konfiguration öffnen, Token bei `mcp_api_token` einfügen, bei `mcp_access_key` einen Zufallsschlüssel eintragen
   (z. B. `openssl rand -hex 24`), *Speichern*, Add-on neu starten.
4. In ChatGPT einen neuen MCP-Connector anlegen: URL `https://<extern-erreichbare-Adresse>/mcp/<mcp_access_key>`
   (alternativ `…/mcp` mit Header `Authorization: Bearer <mcp_access_key>`, falls der Client Header setzen kann),
   Authentifizierung „keine“.
5. Neue Unterhaltung: „Rufe analytics_system_status auf“ – die Antwort zeigt Rolle und Art des Zugriffs (nie den Token).

**Den Token nie in ChatGPT einfügen** – er wird dort nicht mehr gebraucht.

### Werkzeuge

`analytics_list_dashboards`, `analytics_get_dashboard`, `analytics_create_dashboard`, `analytics_update_dashboard`,
`analytics_update_page`, `analytics_list_metrics`, `analytics_get_data` (scalar/series), `analytics_system_status`.
Es gibt bewusst **kein Löschen**. `analytics_update_page` prüft die Seiten-`version` (409 statt Überschreiben).
Zeiträume: `today`, `yesterday`, `last_24h`, `last_7d`, `last_30d`, `this_week`, `this_month`, … (Kurzform `7d` ok).

### Sicherheit

* Jeder Werkzeugaufruf läuft intern über **dieselben REST-Routen** mit dem hinterlegten Bearer-Token: Rollen, Ablauf,
  Widerruf und Herabstufung gelten unverändert (Bearbeiter genügt; ein Viewer-Token kann nur lesen, nie Admin-Funktionen).
* Der Token steht nur in `/data/options.json` des Add-ons; er erscheint nicht in Werkzeugdefinitionen, Antworten
  (zusätzlich ersetzt ein Filter jedes Vorkommen), Fehlermeldungen oder Protokollen (geloggt werden nur Werkzeugname und Status).
* `/mcp` existiert nur mit gesetztem Zugangsschlüssel (sonst 404), nur auf dem Direktport (auf Ingress immer 404),
  Vergleich in konstanter Zeit, Begrenzung falscher Versuche pro IP (429).
  Der Schlüssel im Pfad kann in Proxy-Zugriffsprotokollen auftauchen – dort Pfade maskieren oder, wenn der Client es kann,
  den Header-Weg nutzen. Immer HTTPS verwenden, sobald der Port außerhalb des LAN erreichbar ist.
* **Tokenwechsel:** neuen Token erstellen, bei `mcp_api_token` ersetzen, alten widerrufen. Die Datei wird bei jedem Aufruf
  neu gelesen; die Werkzeuge liefern bis zur Übernahme eine verständliche Fehlermeldung (kein Absturz).
  **Widerruf** (API-Zugänge → Widerrufen) sperrt die Werkzeuge sofort. Zugangsschlüssel wechseln: Feld ändern und die
  Connector-URL in ChatGPT anpassen; MCP komplett abschalten: `mcp_access_key` leeren.
* Neustart: nichts liegt im Arbeitsspeicher oder in Sitzungen – der Server ist zustandslos, Schlüssel und Token stehen in
  den Add-on-Optionen. Getestet inkl. echtem Prozess-Neustart.

## Alternative: Bearer-Header über den HA-MCP-Proxy (Stand 1.6.0)

Einrichtung:

1. Benutzer anlegen (z. B. `chatgpt`, Rolle *Bearbeiter*) und unter *API-Zugänge* einen Token erstellen
   (Rolle Bearbeiter, z. B. 90 Tage). Token einmalig kopieren.
2. Den Token **nicht** in Chats einfügen, sondern dort hinterlegen, wo der MCP-Client `request_headers` setzt.
   Ziel-URL ist der Direktport (`http://<HA-IP>:8100/api/...`), nicht Ingress.
3. **Weiterleitung prüfen:** Aufruf von `GET /api/auth/me` über den MCP-Proxy mit
   `request_headers: {"Authorization": "Bearer has_…"}`.
   * `{"kind":"api","role":"editor"}` → Header kommt unverändert an, alles funktioniert.
   * `401` → Header wird entfernt/verändert **oder** Token ungültig/abgelaufen. Gegenprobe direkt per `curl` (siehe oben):
     klappt `curl`, liegt es am Proxy.
   * Antwort mit `"kind":"ingress"` / Admin → der Proxy läuft über Ingress und der Header wurde nicht gesendet; nicht verwenden.

**Stand der Prüfung:** Der Quellcode des HA-MCP-Add-on-Proxys und die laufende Home-Assistant-Instanz waren in der
Entwicklungsumgebung nicht verfügbar; die Weiterleitung von `request_headers` konnte daher **nicht verifiziert** werden.
Analytics Studio selbst wertet `Authorization: Bearer` korrekt aus (automatisierte Tests). Ob der Proxy den Header
unverändert durchreicht, ist mit der Probe oben in wenigen Sekunden prüfbar. Falls nicht: Blocker liegt im Proxy
(Header-Whitelist) – keine Umgehung (z. B. Token in URL/Query) implementiert, da das Tokens in Logs preisgäbe.
