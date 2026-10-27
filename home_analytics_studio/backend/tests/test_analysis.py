"""Analysis engine: comparisons, peaks, anomalies, incomplete data, DST robustness."""
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from has.core.analysis import AnalysisEngine, _anomalies, _peak_window, fmt_num, linear_trend, pct_change
from has.core.engine import DataEngine

TZ = ZoneInfo("Europe/Berlin")


def test_helpers():
    assert pct_change(118, 100) == pytest.approx(18)
    assert pct_change(1, 0) is None
    assert fmt_num(1234.5, 1) == "1.234,5"
    slope, _, r2 = linear_trend([1, 2, 3, 4, 5, 6])
    assert slope == pytest.approx(1) and r2 == pytest.approx(1)
    assert _peak_window([0, 3600, 7200, 10800], [1, 5, 6, 1], 2, False) == (3600, 11)


def test_anomaly_needs_relevant_relative_deviation():
    days = [(i, 10.0 + (0.01 if i % 2 else 0)) for i in range(20)]
    days.append((20, 10.4))  # statistically extreme but only 4 % -> not reported
    assert _anomalies(days) == []
    days.append((21, 20.0))
    assert [a[0] for a in _anomalies(days)] == [21]


@pytest.fixture
def engine(db, settings, store):
    settings.update("general", {"timezone": "Europe/Berlin"})
    attrs = {"unit_of_measurement": "kWh", "state_class": "total_increasing"}
    store.set_recording(["sensor.e"], True, {"sensor.e": attrs})
    info = store.get("sensor.e")
    now = int(datetime(2026, 10, 27, 12, tzinfo=TZ).timestamp())
    start = now - 40 * 86400
    rows, v = [], 0.0
    for t in range(start, now, 900):
        hour = datetime.fromtimestamp(t, TZ).hour
        v += 0.5 if 18 <= hour < 20 else 0.1  # evening peak
        rows.append((t * 1000, v))
    store.insert_samples(info.id, rows)
    store.rollup(now)
    return DataEngine(db, store, settings), now


async def test_full_analysis_from_real_data(engine):
    eng, now = engine
    res = await AnalysisEngine(eng).analyze({"type": "entity", "id": "sensor.e"}, days=30, now=now)
    texts = " | ".join(i["text"] for i in res["insights"])
    assert "zwischen 18 und 20 Uhr" in texts
    assert "Höchster Tageswert" in texts
    # no anomaly for the 25 h DST day (2026-10-25)
    assert not any(i["id"].startswith("anomaly") for i in res["insights"]), texts
    day = res["comparisons"]["day"]
    assert day["current"] == pytest.approx(day["previous_same_elapsed"], rel=0.02)


async def test_compare_ranges(engine):
    eng, now = engine
    res = await AnalysisEngine(eng).compare_ranges({"type": "entity", "id": "sensor.e"}, "last_week", {"preset": "last_week", "offset": "-7d"}, now)
    assert res["a"]["value"] == pytest.approx(res["b"]["value"], rel=0.05)
    assert "Zeitraum A" in res["text"]
