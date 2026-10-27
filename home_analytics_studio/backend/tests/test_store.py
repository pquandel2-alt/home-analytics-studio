"""Storage: ingest, duplicates, units, rollups, retention, queries, HA statistics import."""
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import text

from has.core.store import detect_kind, parse_state_value

DAY = 86400
H = 3600


def _record(store, eid="sensor.energy", unit="kWh", sc="total_increasing", dc="energy"):
    attrs = {"unit_of_measurement": unit, "state_class": sc, "device_class": dc, "friendly_name": eid}
    store.set_recording([eid], True, {eid: attrs})
    return store.get(eid), attrs


def test_parse_state_value():
    assert parse_state_value("12.5") == 12.5
    assert parse_state_value("unavailable") is None
    assert parse_state_value("unknown") is None
    assert parse_state_value("on") == 1.0
    assert parse_state_value("nan") is None


def test_detect_kind():
    assert detect_kind("total_increasing", None, "kWh") == "counter"
    assert detect_kind("measurement", "power", "W") == "measurement"
    assert detect_kind(None, "energy", "Wh") == "counter"
    assert detect_kind("total", "monetary", "EUR") == "total"


def test_ingest_dedupe_and_flush(store):
    info, attrs = _record(store)
    t0 = time.time() - 100
    assert store.add_state("sensor.energy", "10", attrs, t0)
    assert not store.add_state("sensor.energy", "10", attrs, t0)  # duplicate timestamp
    assert not store.add_state("sensor.energy", "10", attrs, t0 + 5)  # unchanged value
    assert store.add_state("sensor.energy", "11", attrs, t0 + 10)
    assert store.flush() == 2
    rows = store.raw_samples(info.id, int(t0) - 1, int(t0) + 20)
    assert [r[1] for r in rows] == [10.0, 11.0]
    # inserting the same rows again (e.g. backfill) does not duplicate
    assert store.insert_samples(info.id, [(int(round(t0 * 1000)), 10.0)]) == 0


def test_not_recorded_entities_are_not_stored(store):
    store.ensure_entity("sensor.live_only", {"unit_of_measurement": "W"})
    assert not store.add_state("sensor.live_only", "5", {}, time.time())


def test_unit_conversion_on_ingest(store):
    info, attrs = _record(store, unit="kWh")
    t0 = time.time() - 100
    store.add_state("sensor.energy", "1.5", attrs, t0)
    store.add_state("sensor.energy", "2500", {**attrs, "unit_of_measurement": "Wh"}, t0 + 10)
    store.flush()
    vals = [r[1] for r in store.raw_samples(info.id, int(t0) - 1, int(t0) + 20)]
    assert vals == [1.5, 2.5]


