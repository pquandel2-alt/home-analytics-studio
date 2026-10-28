"""Minimal Home Assistant WebSocket API simulator for integration tests and local development.

It implements auth, get_states/get_config, registries, subscribe_events,
history/history_during_period and recorder statistics. Test code can push
state changes and drop connections to test reconnects.

Run standalone:  python -m tests.mock_ha --port 8123 --token test
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import time
from datetime import datetime, timezone

from aiohttp import WSMsgType, web


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


class MockHA:
    def __init__(self, token: str = "test-token", tz: str = "Europe/Berlin"):
        self.token = token
        self.tz = tz
        self.states: dict[str, dict] = {}
        self.history: dict[str, list[tuple[float, str, dict]]] = {}
        self.statistics: dict[str, list[dict]] = {}
        self.stat_meta: dict[str, dict] = {}
        self.clients: set[web.WebSocketResponse] = set()
        self.subscriptions: dict[web.WebSocketResponse, dict[int, str]] = {}
        self.received: list[dict] = []
        self.service_calls: list[dict] = []
        self.on_service = None
        self.areas = [{"area_id": "wohnzimmer", "name": "Wohnzimmer"}, {"area_id": "keller", "name": "Keller"}]
        self.devices = [{"id": "dev1", "name": "Stromzähler", "area_id": "keller"},
                        {"id": "dev2", "name": "Klimasensor", "area_id": "wohnzimmer"}]
        self.entity_registry: list[dict] = []
        self.runner: web.AppRunner | None = None
        self.port: int | None = None

    # ------------------------------------------------------------------ state helpers

    def set_state(self, entity_id: str, state, attributes: dict | None = None, ts: float | None = None,
                  device_id: str | None = None, record_history: bool = True) -> dict:
        ts = time.time() if ts is None else ts
        old = self.states.get(entity_id)
        attrs = dict(attributes if attributes is not None else (old or {}).get("attributes", {}))
        new = {"entity_id": entity_id, "state": str(state), "attributes": attrs,
               "last_changed": iso(ts), "last_updated": iso(ts), "context": {"id": "x"}}
        self.states[entity_id] = new
        if record_history:
            self.history.setdefault(entity_id, []).append((ts, str(state), attrs))
        if device_id and not any(e["entity_id"] == entity_id for e in self.entity_registry):
            self.entity_registry.append({"entity_id": entity_id, "device_id": device_id, "area_id": None})
        return {"entity_id": entity_id, "old_state": old, "new_state": new}

    async def push_state(self, entity_id: str, state, attributes: dict | None = None, ts: float | None = None) -> None:
        data = self.set_state(entity_id, state, attributes, ts)
        for ws, subs in list(self.subscriptions.items()):
            for sub_id, event_type in subs.items():
                if event_type == "state_changed":
                    try:
                        await ws.send_json({"id": sub_id, "type": "event", "event": {
                            "event_type": "state_changed", "data": data, "time_fired": iso(time.time()), "origin": "LOCAL"}})
                    except ConnectionResetError:
                        pass

    async def drop_connections(self) -> None:
        for ws in list(self.clients):
            await ws.close()

    def seed_demo(self, days: int = 3) -> None:
        """Realistic test data for local development (energy meter, power, temperature)."""
        now = time.time()
        energy = 12000.0
        start = now - days * 86400
        t = start
        temp_attrs = {"unit_of_measurement": "°C", "device_class": "temperature", "state_class": "measurement",
                      "friendly_name": "Wohnzimmer Temperatur"}
        e_attrs = {"unit_of_measurement": "kWh", "device_class": "energy", "state_class": "total_increasing",
                   "friendly_name": "Hausverbrauch Zähler"}
        p_attrs = {"unit_of_measurement": "W", "device_class": "power", "state_class": "measurement",
                   "friendly_name": "Hausleistung"}
        while t < now:
            hour = datetime.fromtimestamp(t).hour
            power = 250 + 900 * math.exp(-((hour - 19) ** 2) / 6) + 400 * math.exp(-((hour - 7) ** 2) / 2) + random.uniform(0, 80)
            energy += power * 600 / 3600 / 1000
            temp = 20.5 + 1.5 * math.sin((hour - 9) / 24 * 2 * math.pi) + random.uniform(-0.1, 0.1)
            self.set_state("sensor.house_energy", round(energy, 3), e_attrs, t, "dev1")
            self.set_state("sensor.house_power", round(power, 1), p_attrs, t, "dev1")
            self.set_state("sensor.living_temperature", round(temp, 2), temp_attrs, t, "dev2")
            t += 600
        self.set_state("sensor.living_humidity", 48, {"unit_of_measurement": "%", "device_class": "humidity",
                                                      "state_class": "measurement", "friendly_name": "Luftfeuchte"}, now, "dev2")
        self.set_state("light.kitchen", "on", {"friendly_name": "Küchenlicht"}, now)
        self.set_state("sensor.solar_power", 0, {"unit_of_measurement": "W", "device_class": "power",
                                                 "state_class": "measurement", "friendly_name": "PV-Leistung"}, now)
        self.set_state("sensor.grid_import", 0, {"unit_of_measurement": "W", "device_class": "power",
                                                 "state_class": "measurement", "friendly_name": "Netzbezug"}, now)
        self.set_state("sensor.battery_soc", 64, {"unit_of_measurement": "%", "device_class": "battery",
                                                  "state_class": "measurement", "friendly_name": "Batterie SoC"}, now)

    # ------------------------------------------------------------------ server

    async def start(self, port: int = 0, host: str = "127.0.0.1") -> int:
        app = web.Application()
        app.router.add_get("/api/websocket", self._ws)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, host, port)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        return self.port

    async def stop(self) -> None:
        await self.drop_connections()
        if self.runner:
            await self.runner.cleanup()

    async def _ws(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        await ws.send_json({"type": "auth_required", "ha_version": "2026.10.0"})
        msg = await ws.receive_json()
        if msg.get("type") != "auth" or msg.get("access_token") != self.token:
            await ws.send_json({"type": "auth_invalid", "message": "Invalid access token or password"})
            await ws.close()
            return ws
        await ws.send_json({"type": "auth_ok", "ha_version": "2026.10.0"})
        self.clients.add(ws)
        self.subscriptions[ws] = {}
        try:
            async for raw in ws:
                if raw.type != WSMsgType.TEXT:
                    break
                msg = json.loads(raw.data)
                self.received.append(msg)
                await self._handle(ws, msg)
        finally:
            self.clients.discard(ws)
            self.subscriptions.pop(ws, None)
        return ws

    async def _result(self, ws, msg_id, result=None, success=True, error=None) -> None:
        payload = {"id": msg_id, "type": "result", "success": success, "result": result}
        if error:
            payload["error"] = error
        await ws.send_json(payload)

    async def _handle(self, ws, msg: dict) -> None:
        mid = msg.get("id")
        t = msg.get("type")
        if t == "get_states":
            await self._result(ws, mid, list(self.states.values()))
        elif t == "get_config":
            await self._result(ws, mid, {"time_zone": self.tz, "location_name": "Testhaus", "version": "2026.10.0",
                                         "unit_system": {"temperature": "°C"}})
        elif t == "config/area_registry/list":
            await self._result(ws, mid, self.areas)
        elif t == "config/device_registry/list":
            await self._result(ws, mid, self.devices)
        elif t == "config/entity_registry/list":
            await self._result(ws, mid, self.entity_registry)
        elif t == "subscribe_events":
            self.subscriptions[ws][mid] = msg.get("event_type")
            await self._result(ws, mid, None)
        elif t == "ping":
            await ws.send_json({"id": mid, "type": "pong"})
        elif t == "history/history_during_period":
            start = datetime.fromisoformat(msg["start_time"]).timestamp()
            end = datetime.fromisoformat(msg["end_time"]).timestamp()
            out = {}
            for eid in msg.get("entity_ids", []):
                items = self.history.get(eid, [])
                before = [x for x in items if x[0] < start]
                inside = [x for x in items if start <= x[0] < end]
                rows = []
                if before and msg.get("include_start_time_state", True):
                    ts, st, attrs = before[-1]
                    rows.append({"s": st, "a": attrs, "lu": start})
                for i, (ts, st, attrs) in enumerate(inside):
                    row = {"s": st, "lu": ts}
                    if (not rows and i == 0) or not msg.get("minimal_response", True):
                        row["a"] = attrs
                    rows.append(row)
                if rows:
                    out[eid] = rows
            await self._result(ws, mid, out)
        elif t == "recorder/get_statistics_metadata":
            ids = msg.get("statistic_ids") or list(self.stat_meta)
            await self._result(ws, mid, [self.stat_meta[i] for i in ids if i in self.stat_meta])
        elif t == "recorder/statistics_during_period":
            start = datetime.fromisoformat(msg["start_time"]).timestamp()
            end = datetime.fromisoformat(msg["end_time"]).timestamp()
            out = {}
            for sid in msg.get("statistic_ids", []):
                rows = [r for r in self.statistics.get(sid, []) if start <= r["start"] / 1000 < end]
                if rows:
                    out[sid] = rows
            await self._result(ws, mid, out)
        elif t == "call_service":
            self.service_calls.append(msg)
            eid = (msg.get("target") or {}).get("entity_id")
            if msg.get("service") == "turn_on" and eid in self.states:
                await self.push_state(eid, "on")
            err = await self.on_service(msg) if self.on_service else None
            if err:
                await self._result(ws, mid, None, False, {"code": "home_assistant_error", "message": err})
            else:
                await self._result(ws, mid, {"context": {"id": "x"}})
        else:
            await self._result(ws, mid, None, False, {"code": "unknown_command", "message": f"Unknown command {t}"})


async def _main(port: int, token: str, days: int) -> None:
    ha = MockHA(token)
    ha.seed_demo(days)
    await ha.start(port, "0.0.0.0")
    print(f"Mock HA on ws://0.0.0.0:{port}/api/websocket token={token}", flush=True)
    while True:
        await asyncio.sleep(10)
        p = ha.states["sensor.house_power"]
        val = max(50.0, float(p["state"]) + random.uniform(-60, 60))
        e = float(ha.states["sensor.house_energy"]["state"]) + val * 10 / 3600 / 1000
        await ha.push_state("sensor.house_power", round(val, 1))
        await ha.push_state("sensor.house_energy", round(e, 4))
        hour = datetime.now().hour
        solar = max(0.0, 3500 * math.sin((hour - 6) / 14 * math.pi)) if 6 <= hour <= 20 else 0.0
        await ha.push_state("sensor.solar_power", round(solar + random.uniform(0, 50), 0))
        await ha.push_state("sensor.grid_import", round(max(0.0, val - solar), 0))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--token", default="test")
    ap.add_argument("--days", type=int, default=3)
    a = ap.parse_args()
    asyncio.run(_main(a.port, a.token, a.days))
