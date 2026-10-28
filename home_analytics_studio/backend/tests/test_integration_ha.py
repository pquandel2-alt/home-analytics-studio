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


async def test_enabling_recording_imports_existing_history(env):
    from has.api.routes_entities import start_initial_import

    svc, ha = env
    now = time.time()
    base = int(now // 3600 * 3600) - 20 * 86400
    ha.stat_meta["sensor.meter"] = {"statistic_id": "sensor.meter", "statistics_unit_of_measurement": "kWh", "has_sum": True}
    ha.statistics["sensor.meter"] = [{"start": (base + h * 3600) * 1000, "sum": float(h), "state": float(h), "change": 1.0 if h else None}
                                     for h in range(24 * 15)]
    svc.store.set_recording(["sensor.meter"], True, {"sensor.meter": E_ATTRS})
    job_id = start_initial_import(svc, ["sensor.meter"])
    job = await svc.jobs.wait(job_id, 30)
    assert job["status"] == "done", job
    assert job["result"]["statistics"]["imported_hours"] > 300
    assert job["result"]["history"]["inserted_samples"] >= 47
    # a day long before recording started now has data (from HA long-term statistics)
    day = await svc.engine.scalar({"type": "entity", "id": "sensor.meter"}, {"start": base + 5 * 86400, "end": base + 6 * 86400})
    assert day["value"] == pytest.approx(24.0)


async def test_thermostat_setpoint_and_heating_share(env):
    """Attribute based virtual series of climate entities: live recording, history import, query."""
    svc, ha = env
    now = time.time()
    attrs = lambda sp, act: {"friendly_name": "Büro", "current_temperature": 20.0, "temperature": sp, "hvac_action": act}
    ha.set_state("climate.buro", "heat", attrs(21.0, "heating"), now - 4 * 3600)
    ha.set_state("climate.buro", "heat", attrs(21.0, "idle"), now - 3 * 3600)      # 1 h heating
    ha.set_state("climate.buro", "heat", attrs(19.0, "idle"), now - 2 * 3600)      # set point lowered
    vid_sp, vid_h = "climate.buro::temperature", "climate.buro::heating"
    st = svc.ha.state_of(vid_sp)
    assert st is None or st["attributes"]["unit_of_measurement"] == "°C"
    await ha.push_state("climate.buro", "heat", attrs(19.0, "idle"))
    assert await wait_for(lambda: svc.ha.state_of(vid_sp) is not None, 5)
    assert svc.ha.state_of(vid_sp)["state"] == "19.0" and svc.ha.state_of(vid_h)["state"] == "0.0"
    # history import of the virtual series
    svc.store.set_recording([vid_sp, vid_h], True, {vid_sp: svc.ha.state_of(vid_sp)["attributes"], vid_h: svc.ha.state_of(vid_h)["attributes"]})
    res = await import_history(svc.ha, svc.store, [vid_sp, vid_h], now - 5 * 3600, now)
    assert res["inserted_samples"] >= 4
    share = await svc.engine.scalar({"type": "entity", "id": vid_h}, {"start": now - 4 * 3600, "end": now - 2 * 3600})
    assert share["value"] == pytest.approx(50.0, abs=1)      # heating 1 h of 2 h
    sp = await svc.engine.series({"type": "entity", "id": vid_sp, "stat": "state"}, {"start": now - 4 * 3600, "end": now}, "1h")
    vals = [round(v) for v in sp["values"] if v is not None]
    assert vals[0] == 21 and 19 in vals and vals.index(19) > 0   # set point lowered from 21 to 19 (hour alignment varies)
    # live attribute change is recorded
    await ha.push_state("climate.buro", "heat", attrs(22.5, "heating"))
    assert await wait_for(lambda: svc.store.get(vid_sp).last_value == 22.5, 5)
    assert svc.store.get(vid_h).last_value == 100.0


async def test_tv_launch_only_when_enabled_and_strictly_limited(env):
    """Opt-in TV control: turn on + open dashboard URL; nothing else is possible."""
    from has.core import tv_launch

    svc, ha = env
    ha.set_state("media_player.tv", "off", {"friendly_name": "TV", "can_launch_apps": True, "can_power_on": True})
    await ha.push_state("media_player.tv", "off")
    svc.ha.config["internal_url"] = "http://192.168.178.101:8123"
    svc.config.direct_port = 8100
    d = svc.displays.add_tv("Wohnzimmer-TV", "media_player.tv")
    svc.settings.update("displays", {"boot_wait_seconds": 0})
    # disabled by default -> no service call at all
    await tv_launch.launch(svc, d["id"])
    assert ha.service_calls == [] and "nicht aktiviert" in svc.displays.get(d["id"])["last_launch_error"]
    svc.settings.update("displays", {"tv_control_enabled": True})

    async def tv_browser(msg):  # simulated TV: opening the URL connects the display
        if msg["service"] == "play_media":
            token = msg["service_data"]["media_content_id"].split("display=")[1]
            p = svc.displays.principal(token)

            class FakeClient:
                principal = p
                queue = asyncio.Queue()
            svc.live.clients.add(FakeClient())

    ha.on_service = tv_browser
    await tv_launch.launch(svc, d["id"])
    calls = [(c["service"], c["target"]["entity_id"]) for c in ha.service_calls]
    assert calls == [("turn_on", "media_player.tv"), ("play_media", "media_player.tv")]
    url = ha.service_calls[1]["service_data"]["media_content_id"]
    assert url.startswith("http://192.168.178.101:8100/tv?display=dsp_") and ha.service_calls[1]["service_data"]["media_content_type"] == "browser"
    assert svc.displays.get(d["id"])["last_launch_error"] is None
    # nothing beyond the two allowed actions
    with pytest.raises(PermissionError):
        await svc.ha.control_tv("volume_set", "media_player.tv", {"volume_level": 1})
    with pytest.raises(PermissionError):
        await svc.ha.control_tv("play_media", "media_player.tv", {"media_content_type": "url", "media_content_id": "http://evil"})
    with pytest.raises(PermissionError):
        await svc.ha.control_tv("turn_on", "light.kitchen")
    with pytest.raises(PermissionError):
        await svc.ha.call("call_service", domain="media_player", service="turn_on")
