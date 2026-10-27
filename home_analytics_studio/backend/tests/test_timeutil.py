"""Time zones and daylight saving time."""
from datetime import datetime
from zoneinfo import ZoneInfo

from has.core.timeutil import add_interval, auto_interval, bucket_edges, floor_local, parse_duration, resolve_range

BERLIN = ZoneInfo("Europe/Berlin")


def ts(y, m, d, h=0, mi=0, tz=BERLIN):
    return int(datetime(y, m, d, h, mi, tzinfo=tz).timestamp())


def test_day_buckets_across_spring_forward_have_23_hours():
    # 2026-03-29 DST starts in Europe/Berlin
    edges = bucket_edges(ts(2026, 3, 28), ts(2026, 3, 31), "1d", BERLIN)
    lengths = [(b - a) / 3600 for a, b in zip(edges, edges[1:])]
    assert lengths[:3] == [24, 23, 24]


def test_day_buckets_across_fall_back_have_25_hours():
    edges = bucket_edges(ts(2026, 10, 24), ts(2026, 10, 27), "1d", BERLIN)
    lengths = [(b - a) / 3600 for a, b in zip(edges, edges[1:])]
    assert lengths[:3] == [24, 25, 24]


def test_hour_buckets_during_fall_back_are_unique_and_hourly():
    start = ts(2026, 10, 25, 0)
    edges = bucket_edges(start, start + 6 * 3600, "1h", BERLIN)
    assert all(b - a == 3600 for a, b in zip(edges, edges[1:]))
    assert len(set(edges)) == len(edges)


def test_month_and_year_floor():
    t = ts(2026, 7, 15, 13, 5)
    assert floor_local(t, "1mo", BERLIN) == ts(2026, 7, 1)
    assert floor_local(t, "1y", BERLIN) == ts(2026, 1, 1)
    assert floor_local(t, "1w", BERLIN) == ts(2026, 7, 13)  # Monday
    assert add_interval(ts(2026, 12, 1), "1mo", BERLIN) == ts(2027, 1, 1)


def test_week_starts_monday_in_local_time():
    sunday_late = ts(2026, 10, 25, 23, 30)
    assert datetime.fromtimestamp(floor_local(sunday_late, "1w", BERLIN), BERLIN).weekday() == 0


def test_half_hour_offset_timezone():
    india = ZoneInfo("Asia/Kolkata")
    t = int(datetime(2026, 5, 5, 10, 45, tzinfo=india).timestamp())
    start = floor_local(t, "1h", india)
    assert datetime.fromtimestamp(start, india).minute == 0


def test_resolve_presets():
    now = ts(2026, 10, 27, 12)
    assert resolve_range("today", BERLIN, now) == (ts(2026, 10, 27), now)
    assert resolve_range("yesterday", BERLIN, now) == (ts(2026, 10, 26), ts(2026, 10, 27))
    assert resolve_range("last_month", BERLIN, now) == (ts(2026, 9, 1), ts(2026, 10, 1))
    assert resolve_range({"last": "7d"}, BERLIN, now) == (now - 7 * 86400, now)
    a, b = resolve_range({"preset": "today", "offset": "-1d"}, BERLIN, now)
    assert b - a == now - ts(2026, 10, 27)


def test_parse_duration_and_auto_interval():
    assert parse_duration("30min") == 1800
    assert parse_duration("7d") == 7 * 86400
    assert auto_interval(0, 86400) in ("5min", "15min")
    assert auto_interval(0, 365 * 86400) == "1d" or auto_interval(0, 365 * 86400) == "1w"
