"""Time ranges and bucket boundaries in a local time zone (DST aware).

All storage is UTC epoch based. Calendar buckets (day/week/month/year) are
computed in the configured local time zone, so a day around a DST switch has
23 or 25 hours and is still exactly one bucket.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

INTERVALS = ("1min", "5min", "15min", "30min", "1h", "1d", "1w", "1mo", "1y")
FIXED_SECONDS = {"1min": 60, "5min": 300, "15min": 900, "30min": 1800, "1h": 3600}
APPROX_SECONDS = {**FIXED_SECONDS, "1d": 86400, "1w": 604800, "1mo": 2_629_800, "1y": 31_557_600}

_DURATION_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|d|w|mo|y)\s*$", re.I)
_DURATION_UNITS = {"s": 1, "sec": 1, "m": 60, "min": 60, "h": 3600, "d": 86400, "w": 604800,
                   "mo": 2_629_800, "y": 31_557_600}


def parse_duration(text: str) -> int:
    """'7d' -> seconds. Raises ValueError."""
    m = _DURATION_RE.match(text or "")
    if not m:
        raise ValueError(f"Ungültige Zeitdauer: {text!r} (Beispiele: 30min, 24h, 7d, 4w)")
    return int(float(m.group(1)) * _DURATION_UNITS[m.group(2).lower()])


def tzinfo(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except Exception:  # noqa: BLE001
        return ZoneInfo("UTC")


def floor_local(ts: float, interval: str, tz: ZoneInfo) -> int:
    """Start of the bucket containing ts (epoch seconds)."""
    if interval in FIXED_SECONDS:
        step = FIXED_SECONDS[interval]
        if step <= 3600:
            # align fixed intervals to local wall clock (handles :30 offsets)
            off = int(datetime.fromtimestamp(ts, tz).utcoffset().total_seconds())
            return int(((int(ts) + off) // step) * step - off)
    dt = datetime.fromtimestamp(ts, tz)
    if interval == "1d":
        d = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    elif interval == "1w":
        d = (dt - timedelta(days=dt.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    elif interval == "1mo":
        d = dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    elif interval == "1y":
        d = dt.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        raise ValueError(f"Unbekanntes Intervall: {interval}")
    return _local_to_epoch(d.replace(tzinfo=None), tz)


def _local_to_epoch(naive: datetime, tz: ZoneInfo) -> int:
    """Wall clock -> epoch. Non-existent times (spring forward) move forward."""
    aware = naive.replace(tzinfo=tz, fold=0)
    epoch = int(aware.timestamp())
    back = datetime.fromtimestamp(epoch, tz).replace(tzinfo=None)
    if back != naive:
        # time in the DST gap -> first valid instant afterwards
        epoch = int(naive.replace(tzinfo=tz, fold=1).timestamp())
    return epoch


def add_interval(ts: int, interval: str, tz: ZoneInfo, n: int = 1) -> int:
    if interval in FIXED_SECONDS:
        return ts + FIXED_SECONDS[interval] * n
    dt = datetime.fromtimestamp(ts, tz).replace(tzinfo=None)
    if interval == "1d":
        dt = dt + timedelta(days=n)
    elif interval == "1w":
        dt = dt + timedelta(weeks=n)
    elif interval == "1mo":
        month = dt.month - 1 + n
        dt = dt.replace(year=dt.year + month // 12, month=month % 12 + 1)
    elif interval == "1y":
        dt = dt.replace(year=dt.year + n)
    return _local_to_epoch(dt, tz)


def bucket_edges(start: float, end: float, interval: str, tz: ZoneInfo, max_buckets: int = 20000) -> list[int]:
    """Edges covering [start, end): first edge = floor(start), last edge >= end."""
    if end <= start:
        return []
    edges = [floor_local(start, interval, tz)]
    while edges[-1] < end:
        nxt = add_interval(edges[-1], interval, tz)
        if nxt <= edges[-1]:  # safety
            nxt = edges[-1] + 60
        edges.append(nxt)
        if len(edges) > max_buckets + 1:
            raise ValueError("Zu viele Zeitabschnitte – bitte größeres Intervall wählen")
    return edges


def auto_interval(start: float, end: float, target: int = 200) -> str:
    span = max(1.0, end - start)
    for iv in INTERVALS:
        if span / APPROX_SECONDS[iv] <= target:
            return iv
    return "1y"


# ------------------------------------------------------------------ named ranges

RANGE_PRESETS = (
    "last_1h", "last_6h", "last_24h", "last_48h", "last_7d", "last_30d", "last_90d", "last_365d",
    "today", "yesterday", "this_week", "last_week", "this_month", "last_month",
    "this_year", "last_year", "all",
)


def resolve_range(spec: dict | str | None, tz: ZoneInfo, now: float | None = None,
                  earliest: float | None = None) -> tuple[int, int]:
    """Resolve a range spec to (start, end) epoch seconds.

    spec: preset name | {"preset": ...} | {"start": iso/epoch, "end": iso/epoch}
          | {"last": "7d"} ; optional "offset": "-1w" shifts the result.
    """
    now = time.time() if now is None else now
    if spec is None:
        spec = "last_24h"
    if isinstance(spec, str):
        spec = {"preset": spec}
    offset = 0
    if spec.get("offset"):
        off = str(spec["offset"]).strip()
        sign = -1 if off.startswith("-") else 1
        offset = sign * parse_duration(off.lstrip("+-"))
    if "start" in spec and spec.get("start") not in (None, ""):
        start = _parse_time(spec["start"], tz)
        end = _parse_time(spec["end"], tz) if spec.get("end") not in (None, "") else now
        return int(start + offset), int(end + offset)
    if spec.get("last"):
        sec = parse_duration(str(spec["last"]))
        return int(now - sec + offset), int(now + offset)
    preset = spec.get("preset", "last_24h")
    n = int(now)
    if preset.startswith("last_") and preset[5:] not in ("week", "month", "year"):
        sec = parse_duration(preset[5:])
        start, end = n - sec, n
    elif preset == "today":
        start, end = floor_local(n, "1d", tz), n
    elif preset == "yesterday":
        today = floor_local(n, "1d", tz)
        start, end = add_interval(today, "1d", tz, -1), today
    elif preset == "this_week":
        start, end = floor_local(n, "1w", tz), n
    elif preset == "last_week":
        cur = floor_local(n, "1w", tz)
        start, end = add_interval(cur, "1w", tz, -1), cur
    elif preset == "this_month":
        start, end = floor_local(n, "1mo", tz), n
    elif preset == "last_month":
        cur = floor_local(n, "1mo", tz)
        start, end = add_interval(cur, "1mo", tz, -1), cur
    elif preset == "this_year":
        start, end = floor_local(n, "1y", tz), n
    elif preset == "last_year":
        cur = floor_local(n, "1y", tz)
        start, end = add_interval(cur, "1y", tz, -1), cur
    elif preset == "all":
        start, end = int(earliest or (n - 365 * 86400)), n
    else:
        raise ValueError(f"Unbekannter Zeitraum: {preset}")
    return start + offset, end + offset


def _parse_time(value, tz: ZoneInfo) -> float:
    if isinstance(value, (int, float)):
        v = float(value)
        return v / 1000.0 if v > 1e11 else v
    s = str(value).strip()
    if re.fullmatch(r"\d+(\.\d+)?", s):
        return _parse_time(float(s), tz)
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        return _local_to_epoch(dt, tz)
    return dt.timestamp()


def iso_local(ts: float, tz: ZoneInfo) -> str:
    return datetime.fromtimestamp(ts, tz).isoformat()