def test_rollup_and_query_consistency(store):
    info, attrs = _record(store)
    now = time.time()
    start = int(now // H * H) - 3 * DAY
    rows = [((start + i * 600) * 1000, 100 + i * 0.1) for i in range(3 * 144)]
    store.insert_samples(info.id, rows)
    store.rollup(now)
    with store.db.read() as conn:
        n5 = conn.execute(text("SELECT COUNT(*) FROM stats_5m WHERE entity_ref=:e"), {"e": info.id}).scalar()
        n1 = conn.execute(text("SELECT COUNT(*) FROM stats_1h WHERE entity_ref=:e"), {"e": info.id}).scalar()
    assert n5 > 0 and n1 > 0
    # consumption over 2 days from hourly rollups equals raw difference
    a, b = start + 3600, start + 2 * DAY + 3600
    hourly = store.query_edges(info, [a, b], now=now)
    raw_delta = 0.1 * ((b - a) // 600)
    assert abs(hourly[0].delta - raw_delta) < 1e-6
    # same result from fine (raw) path
    fine = store.query(info, a, a + DAY, "5min", "UTC", now=now)
    assert abs(sum(x.delta or 0 for x in fine) - 0.1 * 144) < 1e-6


def test_counter_reset_survives_rollup(store):
    info, attrs = _record(store)
    now = time.time()
    t = int(now // H * H) - 4 * H
    rows = [(t * 1000, 50.0), ((t + 600) * 1000, 52.0), ((t + 1200) * 1000, 0.5), ((t + 1800) * 1000, 1.5)]
    store.insert_samples(info.id, rows)
    store.rollup(now)
    res = store.query_edges(info, [t, t + 2 * H], now=now)
    assert abs(res[0].delta - (2.0 + 0.5 + 1.0)) < 1e-9


def test_dst_daily_buckets_sum_matches(store):
    info, attrs = _record(store, eid="sensor.e2")
    tz = ZoneInfo("Europe/Berlin")
    start = int(datetime(2026, 10, 24, tzinfo=tz).timestamp())
    end = int(datetime(2026, 10, 27, tzinfo=tz).timestamp())
    rows = [((start + i * 900) * 1000, i * 1.0) for i in range((end - start) // 900 + 1)]
    store.insert_samples(info.id, rows)
    store.rollup(end + DAY)
    days = store.query(info, start, end, "1d", "Europe/Berlin", now=end + DAY)
    deltas = [d.delta for d in days]
    # 1 kWh per 15 min. The very first reading is only the baseline (no consumption),
    # so day 1 has 95 deltas; the 25 h DST day has 100 and a normal day 96.
    assert deltas == [95.0, 100.0, 96.0]


def test_retention_keeps_rollups_and_last_sample(store, settings):
    info, attrs = _record(store, eid="sensor.t", unit="°C", sc="measurement", dc="temperature")
    now = time.time()
    old = int(now - 20 * DAY)
    rows = [((old + i * 3600) * 1000, 20.0 + (i % 5)) for i in range(24 * 15)]
    store.insert_samples(info.id, rows)
    store.rollup(now)
    settings.update("storage", {"raw_retention_days": 7})
    removed = store.apply_retention(now)
    assert removed["samples"] > 0
    with store.db.read() as conn:
        oldest = conn.execute(text("SELECT MIN(ts) FROM samples WHERE entity_ref=:e"), {"e": info.id}).scalar()
        hourly_old = conn.execute(text("SELECT COUNT(*) FROM stats_1h WHERE entity_ref=:e AND ts<:c"),
                                  {"e": info.id, "c": int(now - 7 * DAY)}).scalar()
    assert oldest / 1000 < now - 7 * DAY  # one carry-in sample is kept
    assert hourly_old > 0
    # mean over old period still answerable from hourly stats
    res = store.query(info, old, old + 2 * DAY, "1d", "UTC", now=now)
    assert any(b.mean is not None for b in res)


def test_import_hourly_statistics_never_overwrites_local(store):
    info, attrs = _record(store)
    now = time.time()
    t = int(now // H * H) - 10 * H
    store.insert_samples(info.id, [(t * 1000, 1.0), ((t + 1800) * 1000, 2.0), ((t + 3500) * 1000, 3.0)])
    store.rollup(now)
    rows = [{"ts": t - H, "mean": None, "min": None, "max": None, "first": None, "last": None, "delta": 5.0, "count": 0, "covered": 3600.0},
            {"ts": t, "mean": None, "min": None, "max": None, "first": None, "last": None, "delta": 99.0, "count": 0, "covered": 3600.0}]
    assert store.import_hourly_statistics(info.id, rows) == 1
    with store.db.read() as conn:
        src = dict(conn.execute(text("SELECT ts, source FROM stats_1h WHERE entity_ref=:e"), {"e": info.id}).all())
    assert src[t - H] == "ha" and src[t] == "local"


def test_kind_change_recomputes_rollups(store):
    info, attrs = _record(store, eid="sensor.x", unit="kWh", sc="measurement", dc=None)
    assert info.kind == "measurement"
    now = time.time()
    t = int(now // H * H) - 5 * H
    store.insert_samples(info.id, [(t * 1000, 1.0), ((t + 600) * 1000, 4.0)])
    store.rollup(now)
    store.configure("sensor.x", kind="counter")
    store.rollup(now)
    res = store.query_edges(store.get("sensor.x"), [t, t + 2 * H], now=now)
    assert abs(res[0].delta - 3.0) < 1e-9


def test_disk_check_pauses_recording(store, settings):
    settings.update("storage", {"min_free_disk_mb": 10 ** 9})
    st = store.check_disk()
    assert st["paused"]
    info, attrs = _record(store)
    assert not store.add_state("sensor.energy", "1", attrs, time.time())
    settings.update("storage", {"min_free_disk_mb": 0})
    store.check_disk()
    assert store.add_state("sensor.energy", "1", attrs, time.time())


def test_plausibility_limit_ignores_jumps_and_is_reversible(store):
    info, attrs = _record(store, eid="sensor.meter2")
    now = time.time()
    t = int(now // H * H) - 30 * H
    rows = [((t + i * 3600) * 1000, 100.0 + i) for i in range(10)]           # 1 kWh/h
    rows += [((t + 10 * 3600) * 1000, 2200.0)]                               # reader back after outage: +2091
    rows += [((t + (11 + i) * 3600) * 1000, 2201.0 + i) for i in range(5)]
    store.insert_samples(info.id, rows)
    store.rollup(now)
    rng = [t, t + 16 * H]
    assert store.query_edges(store.get("sensor.meter2"), rng, now=now)[0].delta > 2000
    store.configure("sensor.meter2", max_rate=20)
    limited = store.query_edges(store.get("sensor.meter2"), rng, now=now)[0].delta
    assert abs(limited - 14.0) < 1e-6   # 9 + 5 regular kWh, jump ignored
    # long range served from hourly rollups is filtered as well
    days = store.query_edges(store.get("sensor.meter2"), [t - 5 * 86400, t + 16 * H], now=now)[0].delta
    assert abs(days - 14.0) < 1e-6
    store.configure("sensor.meter2", max_rate=None)
    assert store.query_edges(store.get("sensor.meter2"), rng, now=now)[0].delta > 2000
