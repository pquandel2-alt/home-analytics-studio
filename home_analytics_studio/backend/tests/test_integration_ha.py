"""End-to-end with the Home Assistant simulator: connect, live recording,
read-only guarantee, reconnect + gap backfill, history/statistics import."""
import asyncio
import time

import pytest

from has.ha.client import READ_ONLY_COMMANDS, HAClient
from has.ha.importer import import_history, import_statistics
from has.services import Services
from tests.mock_ha import MockHA

pytestmark = pytest.mark.asyncio

E_ATTRS = {"unit_of_measurement": "kWh", "state_class": "total_increasing", "device_class": "energy", "friendly_name": "Zähler"}


async def wait_for(cond, timeout=10.0, step=0.05):
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond():
            return True
        await asyncio.sleep(step)
    return False


@pytest.fixture
async def env(config):
    ha = MockHA(token="tok")
    now = time.time()
    for i in range(48):
        ha.set_state("sensor.meter", 100 + i, E_ATTRS, now - (48 - i) * 1800, "dev1")
    ha.set_state("sensor.temp", 21.5, {"unit_of_measurement": "°C", "state_class": "measurement", "friendly_name": "Temp"}, now - 60, "dev2")
    port = await ha.start()
    config.ha_url = f"http://127.0.0.1:{port}"
    config.ha_token = "tok"
    svc = Services(config)
    svc.settings.update("storage", {"flush_interval_seconds": 1})
    await svc.start()
    assert await svc.ha.wait_connected(10)
    yield svc, ha
    await svc.stop()
    svc.db.dispose()
    await ha.stop()


async def test_connect_and_metadata(env):
    svc, ha = env
    assert "sensor.meter" in svc.ha.states
    assert svc.ha.config["time_zone"] == "Europe/Berlin"
    area, device = svc.ha.area_of("sensor.meter")
    assert area == "Keller" and device == "Stromzähler"
    assert svc.engine.tz_name() == "Europe/Berlin"


async def test_live_recording_and_websocket_publish(env):
    svc, ha = env
    published = []
    svc.recorder.live_publish = lambda eid, st: published.append((eid, st and st["state"]))
    svc.store.set_recording(["sensor.meter"], True, {"sensor.meter": E_ATTRS})
    await ha.push_state("sensor.meter", 200.5)
    await ha.push_state("sensor.temp", 22.0)  # not recorded: only live
    assert await wait_for(lambda: svc.store.get("sensor.meter").last_value == 200.5, 5)
    assert ("sensor.temp", "22.0") in published
    assert svc.store.get("sensor.temp") is None or not svc.store.get("sensor.temp").recorded


async def test_client_is_read_only(env):
    svc, ha = env
    with pytest.raises(PermissionError):
        await svc.ha.call("call_service", domain="light", service="turn_on")
    with pytest.raises(PermissionError):
        await svc.ha.call("subscribe_events", event_type="call_service")
    sent = {m["type"] for m in ha.received}
    assert sent <= READ_ONLY_COMMANDS
    assert "call_service" not in sent


async def test_reconnect_and_gap_backfill(env):
    svc, ha = env
    svc.store.set_recording(["sensor.meter"], True, {"sensor.meter": E_ATTRS})
    await ha.push_state("sensor.meter", 300)
    assert await wait_for(lambda: svc.store.get("sensor.meter").last_value == 300, 5)
    svc.store.flush()
    reconnects = svc.ha.status.reconnects
    # connection drops; meanwhile HA records new states we never receive live
    await ha.drop_connections()
    assert await wait_for(lambda: svc.ha.status.state != "connected", 5)
    t_gap = time.time()
    ha.set_state("sensor.meter", 301, None, t_gap)
    ha.set_state("sensor.meter", 302, None, t_gap + 0.5)
    # pretend last data point is older so a backfill is triggered
    info = svc.store.get("sensor.meter")
    from sqlalchemy import text as sql
    with svc.db.write() as conn:
        conn.execute(sql("UPDATE entities SET last_ts=:t WHERE id=:e"), {"t": int((t_gap - 300) * 1000), "e": info.id})
    info.last_ts = int((t_gap - 300) * 1000)
    assert await wait_for(lambda: svc.ha.connected, 15)
    assert svc.ha.status.reconnects > reconnects
    assert svc.recorder.backfill_job is not None
    job = await svc.jobs.wait(svc.recorder.backfill_job, 15)
    assert job["status"] == "done"
    rows = svc.store.raw_samples(info.id, int(t_gap) - 1, int(t_gap) + 5)
    assert 301.0 in [v for _, v in rows]


async def test_history_import_and_query(env):
    svc, ha = env
    now = time.time()
    res = await import_history(svc.ha, svc.store, ["sensor.meter"], now - 2 * 86400, now)
    assert res["inserted_samples"] >= 47
    total = await svc.engine.scalar({"type": "entity", "id": "sensor.meter"}, {"start": now - 86400 * 2, "end": now})
    assert total["value"] == pytest.approx(47, abs=1)


async def test_statistics_import_converts_units(env):
    svc, ha = env
    base = int(time.time() // 3600 * 3600) - 30 * 86400
    ha.stat_meta["sensor.meter"] = {"statistic_id": "sensor.meter", "statistics_unit_of_measurement": "Wh", "has_sum": True, "has_mean": False}
    ha.statistics["sensor.meter"] = [
        {"start": (base + h * 3600) * 1000, "end": (base + h * 3600 + 3600) * 1000, "sum": 1000.0 * h, "state": 1000.0 * h, "change": 1000.0 if h else None}
        for h in range(48)
    ]
    svc.store.set_recording(["sensor.meter"], True, {"sensor.meter": E_ATTRS})
    res = await import_statistics(svc.ha, svc.store, ["sensor.meter"], base, base + 3 * 86400)
    assert res["imported_hours"] == 47  # first hour has no change/previous sum
    day = await svc.engine.scalar({"type": "entity", "id": "sensor.meter"}, {"start": base + 86400, "end": base + 2 * 86400})
    assert day["value"] == pytest.approx(24.0)  # 24 h x 1000 Wh = 24 kWh


async def test_live_only_entity_uses_ha_history(env):
    svc, ha = env
    now = time.time()
    res = await svc.engine.series({"type": "entity", "id": "sensor.meter"}, {"start": now - 86400, "end": now}, "1h")
    assert any(v is not None for v in res["values"])


async def test_auth_failure_status(config):
    ha = MockHA(token="right")
    port = await ha.start()
    client = HAClient(lambda: __import__("has.ha.client", fromlist=["Endpoint"]).Endpoint(f"ws://127.0.0.1:{port}/api/websocket", "wrong"))
    client.start()
    assert await wait_for(lambda: client.status.state == "auth_failed", 5)
    await client.stop()
    await ha.stop()
