"""Bucket statistics for time series.

Semantics by entity kind:

* ``measurement`` – momentary values (power, temperature ...). Statistics are
  *time weighted*: a value is valid until the next sample (step function).
  ``mean`` is the time-weighted average over the covered part of the bucket.
* ``counter``     – monotonically increasing meter readings (total_increasing,
  energy/water/gas meters). The relevant figure is the *consumption* in a
  bucket (``delta``). Meter resets are detected: a drop of more than
  ``RESET_THRESHOLD`` relative to the previous reading starts a new cycle and
  the new reading counts as consumption since the reset. Smaller drops are
  treated as measurement noise and ignored (the baseline is not lowered, so a
  later recovery is not counted twice).
* ``total``       – totals that may go up and down (net meters, balances):
  ``delta`` is the plain difference.

Unavailable/unknown states are stored as ``None`` markers. A measurement is
not carried across a ``None`` marker (gap). For counters the baseline is kept
across gaps so consumption during an outage is attributed to the bucket in
which the meter reports again.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Sequence

RESET_THRESHOLD = 0.1

MEASUREMENT = "measurement"
COUNTER = "counter"
TOTAL = "total"
KINDS = (MEASUREMENT, COUNTER, TOTAL)


@dataclass
class BucketStats:
    ts: int  # bucket start (epoch seconds)
    end: int
    mean: float | None = None
    min: float | None = None
    max: float | None = None
    first: float | None = None
    last: float | None = None
    delta: float | None = None
    count: int = 0
    covered: float = 0.0  # seconds with a known value
    _wsum: float = field(default=0.0, repr=False)

    @property
    def coverage(self) -> float:
        span = self.end - self.ts
        return min(1.0, self.covered / span) if span > 0 else 0.0

    def as_dict(self) -> dict:
        return {
            "ts": self.ts,
            "end": self.end,
            "mean": self.mean,
            "min": self.min,
            "max": self.max,
            "first": self.first,
            "last": self.last,
            "delta": self.delta,
            "count": self.count,
            "covered": self.covered,
            "coverage": self.coverage,
        }


def counter_step(prev: float | None, value: float, kind: str) -> tuple[float, float]:
    """Return (consumption, new_baseline) for one counter reading."""
    if prev is None:
        return 0.0, value
    if kind == TOTAL:
        return value - prev, value
    if value >= prev:
        return value - prev, value
    drop = prev - value
    if prev > 0 and drop / prev <= RESET_THRESHOLD and value > 0:
        # noise / rounding jitter: ignore, keep the higher baseline
        return 0.0, prev
    # meter reset: consumption since reset is the new reading
    return max(value, 0.0), value


@dataclass
class SeriesState:
    """State carried into the first bucket from data before the range."""

    value: float | None = None  # value in effect at range start (None = gap / unknown)
    baseline: float | None = None  # last known counter reading


def compute_buckets(
    samples: Sequence[tuple[int, float | None]],
    edges: Sequence[int],
    kind: str,
    state: SeriesState | None = None,
    until: int | None = None,
) -> list[BucketStats]:
    """Compute statistics for consecutive buckets.

    samples: sorted (ts_ms, value) inside [edges[0], edges[-1]) (others ignored)
    edges:   ascending bucket boundaries in epoch seconds (n+1 edges -> n buckets)
    until:   values are not extrapolated beyond this epoch second (typically now)
    """
    state = state or SeriesState()
    cur_val = state.value
    baseline = state.baseline
    out: list[BucketStats] = []
    if len(edges) < 2:
        return out
    idx = 0
    n = len(samples)
    start0 = edges[0] * 1000
    while idx < n and samples[idx][0] < start0:
        # samples before range update state (defensive; callers usually pre-filter)
        v = samples[idx][1]
        cur_val = v
        if v is not None and kind != MEASUREMENT:
            _, baseline = counter_step(baseline, v, kind)
        idx += 1

    for i in range(len(edges) - 1):
        a, b = edges[i], edges[i + 1]
        bucket = BucketStats(ts=a, end=b)
        limit = b if until is None else max(a, min(b, until))
        cur_t = float(a)
        if cur_val is not None and limit > a:
            _touch(bucket, cur_val)
        delta = 0.0
        has_delta = False
        b_ms = b * 1000
        while idx < n and samples[idx][0] < b_ms:
            ts_ms, v = samples[idx]
            t = ts_ms / 1000.0
            if cur_val is not None and t > cur_t:
                seg = min(t, limit) - cur_t
                if seg > 0:
                    bucket._wsum += cur_val * seg
                    bucket.covered += seg
            cur_t = max(cur_t, t)
            cur_val = v
            if v is not None:
                bucket.count += 1
                _touch(bucket, v)
                if kind != MEASUREMENT:
                    d, baseline = counter_step(baseline, v, kind)
                    if baseline is not None:
                        delta += d
                        has_delta = True
            idx += 1
        if cur_val is not None and limit > cur_t:
            seg = limit - cur_t
            bucket._wsum += cur_val * seg
            bucket.covered += seg
        if bucket.covered > 0:
            bucket.mean = bucket._wsum / bucket.covered
        if kind != MEASUREMENT:
            if has_delta or bucket.first is not None:
                bucket.delta = delta
        out.append(bucket)
    return out


def _touch(bucket: BucketStats, v: float) -> None:
    if bucket.first is None:
        bucket.first = v
    bucket.last = v
    bucket.min = v if bucket.min is None else min(bucket.min, v)
    bucket.max = v if bucket.max is None else max(bucket.max, v)


def combine(rows: Iterable[dict], edges: Sequence[int]) -> list[BucketStats]:
    """Combine finer stat rows (dicts with ts/mean/min/max/first/last/delta/count/covered)
    into coarser buckets defined by ``edges``. Rows must be sorted by ts."""
    out = [BucketStats(ts=edges[i], end=edges[i + 1]) for i in range(len(edges) - 1)]
    if not out:
        return out
    bi = 0
    for row in rows:
        ts = row["ts"]
        while bi < len(out) and ts >= out[bi].end:
            bi += 1
        if bi >= len(out):
            break
        if ts < out[bi].ts:
            continue
        b = out[bi]
        cov = float(row.get("covered") or 0.0)
        mean = row.get("mean")
        if mean is not None and cov > 0:
            b._wsum += mean * cov
            b.covered += cov
        for key, fn in (("min", min), ("max", max)):
            v = row.get(key)
            if v is not None:
                cur = getattr(b, key)
                setattr(b, key, v if cur is None else fn(cur, v))
        if row.get("first") is not None and b.first is None:
            b.first = row["first"]
        if row.get("last") is not None:
            b.last = row["last"]
        if row.get("delta") is not None:
            b.delta = (b.delta or 0.0) + row["delta"]
        b.count += int(row.get("count") or 0)
    for b in out:
        if b.covered > 0:
            b.mean = b._wsum / b.covered
    return out
