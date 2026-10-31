"""MCP server (Streamable HTTP, stateless) exposing Analytics Studio as tools.

Design
  * Lives inside the add-on, next to the REST API – no change to third-party MCP add-ons needed.
  * Two separate secrets, both set once in the add-on configuration (Supervisor-protected /data/options.json):
      - ``mcp_access_key``: lets the MCP client (e.g. ChatGPT) reach this endpoint (path ``/mcp/<key>`` or
        ``Authorization: Bearer <key>``). Without it the endpoint does not exist (404).
      - ``mcp_api_token``: a normal Analytics Studio API token (``has_...``). Every tool call goes through the
        regular REST routes in-process with this token, so roles, expiry, revocation and demotion apply 1:1.
  * The token is re-read from the options file on every call (mtime-cached): rotation needs no restart.
  * Only reachable on the direct port – never on the ingress listener.
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from .api.deps import client_ip, is_ingress, services
from .config import VERSION
from .core.auth import RateLimiter, TOKEN_PREFIX

log = logging.getLogger(__name__)

router = APIRouter(tags=["mcp"], include_in_schema=False)

PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")
MAX_BODY = 6 * 1024 * 1024
MAX_RESULT_CHARS = 900_000
MIN_KEY_LEN = 24
_limiter = RateLimiter(limit=30, window=300)  # wrong access keys per client IP


# --------------------------------------------------------------------------- secrets


class McpSecrets:
    """Reads ``mcp_access_key`` / ``mcp_api_token`` from env or the add-on options file (hot reload)."""

    def __init__(self, data_dir: Path):
        self.options_file = Path(data_dir) / "options.json"
        self._mtime: float | None = None
        self._opts: dict = {}

    def _options(self) -> dict:
        try:
            mtime = self.options_file.stat().st_mtime_ns
        except OSError:
            self._mtime, self._opts = None, {}
            return self._opts
        if mtime != self._mtime:
            try:
                self._opts = json.loads(self.options_file.read_text("utf-8"))
            except (OSError, ValueError):
                self._opts = {}
            self._mtime = mtime
        return self._opts

    def _get(self, env: str, opt: str) -> str:
        return (os.environ.get(env) or str(self._options().get(opt) or "")).strip()

    @property
    def access_key(self) -> str:
        key = self._get("HAS_MCP_ACCESS_KEY", "mcp_access_key")
        return key if len(key) >= MIN_KEY_LEN else ""

    @property
    def api_token(self) -> str:
        return self._get("HAS_MCP_API_TOKEN", "mcp_api_token")

    @property
    def key_too_short(self) -> bool:
        raw = self._get("HAS_MCP_ACCESS_KEY", "mcp_access_key")
        return bool(raw) and len(raw) < MIN_KEY_LEN


def secrets_for(request: Request) -> McpSecrets:
    svc = services(request)
    if not hasattr(svc, "mcp_secrets"):
        svc.mcp_secrets = McpSecrets(svc.config.data_dir)
    return svc.mcp_secrets


# --------------------------------------------------------------------------- in-process REST dispatch


async def call_api(app, method: str, path: str, token: str, body: Any = None, query: str = "") -> tuple[int, Any]:
    """Call a REST route of this very app through ASGI with ``Authorization: Bearer <token>``."""
    payload = json.dumps(body).encode() if body is not None else b""
    headers = [(b"authorization", f"Bearer {token}".encode()), (b"accept", b"application/json"),
               (b"host", b"internal")]
    if body is not None:
        headers += [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode())]
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method, "scheme": "http",
             "path": path, "raw_path": path.encode(), "query_string": query.encode(), "root_path": "",
             "headers": headers, "client": ("127.0.0.1", 0), "server": ("internal", 0), "state": {}}
    sent = False
    status, chunks = 500, []

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": payload, "more_body": False}

    async def send(msg):
        nonlocal status
        if msg["type"] == "http.response.start":
            status = msg["status"]
        elif msg["type"] == "http.response.body":
            chunks.append(msg.get("body", b""))

    await app(scope, receive, send)
    raw = b"".join(chunks)
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, raw.decode("utf-8", "replace")[:500]


# --------------------------------------------------------------------------- tools

_SOURCE = {
    "type": "object",
    "description": 'Datenquelle, z. B. {"type":"metric","id":"kosten"} (Kennzahl, Schlüssel aus analytics_list_metrics) '
                   'oder {"type":"entity","id":"sensor.xyz"}.',
    "properties": {"type": {"type": "string", "enum": ["metric", "entity"]}, "id": {"type": "string"}},
    "required": ["type", "id"],
    "additionalProperties": True,
}
_RANGE = {"description": 'Zeitraum: "today", "yesterday", "last_24h", "last_7d", "last_30d", "this_week", "last_week", '
                         '"this_month", "last_month", "this_year", "last_year" (Kurzform "7d" = "last_7d") oder ein '
                         'Objekt {"start":"2026-10-01","end":"2026-10-31"}.',
          "default": "today"}

TOOLS: list[dict] = [
    {"name": "analytics_list_dashboards",
     "description": "Listet alle Dashboards (id, name, Seitenzahl, Änderungszeit). Nur lesend.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "analytics_get_dashboard",
     "description": "Lädt ein Dashboard mit allen Seiten, Widgets, Layouts und der aktuellen Seiten-version "
                    "(wird für analytics_update_page benötigt). Nur lesend.",
     "inputSchema": {"type": "object", "properties": {"dashboard_id": {"type": "integer"}},
                     "required": ["dashboard_id"], "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "analytics_create_dashboard",
     "description": "Legt ein NEUES Dashboard mit einer leeren Seite „Übersicht“ an (Editor-Rolle nötig). "
                    "Bestehende Dashboards werden nicht verändert. Inhalt danach mit analytics_update_page setzen.",
     "inputSchema": {"type": "object", "properties": {
         "name": {"type": "string"}, "description": {"type": "string"}, "icon": {"type": "string"},
         "theme": {"type": "object"}, "settings": {"type": "object"}},
         "required": ["name"], "additionalProperties": False},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False,
                     "openWorldHint": False}},
    {"name": "analytics_update_dashboard",
     "description": "Ändert Metadaten eines Dashboards (Name, Beschreibung, Icon, Theme, Einstellungen). "
                    "Nur übergebene Felder werden geändert; theme/settings ersetzen den bisherigen Wert vollständig. "
                    "Editor-Rolle nötig. Seiteninhalt: analytics_update_page.",
     "inputSchema": {"type": "object", "properties": {
         "dashboard_id": {"type": "integer"}, "name": {"type": "string"}, "description": {"type": "string"},
         "icon": {"type": "string"}, "theme": {"type": "object"}, "settings": {"type": "object"}},
         "required": ["dashboard_id"], "additionalProperties": False},
     "annotations": {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True,
                     "openWorldHint": False}},
    {"name": "analytics_update_page",
     "description": "Ändert eine Dashboard-Seite (Titel, Widgets, Layouts, Einstellungen, hidden). widgets/layouts "
                    "ersetzen den bisherigen Inhalt vollständig – daher zuerst analytics_get_dashboard lesen, ändern "
                    "und zurückschreiben. 'version' = aktuelle Seitenversion; bei Abweichung Fehler 409 statt "
                    "Überschreiben. Editor-Rolle nötig.",
     "inputSchema": {"type": "object", "properties": {
         "page_id": {"type": "integer"}, "title": {"type": "string"}, "icon": {"type": "string"},
         "hidden": {"type": "boolean"}, "settings": {"type": "object"},
         "widgets": {"type": "array", "items": {"type": "object"}},
         "layouts": {"type": "object"},
         "version": {"type": "integer", "description": "aktuelle Seitenversion (dringend empfohlen)"}},
         "required": ["page_id"], "additionalProperties": False},
     "annotations": {"readOnlyHint": False, "destructiveHint": True, "idempotentHint": True,
                     "openWorldHint": False}},
    {"name": "analytics_list_metrics",
     "description": "Listet alle Kennzahlen (Schlüssel, Name, Formel, Einheit, genutzte Entitäten) und optional die "
                    "Konstanten. Nur lesend.",
     "inputSchema": {"type": "object", "properties": {"include_constants": {"type": "boolean", "default": False}},
                     "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "analytics_get_data",
     "description": "Liest Messdaten einer Kennzahl oder Entität: mode 'scalar' = ein Wert für den Zeitraum, "
                    "'series' = Zeitreihe. Nur lesend.",
     "inputSchema": {"type": "object", "properties": {
         "source": _SOURCE, "range": _RANGE, "mode": {"type": "string", "enum": ["scalar", "series"], "default": "scalar"},
         "interval": {"type": "string", "description": 'nur series, z. B. "auto", "5m", "1h", "1d"', "default": "auto"}},
         "required": ["source"], "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "analytics_system_status",
     "description": "Zustand des Add-ons: Version, Home-Assistant-Verbindung, Datenbank-/Speicherstatus, Anzahl "
                    "Objekte und die Rolle/Gültigkeit des hinterlegten API-Tokens (ohne den Token selbst). Nur lesend.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
]
TOOL_NAMES = {t["name"] for t in TOOLS}


def _pick(args: dict, *names: str) -> dict:
    return {n: args[n] for n in names if n in args and args[n] is not None}


def _need_int(args: dict, name: str) -> int:
    v = args.get(name)
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"'{name}' muss eine ganze Zahl sein")
    return v


async def run_tool(app, token: str, name: str, args: dict) -> tuple[int, Any]:
    c = lambda m, p, b=None: call_api(app, m, p, token, b)  # noqa: E731
    if name == "analytics_list_dashboards":
        return await c("GET", "/api/dashboards")
    if name == "analytics_get_dashboard":
        return await c("GET", f"/api/dashboards/{_need_int(args, 'dashboard_id')}")
    if name == "analytics_create_dashboard":
        if not isinstance(args.get("name"), str) or not args["name"].strip():
            raise ValueError("'name' ist erforderlich")
        return await c("POST", "/api/dashboards", _pick(args, "name", "description", "icon", "theme", "settings"))
    if name == "analytics_update_dashboard":
        body = _pick(args, "name", "description", "icon", "theme", "settings")
        if not body:
            raise ValueError("Keine Änderung angegeben")
        return await c("PUT", f"/api/dashboards/{_need_int(args, 'dashboard_id')}", body)
    if name == "analytics_update_page":
        body = _pick(args, "title", "icon", "hidden", "settings", "widgets", "layouts", "version")
        if not set(body) - {"version"}:
            raise ValueError("Keine Änderung angegeben")
        return await c("PUT", f"/api/pages/{_need_int(args, 'page_id')}", body)
    if name == "analytics_list_metrics":
        status, metrics = await c("GET", "/api/metrics")
        if status != 200 or not args.get("include_constants"):
            return status, metrics
        cs, consts = await c("GET", "/api/constants")
        return cs, ({"metrics": metrics, "constants": consts} if cs == 200 else consts)
    if name == "analytics_get_data":
        src = args.get("source")
        if not isinstance(src, dict) or not src.get("type") or not src.get("id"):
            raise ValueError("'source' braucht type und id")
        mode = args.get("mode", "scalar")
        if mode not in ("scalar", "series"):
            raise ValueError("'mode' muss scalar oder series sein")
        rng = args.get("range", "today")
        if isinstance(rng, str) and re.fullmatch(r"\d+[hdw]", rng.strip()):
            rng = "last_" + rng.strip()
        body: dict = {"source": src, "range": rng}
        if mode == "series":
            body["interval"] = args.get("interval", "auto")
        return await c("POST", f"/api/data/{mode}", body)
    if name == "analytics_system_status":
        status, info = await c("GET", "/api/system/info")
        if status != 200:
            return status, info
        _, me = await c("GET", "/api/auth/me")
        _, ha = await c("GET", "/api/ha/status")
        info = {k: info.get(k) for k in ("version", "schema_version", "timezone", "uptime", "counts", "disk",
                                         "recorder", "maintenance")}
        return 200, {**info, "home_assistant": ha, "access": _pick(me or {}, "username", "role", "kind")}
    raise KeyError(name)


def _error_text(status: int, data: Any) -> str:
    if status == 401:
        return ("Der in der Add-on-Konfiguration hinterlegte API-Token ist ungültig, abgelaufen oder widerrufen. "
                "Der Besitzer muss unter Einstellungen → Benutzer und Sicherheit → API-Zugänge einen neuen Token "
                "erstellen und ihn im Add-on unter Konfiguration → mcp_api_token eintragen.")
    if status == 403:
        return "Keine Berechtigung: Die Rolle des hinterlegten API-Tokens reicht für diese Aktion nicht aus."
    detail = data.get("detail") if isinstance(data, dict) else data
    if isinstance(detail, dict):
        msg = detail.get("message") or json.dumps(detail, ensure_ascii=False)
        if status == 409 and isinstance(detail.get("current"), dict):
            msg += f" Aktuelle Version: {detail['current'].get('version')} – Seite neu laden und erneut versuchen."
        return f"Fehler {status}: {msg}"
    return f"Fehler {status}: {detail if detail else 'unbekannter Fehler'}"


def _scrub(text: str, token: str) -> str:
    return text.replace(token, "[token]") if token else text


async def tools_call(request: Request, params: dict) -> dict:
    name = params.get("name")
    args = params.get("arguments") or {}
    token = secrets_for(request).api_token
    if name not in TOOL_NAMES:
        return {"_rpc_error": (-32602, f"Unbekanntes Werkzeug: {name}")}
    if not isinstance(args, dict):
        return {"_rpc_error": (-32602, "arguments muss ein Objekt sein")}

    def err(msg: str) -> dict:
        return {"content": [{"type": "text", "text": _scrub(msg, token)}], "isError": True}

    if not token.startswith(TOKEN_PREFIX):
        return err("Kein API-Token hinterlegt. Im Add-on unter Konfiguration → mcp_api_token einen Analytics-Studio-"
                   "API-Token (beginnt mit has_) eintragen und das Add-on neu starten.")
    try:
        status, data = await run_tool(request.app, token, name, args)
    except ValueError as e:
        return err(f"Ungültige Eingabe: {e}")
    except Exception:  # noqa: BLE001 - never leak internals
        log.exception("MCP-Werkzeug %s fehlgeschlagen", name)
        return err("Interner Fehler")
    log.info("MCP %s -> %s", name, status)
    if status != 200:
        return err(_error_text(status, data))
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(text) > MAX_RESULT_CHARS:
        return err("Das Ergebnis ist zu groß für eine Antwort. Zeitraum/Auswahl einschränken.")
    return {"content": [{"type": "text", "text": _scrub(text, token)}],
            "structuredContent": data if isinstance(data, dict) else {"result": data}, "isError": False}


# --------------------------------------------------------------------------- JSON-RPC


def _rpc_error(id_: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


async def handle_message(request: Request, msg: Any) -> dict | None:
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        return _rpc_error(None, -32600, "Ungültige Anfrage")
    method, id_, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if "id" not in msg or method is None:  # notification or stray response
        return None
    if method == "initialize":
        asked = params.get("protocolVersion")
        return {"jsonrpc": "2.0", "id": id_, "result": {
            "protocolVersion": asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "home-analytics-studio", "version": VERSION},
            "instructions": "Werkzeuge für Home Analytics Studio. Zum Ändern einer Seite: erst analytics_get_dashboard, "
                            "dann analytics_update_page mit der gelesenen 'version'."}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": id_, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": id_, "result": {"tools": TOOLS}}
    if method == "tools/call":
        res = await tools_call(request, params)
        if "_rpc_error" in res:
            return _rpc_error(id_, *res["_rpc_error"])
        return {"jsonrpc": "2.0", "id": id_, "result": res}
    empty = {"resources/list": "resources", "resources/templates/list": "resourceTemplates", "prompts/list": "prompts"}
    if method in empty:
        return {"jsonrpc": "2.0", "id": id_, "result": {empty[method]: []}}
    return _rpc_error(id_, -32601, f"Methode nicht unterstützt: {method}")


# --------------------------------------------------------------------------- HTTP endpoint


def _authorized(request: Request, path_key: str | None) -> bool | None:
    """True = ok, False = wrong key, None = MCP not configured."""
    expected = secrets_for(request).access_key
    if not expected:
        return None
    given = path_key
    if given is None:
        header = request.headers.get("authorization") or ""
        scheme, _, value = header.partition(" ")
        given = value.strip() if scheme.lower() == "bearer" else ""
    return hmac.compare_digest(given.encode(), expected.encode())


async def _endpoint(request: Request, path_key: str | None) -> Response:
    svc = services(request)
    if is_ingress(request, svc):  # never through the (implicitly trusted) ingress listener
        return Response(status_code=404)
    ok = _authorized(request, path_key)
    if ok is None:
        return Response(status_code=404)  # feature off: indistinguishable from "no such path"
    ip = client_ip(request, svc)
    if not ok:
        if not _limiter.allow("mcp:" + ip):
            return Response(status_code=429)
        return Response(status_code=401, headers={"WWW-Authenticate": "Bearer"})
    if request.method != "POST":
        return Response(status_code=405, headers={"Allow": "POST"})
    raw = await request.body()
    if len(raw) > MAX_BODY:
        return JSONResponse(_rpc_error(None, -32600, "Anfrage zu groß"), status_code=413)
    try:
        msg = json.loads(raw)
    except ValueError:
        return JSONResponse(_rpc_error(None, -32700, "Ungültiges JSON"), status_code=400)
    headers = {"Cache-Control": "no-store"}
    if isinstance(msg, list):
        out = [r for r in [await handle_message(request, m) for m in msg] if r is not None]
        return JSONResponse(out, headers=headers) if out else Response(status_code=202, headers=headers)
    res = await handle_message(request, msg)
    return JSONResponse(res, headers=headers) if res is not None else Response(status_code=202, headers=headers)


@router.api_route("/mcp", methods=["GET", "POST", "DELETE"])
async def mcp_header_auth(request: Request) -> Response:
    return await _endpoint(request, None)


@router.api_route("/mcp/{key}", methods=["GET", "POST", "DELETE"])
async def mcp_path_auth(key: str, request: Request) -> Response:
    return await _endpoint(request, key)
