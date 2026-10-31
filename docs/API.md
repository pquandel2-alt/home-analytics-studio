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
  -d '{"sources":[{"type":"metric","id":"kosten"}],"range":"7d"}' $B/api/data/series
curl -H "$H" -H 'Content-Type: application/json' -d '{"sources":[...],"range":"30d"}' $B/api/analysis/run
```

Fehler: `401` Token ungültig/abgelaufen/widerrufen (Header `WWW-Authenticate: Bearer`), `403` Rolle reicht nicht,
`409` veraltete Seiten-`version`.

## ChatGPT über Home Assistant MCP

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
