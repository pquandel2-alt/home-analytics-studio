"""Read-only Home Assistant WebSocket client with automatic reconnect.

Only an explicit allow-list of *read* commands can be sent. Service calls or
any other state-changing command are rejected locally, so the application can
never control devices.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import aiohttp

log = logging.getLogger(__name__)

READ_ONLY_COMMANDS = frozenset({
    "get_states",
    "get_config",
    "ping",
    "subscribe_events",
    "unsubscribe_events",
    "config/area_registry/list",
    "config/device_registry/list",
    "config/entity_registry/list",
    "config/floor_registry/list",
    "history/history_during_period",
    "recorder/statistics_during_period",
    "recorder/list_statistic_ids",
    "recorder/get_statistics_metadata",
    "energy/get_prefs",
})

ALLOWED_EVENTS = frozenset({
    "state_changed",
    "area_registry_updated",
    "device_registry_updated",
    "entity_registry_updated",
})

BACKOFF = (1, 2, 5, 10, 20, 30, 60)

# The ONLY state changing actions the add-on may ever perform – used exclusively by the
# opt-in "open dashboard on TV" feature for TVs the user linked explicitly.
ALLOWED_CONTROL = frozenset({("media_player", "turn_on"), ("media_player", "play_media")})
# play_media is further limited to the dashboard URL or the TV browser app (Samsung Tizen ids)
BROWSER_APP_IDS = frozenset({"org.tizen.browser", "3201907018807"})


class HAError(Exception):
    pass


class HAAuthError(HAError):
    pass


@dataclass
class Endpoint:
    ws_url: str
    token: str
    verify_ssl: bool = True
    label: str = ""


@dataclass
class HAStatus:
    state: str = "disconnected"  # disconnected|connecting|connected|auth_failed|not_configured|error
    error: str | None = None
    ha_version: str | None = None
    connected_since: float | None = None
    last_event: float | None = None
    reconnects: int = 0
    endpoint: str | None = None
    events_received: int = 0

    def as_dict(self) -> dict:
        return dict(self.__dict__)


def build_ws_url(base_url: str) -> str:
    url = base_url.rstrip("/")
    if url.startswith("https://"):
        url = "wss://" + url[len("https://"):]
    elif url.startswith("http://"):
        url = "ws://" + url[len("http://"):]
    elif not url.startswith(("ws://", "wss://")):
        url = "ws://" + url
    if not url.endswith("/websocket"):
        url += "/api/websocket"
    return url


def parse_ha_time(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        return v / 1000.0 if v > 1e11 else v
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


StateCallback = Callable[[str, dict | None, dict | None], Awaitable[None] | None]


@dataclass
class Registry:
    areas: dict[str, dict] = field(default_factory=dict)
    devices: dict[str, dict] = field(default_factory=dict)
    entities: dict[str, dict] = field(default_factory=dict)


class HAClient:
    def __init__(self, endpoint_provider: Callable[[], Endpoint | None]):
        self._endpoint_provider = endpoint_provider
        self.status = HAStatus()
        self.states: dict[str, dict] = {}
        self.config: dict = {}
        self.registry = Registry()
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._session: aiohttp.ClientSession | None = None
        self._msg_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self._connected = asyncio.Event()
        self._restart = asyncio.Event()
        self.state_listeners: list[StateCallback] = []
        self.status_listeners: list[Callable[[HAStatus], Any]] = []
        self.connect_listeners: list[Callable[[], Awaitable[None]]] = []

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._stop.clear()
            self._task = asyncio.create_task(self._run(), name="ha-client")

    async def stop(self) -> None:
        self._stop.set()
        self._restart.set()
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()
        if self._task:
            try:
                await asyncio.wait_for(self._task, 5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
        if self._session:
            await self._session.close()
            self._session = None

    async def reconnect(self) -> None:
        """Force a reconnect (e.g. after settings change)."""
        self._restart.set()
        if self._ws is not None and not self._ws.closed:
            await self._ws.close()

    @property
    def connected(self) -> bool:
        return self.status.state == "connected"

    async def wait_connected(self, timeout: float) -> bool:
        try:
            await asyncio.wait_for(self._connected.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False

    def _set_status(self, state: str, error: str | None = None) -> None:
        self.status.state = state
        self.status.error = error
        if state == "connected":
            self.status.connected_since = time.time()
            self._connected.set()
        else:
            self._connected.clear()
        for cb in list(self.status_listeners):
            try:
                cb(self.status)
            except Exception:  # noqa: BLE001
                log.exception("status listener failed")

    async def _run(self) -> None:
        attempt = 0
        while not self._stop.is_set():
            endpoint = self._endpoint_provider()
            if endpoint is None:
                self._set_status("not_configured", "Keine Home-Assistant-Verbindung konfiguriert")
                await self._sleep(10)
                continue
            self.status.endpoint = endpoint.label or endpoint.ws_url
            self._set_status("connecting")
            try:
                await self._connect_and_listen(endpoint)
                attempt = 0
            except HAAuthError as err:
                self._set_status("auth_failed", str(err))
                attempt = min(attempt + 1, len(BACKOFF) - 1)
                await self._sleep(60)
                continue
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError, HAError) as err:
                self._set_status("error", f"{type(err).__name__}: {err}")
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001
                log.exception("Unexpected HA client error")
                self._set_status("error", f"{type(err).__name__}: {err}")
            finally:
                self._fail_pending()
            if self._stop.is_set():
                break
            if self.status.state == "connected":
                self._set_status("disconnected", "Verbindung getrennt")
            delay = BACKOFF[min(attempt, len(BACKOFF) - 1)]
            attempt += 1
            self.status.reconnects += 1
            log.info("Reconnecting to Home Assistant in %ss", delay)
            await self._sleep(delay)
        self._set_status("disconnected")

    async def _sleep(self, seconds: float) -> None:
        self._restart.clear()
        try:
            await asyncio.wait_for(self._restart.wait(), seconds)
        except asyncio.TimeoutError:
            pass

    def _fail_pending(self) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(HAError("Verbindung zu Home Assistant getrennt"))
        self._pending.clear()

    async def _connect_and_listen(self, ep: Endpoint) -> None:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        ssl = None if ep.verify_ssl else False
        async with self._session.ws_connect(ep.ws_url, heartbeat=30, ssl=ssl, max_msg_size=0,
                                            timeout=aiohttp.ClientWSTimeout(ws_close=10)) as ws:
            self._ws = ws
            msg = await asyncio.wait_for(ws.receive_json(), 15)
            if msg.get("type") != "auth_required":
                raise HAError(f"Unerwartete Antwort: {msg}")
            self.status.ha_version = msg.get("ha_version")
            await ws.send_json({"type": "auth", "access_token": ep.token})
            msg = await asyncio.wait_for(ws.receive_json(), 15)
            if msg.get("type") == "auth_invalid":
                raise HAAuthError(msg.get("message") or "Authentifizierung fehlgeschlagen")
            if msg.get("type") != "auth_ok":
                raise HAError(f"Unerwartete Antwort: {msg}")
            self.status.ha_version = msg.get("ha_version", self.status.ha_version)
            # feature flag: coalesce messages
            reader = asyncio.create_task(self._reader(ws))
            try:
                await self._on_connected()
                for cb in list(self.connect_listeners):
                    try:
                        await cb()
                    except Exception:  # noqa: BLE001
                        log.exception("connect listener failed")
                # only report "connected" once initial sync (states, backfill start) is done
                self._set_status("connected")
                await reader
            finally:
                if not reader.done():
                    reader.cancel()
                self._ws = None

    async def _reader(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for raw in ws:
            if raw.type == aiohttp.WSMsgType.TEXT:
                data = json.loads(raw.data)
                for msg in data if isinstance(data, list) else [data]:
                    await self._handle(msg)
            elif raw.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSING):
                break

    async def _handle(self, msg: dict) -> None:
        mtype = msg.get("type")
        if mtype == "result" or mtype == "pong":
            fut = self._pending.pop(msg.get("id"), None)
            if fut and not fut.done():
                if mtype == "pong" or msg.get("success"):
                    fut.set_result(msg.get("result"))
                else:
                    err = msg.get("error") or {}
                    fut.set_exception(HAError(f"{err.get('code')}: {err.get('message')}"))
        elif mtype == "event":
            event = msg.get("event", {})
            self.status.last_event = time.time()
            self.status.events_received += 1
            etype = event.get("event_type")
            if etype == "state_changed":
                data = event.get("data", {})
                entity_id = data.get("entity_id")
                new = data.get("new_state")
                old = data.get("old_state")
                if new is None:
                    self.states.pop(entity_id, None)
                else:
                    self.states[entity_id] = new
                for cb in list(self.state_listeners):
                    try:
                        res = cb(entity_id, new, old)
                        if asyncio.iscoroutine(res):
                            await res
                    except Exception:  # noqa: BLE001
                        log.exception("state listener failed")
            elif etype in {"area_registry_updated", "device_registry_updated", "entity_registry_updated"}:
                asyncio.create_task(self._safe_refresh_registry())

    async def _safe_refresh_registry(self) -> None:
        try:
            await self.refresh_registry()
        except Exception:  # noqa: BLE001
            log.debug("registry refresh failed", exc_info=True)

    async def _on_connected(self) -> None:
        self.config = await self.call("get_config") or {}
        states = await self.call("get_states") or []
        self.states = {s["entity_id"]: s for s in states}
        await self._safe_refresh_registry()
        for event_type in ("state_changed", "area_registry_updated", "device_registry_updated", "entity_registry_updated"):
            await self.call("subscribe_events", event_type=event_type)

    async def refresh_registry(self) -> None:
        areas = await self.call("config/area_registry/list") or []
        devices = await self.call("config/device_registry/list") or []
        entities = await self.call("config/entity_registry/list") or []
        self.registry = Registry(
            areas={a["area_id"]: a for a in areas},
            devices={d["id"]: d for d in devices},
            entities={e["entity_id"]: e for e in entities},
        )

    # ------------------------------------------------------------------ commands

    async def call(self, command: str, timeout: float = 60, **payload: Any) -> Any:
        if command not in READ_ONLY_COMMANDS:
            raise PermissionError(f"Befehl '{command}' ist nicht erlaubt (nur lesender Zugriff)")
        if command == "subscribe_events" and payload.get("event_type") not in ALLOWED_EVENTS:
            raise PermissionError("Event-Typ nicht erlaubt")
        ws = self._ws
        if ws is None or ws.closed:
            raise HAError("Keine Verbindung zu Home Assistant")
        self._msg_id += 1
        msg_id = self._msg_id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        await ws.send_json({"id": msg_id, "type": command, **payload})
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg_id, None)

    async def control_tv(self, service: str, entity_id: str, data: dict | None = None, timeout: float = 30) -> Any:
        """Narrow exception to the read-only rule (see ALLOWED_CONTROL). Callers must check that the
        user enabled TV control and linked this entity."""
        if ("media_player", service) not in ALLOWED_CONTROL:
            raise PermissionError(f"Aktion media_player.{service} ist nicht erlaubt")
        if not entity_id.startswith("media_player.") or "," in entity_id:
            raise PermissionError("Nur einzelne media_player-Entitäten")
        data = dict(data or {})
        if service == "play_media":
            ctype, cid = data.get("media_content_type"), str(data.get("media_content_id") or "")
            # allowed: open the dashboard URL in the browser, or start the TV's browser app itself
            if not (ctype == "browser" or (ctype == "app" and cid in BROWSER_APP_IDS)):
                raise PermissionError("Nur das Öffnen des Dashboards im Browser des Fernsehers ist erlaubt")
        ws = self._ws
        if ws is None or ws.closed:
            raise HAError("Keine Verbindung zu Home Assistant")
        self._msg_id += 1
        msg_id = self._msg_id
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        log.info("TV-Steuerung: media_player.%s für %s", service, entity_id)
        await ws.send_json({"id": msg_id, "type": "call_service", "domain": "media_player", "service": service,
                            "target": {"entity_id": entity_id}, "service_data": data})
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg_id, None)

    # ------------------------------------------------------------------ helpers

    def state_of(self, entity_id: str) -> dict | None:
        """State of a real entity, or a synthetic state for attribute-based virtual entities."""
        from . import virtual

        if virtual.is_virtual(entity_id):
            return virtual.synthetic_state(entity_id, self.states.get(virtual.split(entity_id)[0]))
        return self.states.get(entity_id)

    def area_of(self, entity_id: str) -> tuple[str | None, str | None]:
        """Return (area name, device name) via entity/device registry."""
        entity_id = entity_id.split("::", 1)[0]
        ent = self.registry.entities.get(entity_id) or {}
        device = self.registry.devices.get(ent.get("device_id") or "") or {}
        area_id = ent.get("area_id") or device.get("area_id")
        area = self.registry.areas.get(area_id or "") or {}
        dev_name = device.get("name_by_user") or device.get("name")
        return area.get("name"), dev_name

    async def history(self, entity_ids: list[str], start: float, end: float) -> dict[str, list[tuple[float, Any, dict]]]:
        """Raw state history: {entity_id: [(ts, state, attributes)]}.

        Virtual attribute entities (``climate.x::temperature``) are resolved from the
        history of their base entity (requested with full attributes)."""
        from . import virtual

        virt = [e for e in entity_ids if virtual.is_virtual(e) and virtual.definition(e)]
        real = [e for e in entity_ids if not virtual.is_virtual(e)]  # archives (no definition) are skipped
        out: dict[str, list[tuple[float, Any, dict]]] = {}
        if real:
            out.update(await self._history(real, start, end, minimal=True))
        if virt:
            bases = sorted({virtual.split(e)[0] for e in virt})
            base_hist = await self._history(bases, start, end, minimal=False)
            for e in virt:
                base, attr = virtual.split(e)
                d = virtual.definition(e) or {}
                out[e] = [(ts, virtual.value_from(attr, st, attrs), {"unit_of_measurement": d.get("unit")})
                          for ts, st, attrs in base_hist.get(base, [])]
        return out

    async def _history(self, entity_ids: list[str], start: float, end: float,
                       minimal: bool) -> dict[str, list[tuple[float, Any, dict]]]:
        res = await self.call(
            "history/history_during_period",
            timeout=180,
            start_time=datetime.fromtimestamp(start, timezone.utc).isoformat(),
            end_time=datetime.fromtimestamp(end, timezone.utc).isoformat(),
            entity_ids=entity_ids,
            minimal_response=minimal,
            no_attributes=False,
            significant_changes_only=False,
            include_start_time_state=True,
        ) or {}
        out: dict[str, list[tuple[float, Any, dict]]] = {}
        for eid, items in res.items():
            series = []
            attrs: dict = {}
            for item in items:
                if "a" in item:
                    attrs = item["a"] or attrs
                elif "attributes" in item:
                    attrs = item["attributes"] or attrs
                ts = parse_ha_time(item.get("lu") or item.get("lc") or item.get("last_updated") or item.get("last_changed"))
                state = item.get("s", item.get("state"))
                if ts is None:
                    continue
                series.append((ts, state, attrs))
            out[eid] = series
        return out

    async def statistics(self, statistic_ids: list[str], start: float, end: float, period: str = "hour") -> dict[str, list[dict]]:
        res = await self.call(
            "recorder/statistics_during_period",
            timeout=180,
            start_time=datetime.fromtimestamp(start, timezone.utc).isoformat(),
            end_time=datetime.fromtimestamp(end, timezone.utc).isoformat(),
            statistic_ids=statistic_ids,
            period=period,
            types=["mean", "min", "max", "sum", "state", "change"],
        ) or {}
        out: dict[str, list[dict]] = {}
        for sid, rows in res.items():
            clean = []
            for r in rows:
                ts = parse_ha_time(r.get("start"))
                if ts is None:
                    continue
                clean.append({**r, "start": ts})
            out[sid] = clean
        return out

    async def statistics_metadata(self, statistic_ids: list[str]) -> dict[str, dict]:
        res = await self.call("recorder/get_statistics_metadata", statistic_ids=statistic_ids) or []
        return {r["statistic_id"]: r for r in res}
