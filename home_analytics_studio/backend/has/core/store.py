"""Long-term time series store: ingest, rollups, retention and queries."""
from __future__ import annotations

import logging
import math
import shutil
import threading
import time
from dataclasses import dataclass
from typing import Any, Iterable

from sqlalchemy import text

from ..db import Database
from . import units
from .stats import COUNTER, MEASUREMENT, TOTAL, BucketStats, SeriesState, combine, compute_buckets
from .timeutil import FIXED_SECONDS, bucket_edges, floor_local, tzinfo

log = logging.getLogger(__name__)

ROLLUP_DELAY = 120  # seconds a bucket must be closed before it is rolled up
ROLLUP_CHUNK = 2 * 86400


def detect_kind(state_class: str | None, device_class: str | None, unit: str | None) -> str:
    sc = (state_class or "").lower()
    if sc == "total_increasing":
        return COUNTER
    if sc == "total":
        return TOTAL
    if sc == "measurement":
        return MEASUREMENT
    dim = units.dimension(unit)
    if (device_class or "") in {"energy", "gas", "water"} and dim in {"energy", "volume"}:
        return COUNTER
    if (device_class or "") == "monetary":
        return TOTAL
    return MEASUREMENT


def parse_state_value(state: Any) -> float | None:
    """HA state string -> float, None for unavailable/unknown/non-numeric."""
    if state is None:
        return None
    if isinstance(state, bool):
        return 1.0 if state else 0.0
    if isinstance(state, (int, float)):
        v = float(state)
        return v if math.isfinite(v) else None
    s = str(state).strip().lower()
    if s in {"on", "open", "home", "true", "detected", "active"}:
        return 1.0
    if s in {"off", "closed", "not_home", "away", "false", "clear", "idle", "inactive"}:
        return 0.0
    try:
        v = float(s)
    except ValueError:
        return None
    return v if math.isfinite(v) else None


@dataclass
class EntityInfo:
    id: int
    entity_id: str
    recorded: bool
    kind: str  # effective kind
    unit: str | None
    source_unit: str | None
    last_ts: int | None
    last_value: float | None
    rolled_5m: int | None
    rolled_1h: int | None
    retention_days: int | None
    max_rate: float | None = None


class Store:
    def __init__(self, db: Database, settings):
        self.db = db
        self.settings = settings
        self._buffer: list[tuple[int, int, float | None]] = []
        self._buf_lock = threading.Lock()
        self._cache: dict[str, EntityInfo] = {}
        self._last_written: dict[int, tuple[int, float | None]] = {}
        self.paused_reason: str | None = None
        self.stats = {"ingested": 0, "flushed": 0, "skipped": 0, "last_flush": None, "last_rollup": None}

    # ------------------------------------------------------------------ entities

    def load_cache(self) -> None:
        with self.db.read() as conn:
            rows = conn.execute(text("SELECT * FROM entities")).mappings().all()
        self._cache = {r["entity_id"]: self._info(r) for r in rows}

    @staticmethod
    def _info(r) -> EntityInfo:
        kind = r["kind"]
        if kind == "auto" or kind not in (MEASUREMENT, COUNTER, TOTAL):
            kind = detect_kind(r["state_class"], r["device_class"], r["source_unit"])
        return EntityInfo(
            id=r["id"], entity_id=r["entity_id"], recorded=bool(r["recorded"]), kind=kind,
            unit=r["unit"], source_unit=r["source_unit"], last_ts=r["last_ts"], last_value=r["last_value"],
            rolled_5m=r["rolled_5m"], rolled_1h=r["rolled_1h"], retention_days=r["retention_days"],
            max_rate=r["max_rate"] if "max_rate" in r.keys() else None,
        )

    def get(self, entity_id: str) -> EntityInfo | None:
        return self._cache.get(entity_id)

    def recorded_entities(self) -> list[EntityInfo]:
        return [e for e in self._cache.values() if e.recorded]

    def known_entities(self) -> list[EntityInfo]:
        return list(self._cache.values())

    def ensure_entity(self, entity_id: str, attrs: dict | None = None) -> EntityInfo:
        attrs = attrs or {}
        info = self._cache.get(entity_id)
        if info is not None:
            return info
        source_unit = attrs.get("unit_of_measurement")
        with self.db.write() as conn:
            conn.execute(
                text(
                    "INSERT OR IGNORE INTO entities(entity_id, recorded, kind, name, source_unit, unit, device_class,"
                    " state_class, created_at, sample_count) VALUES (:e, 0, 'auto', :n, :su, :u, :dc, :sc, :t, 0)"
                ),
                {
                    "e": entity_id, "n": attrs.get("friendly_name"), "su": source_unit,
                    "u": units.canonical_unit(source_unit), "dc": attrs.get("device_class"),
                    "sc": attrs.get("state_class"), "t": time.time(),
                },
            )
            row = conn.execute(text("SELECT * FROM entities WHERE entity_id=:e"), {"e": entity_id}).mappings().one()
        info = self._info(row)
        self._cache[entity_id] = info
        return info

    def update_metadata(self, entity_id: str, attrs: dict, area: str | None = None, device: str | None = None) -> None:
        info = self._cache.get(entity_id)
        if info is None:
            return
        source_unit = attrs.get("unit_of_measurement")
        params = {
            "e": entity_id, "n": attrs.get("friendly_name"), "su": source_unit,
            "dc": attrs.get("device_class"), "sc": attrs.get("state_class"), "a": area, "d": device,
        }
        with self.db.write() as conn:
            conn.execute(
                text(
                    "UPDATE entities SET name=COALESCE(:n, name), source_unit=COALESCE(:su, source_unit),"
                    " device_class=COALESCE(:dc, device_class), state_class=COALESCE(:sc, state_class),"
                    " area=COALESCE(:a, area), device=COALESCE(:d, device),"
                    " unit=COALESCE(unit, :cu) WHERE entity_id=:e"
                ),
                {**params, "cu": units.canonical_unit(source_unit)},
            )
            row = conn.execute(text("SELECT * FROM entities WHERE entity_id=:e"), {"e": entity_id}).mappings().one()
        self._cache[entity_id] = self._info(row)

    def set_recording(self, entity_ids: Iterable[str], recorded: bool, attrs_by_id: dict[str, dict] | None = None) -> int:
        n = 0
        for eid in entity_ids:
            info = self.ensure_entity(eid, (attrs_by_id or {}).get(eid))
            with self.db.write() as conn:
                conn.execute(
                    text(
                        "UPDATE entities SET recorded=:r, recording_since=CASE WHEN :r=1 AND recording_since IS NULL"
                        " THEN :t ELSE recording_since END WHERE id=:id"
                    ),
                    {"r": 1 if recorded else 0, "t": time.time(), "id": info.id},
                )
            info.recorded = recorded
            n += 1
        return n

    def configure(self, entity_id: str, kind: str | None = None, retention_days: int | None = -1,
                  unit: str | None = None, notes: str | None = None, max_rate: float | None = -1) -> EntityInfo:
        info = self.ensure_entity(entity_id)
        sets, params = [], {"id": info.id}
        if kind is not None:
            if kind not in ("auto", MEASUREMENT, COUNTER, TOTAL):
                raise ValueError("Ungültiger Wertetyp")
            sets.append("kind=:k")
            params["k"] = kind
        if retention_days != -1:
            sets.append("retention_days=:rd")
            params["rd"] = retention_days
        if unit is not None:
            sets.append("unit=:u")
            params["u"] = unit or None
        if notes is not None:
            sets.append("notes=:no")
            params["no"] = notes
        if max_rate != -1:
            if max_rate is not None and max_rate <= 0:
                raise ValueError("Grenzwert muss größer als 0 sein")
            sets.append("max_rate=:mr")
            params["mr"] = max_rate
        if sets:
            with self.db.write() as conn:
                conn.execute(text(f"UPDATE entities SET {', '.join(sets)} WHERE id=:id"), params)
                if kind is not None:
                    # kind affects rollups -> recompute everything from raw data still available
                    conn.execute(text("UPDATE entities SET rolled_5m=NULL, rolled_1h=NULL WHERE id=:id"), params)
                    self._reset_rollups(conn, info.id)
                row = conn.execute(text("SELECT * FROM entities WHERE id=:id"), params).mappings().one()
            self._cache[entity_id] = self._info(row)
        return self._cache[entity_id]

    def _reset_rollups(self, conn, entity_ref: int) -> None:
        first = conn.execute(text("SELECT MIN(ts) FROM samples WHERE entity_ref=:e"), {"e": entity_ref}).scalar()
        if first is None:
            return
        start = int(first // 1000)
        conn.execute(text("DELETE FROM stats_5m WHERE entity_ref=:e AND ts>=:s"), {"e": entity_ref, "s": start - 300})
        conn.execute(text("DELETE FROM stats_1h WHERE entity_ref=:e AND ts>=:s AND source='local'"),
                     {"e": entity_ref, "s": start - 3600})

    def delete_entity_data(self, entity_id: str, forget: bool = False) -> None:
        info = self._cache.get(entity_id)
        if info is None:
            return
        with self.db.write() as conn:
            for table in ("samples", "stats_5m", "stats_1h"):
                conn.execute(text(f"DELETE FROM {table} WHERE entity_ref=:e"), {"e": info.id})
            if forget:
                conn.execute(text("DELETE FROM entities WHERE id=:e"), {"e": info.id})
            else:
                conn.execute(
                    text("UPDATE entities SET sample_count=0, last_ts=NULL, last_value=NULL, rolled_5m=NULL,"
                         " rolled_1h=NULL, raw_from=NULL WHERE id=:e"), {"e": info.id})
        self._last_written.pop(info.id, None)
        if forget:
            self._cache.pop(entity_id, None)
        else:
            self.load_cache()

    # ------------------------------------------------------------------ ingest

    def convert_value(self, info: EntityInfo, value: float | None, unit: str | None) -> float | None:
        if value is None:
            return None
        target = info.unit
        if unit and target and unit != target:
            return units.convert(value, unit, target)
        return value

    def add_state(self, entity_id: str, state: Any, attrs: dict, ts: float) -> bool:
        """Queue a HA state for storage. Returns True if accepted."""
        info = self._cache.get(entity_id)
        if info is None or not info.recorded or self.paused_reason:
            return False
        value = parse_state_value(state)
        value = self.convert_value(info, value, attrs.get("unit_of_measurement"))
        ts_ms = int(round(ts * 1000))
        last = self._last_written.get(info.id)
        if last is not None:
            last_ts, last_val = last
            if ts_ms <= last_ts:
                self.stats["skipped"] += 1
                return False
            min_iv = int(self.settings.get("storage", "min_interval_seconds", 0) or 0)
            if min_iv and value is not None and last_val is not None and ts_ms - last_ts < min_iv * 1000:
                self.stats["skipped"] += 1
                return False
            if value == last_val and ts_ms - last_ts < 3600_000:
                # unchanged value (attribute-only update): no information gain
                self.stats["skipped"] += 1
                return False
        self._last_written[info.id] = (ts_ms, value)
        with self._buf_lock:
            self._buffer.append((info.id, ts_ms, value))
        self.stats["ingested"] += 1
        return True

    def insert_samples(self, entity_ref: int, rows: list[tuple[int, float | None]]) -> int:
        """Bulk insert (history import). Duplicates (same ts) are ignored."""
        if not rows:
            return 0
        with self.db.write() as conn:
            before = conn.execute(text("SELECT COUNT(*) FROM samples WHERE entity_ref=:e"), {"e": entity_ref}).scalar()
            conn.execute(
                text("INSERT OR IGNORE INTO samples(entity_ref, ts, value) VALUES (:e, :t, :v)"),
                [{"e": entity_ref, "t": t, "v": v} for t, v in rows],
            )
            after = conn.execute(text("SELECT COUNT(*) FROM samples WHERE entity_ref=:e"), {"e": entity_ref}).scalar()
            first_ts = min(t for t, _ in rows) // 1000
            self._refresh_entity_stats(conn, entity_ref)
            # imported data may lie before the rollup watermark -> recompute from there
            conn.execute(
                text("UPDATE entities SET rolled_5m=MIN(COALESCE(rolled_5m, :s), :s), rolled_1h=MIN(COALESCE(rolled_1h, :s), :s)"
                     " WHERE id=:e AND (rolled_5m IS NOT NULL OR rolled_1h IS NOT NULL)"),
                {"e": entity_ref, "s": int(first_ts // 3600 * 3600) - 3600},
            )
        self.load_cache()
        return int(after - before)

    def _refresh_entity_stats(self, conn, entity_ref: int) -> None:
        conn.execute(
            text(
                "UPDATE entities SET sample_count=(SELECT COUNT(*) FROM samples WHERE entity_ref=:e),"
                " last_ts=(SELECT MAX(ts) FROM samples WHERE entity_ref=:e),"
                " last_value=(SELECT value FROM samples WHERE entity_ref=:e ORDER BY ts DESC LIMIT 1) WHERE id=:e"
            ),
            {"e": entity_ref},
        )

    def flush(self) -> int:
        with self._buf_lock:
            batch, self._buffer = self._buffer, []
        if not batch:
            return 0
        latest: dict[int, tuple[int, float | None]] = {}
        counts: dict[int, int] = {}
        for ref, ts, v in batch:
            if ref not in latest or ts >= latest[ref][0]:
                latest[ref] = (ts, v)
            counts[ref] = counts.get(ref, 0) + 1
        try:
            with self.db.write() as conn:
                conn.execute(
                    text("INSERT OR IGNORE INTO samples(entity_ref, ts, value) VALUES (:e, :t, :v)"),
                    [{"e": r, "t": t, "v": v} for r, t, v in batch],
                )
                for ref, (ts, v) in latest.items():
                    conn.execute(
                        text("UPDATE entities SET last_ts=:t, last_value=:v, sample_count=sample_count+:c WHERE id=:e"),
                        {"t": ts, "v": v, "c": counts[ref], "e": ref},
                    )
        except Exception:
            # put the batch back so nothing is lost on transient errors (e.g. locked db)
            with self._buf_lock:
                self._buffer = batch + self._buffer
            raise
        for info in self._cache.values():
            if info.id in latest:
                info.last_ts, info.last_value = latest[info.id]
        self.stats["flushed"] += len(batch)
        self.stats["last_flush"] = time.time()
        return len(batch)

    def pending(self) -> int:
        return len(self._buffer)

    # ------------------------------------------------------------------ raw access

    def _state_before(self, conn, entity_ref: int, ts_s: int) -> SeriesState:
        row = conn.execute(
            text("SELECT value FROM samples WHERE entity_ref=:e AND ts<:t ORDER BY ts DESC LIMIT 1"),
            {"e": entity_ref, "t": ts_s * 1000},
        ).first()
        base = conn.execute(
            text("SELECT value, ts FROM samples WHERE entity_ref=:e AND ts<:t AND value IS NOT NULL ORDER BY ts DESC LIMIT 1"),
            {"e": entity_ref, "t": ts_s * 1000},
        ).first()
        return SeriesState(value=row[0] if row else None, baseline=base[0] if base else None,
                           last_ts=base[1] / 1000.0 if base else None)

    def raw_samples(self, entity_ref: int, start_s: int, end_s: int, limit: int | None = None) -> list[tuple[int, float | None]]:
        with self.db.read() as conn:
            q = "SELECT ts, value FROM samples WHERE entity_ref=:e AND ts>=:a AND ts<:b ORDER BY ts"
            if limit:
                q += f" LIMIT {int(limit)}"
            return [(r[0], r[1]) for r in conn.execute(text(q), {"e": entity_ref, "a": start_s * 1000, "b": end_s * 1000})]

    def _compute_from_raw(self, conn, info: EntityInfo, edges: list[int], until: int | None,
                          apply_limit: bool = True) -> list[BucketStats]:
        state = self._state_before(conn, info.id, edges[0])
        rows = conn.execute(
            text("SELECT ts, value FROM samples WHERE entity_ref=:e AND ts>=:a AND ts<:b ORDER BY ts"),
            {"e": info.id, "a": edges[0] * 1000, "b": edges[-1] * 1000},
        ).all()
        return compute_buckets([(r[0], r[1]) for r in rows], edges, info.kind, state, until,
                               info.max_rate if apply_limit and info.kind != MEASUREMENT else None)

    # ------------------------------------------------------------------ rollups

    def rollup(self, now: float | None = None, entity_ids: list[str] | None = None) -> int:
        now = time.time() if now is None else now
        done = 0
        targets = [self._cache[e] for e in entity_ids] if entity_ids else self.recorded_entities()
        for info in targets:
            try:
                done += self._rollup_entity(info, now)
            except Exception:  # noqa: BLE001
                log.exception("Rollup failed for %s", info.entity_id)
        self.stats["last_rollup"] = time.time()
        return done

    def _rollup_entity(self, info: EntityInfo, now: float) -> int:
        tz = tzinfo("UTC")
        limit5 = int((now - ROLLUP_DELAY) // 300 * 300)
        written = 0
        with self.db.read() as conn:
            first = conn.execute(text("SELECT MIN(ts) FROM samples WHERE entity_ref=:e"), {"e": info.id}).scalar()
            row = conn.execute(text("SELECT rolled_5m, rolled_1h FROM entities WHERE id=:e"), {"e": info.id}).first()
        if first is None:
            return 0
        rolled5, rolled1 = row[0], row[1]
        start5 = rolled5 if rolled5 is not None else int(first // 1000 // 300 * 300)
        while start5 < limit5:
            end5 = min(limit5, start5 + ROLLUP_CHUNK)
            edges = bucket_edges(start5, end5, "5min", tz)
            if edges[-1] > end5:
                edges = [e for e in edges if e <= end5]
            with self.db.write() as conn:
                # rollups store the unfiltered truth; plausibility limits apply at query time
                buckets = self._compute_from_raw(conn, info, edges, None, apply_limit=False)
                conn.execute(text("DELETE FROM stats_5m WHERE entity_ref=:e AND ts>=:a AND ts<:b"),
                             {"e": info.id, "a": edges[0], "b": edges[-1]})
                payload = [_row(info.id, b) for b in buckets if _non_empty(b)]
                if payload:
                    conn.execute(
                        text("INSERT OR REPLACE INTO stats_5m(entity_ref, ts, mean, min, max, first, last, delta, count, covered)"
                             " VALUES (:e, :ts, :mean, :min, :max, :first, :last, :delta, :count, :covered)"), payload)
                conn.execute(text("UPDATE entities SET rolled_5m=:r WHERE id=:e"), {"r": edges[-1], "e": info.id})
                written += len(payload)
            start5 = edges[-1]
            rolled5 = start5
        if rolled5 is None:
            return written
        limit1 = int(rolled5 // 3600 * 3600)
        start1 = rolled1 if rolled1 is not None else int(first // 1000 // 3600 * 3600)
        while start1 < limit1:
            end1 = min(limit1, start1 + ROLLUP_CHUNK * 7)
            edges = list(range(start1, end1 + 1, 3600))
            with self.db.write() as conn:
                rows = conn.execute(
                    text("SELECT ts, mean, min, max, first, last, delta, count, covered FROM stats_5m"
                         " WHERE entity_ref=:e AND ts>=:a AND ts<:b ORDER BY ts"),
                    {"e": info.id, "a": edges[0], "b": edges[-1]},
                ).mappings().all()
                buckets = combine(rows, edges)
                conn.execute(text("DELETE FROM stats_1h WHERE entity_ref=:e AND ts>=:a AND ts<:b AND source='local'"),
                             {"e": info.id, "a": edges[0], "b": edges[-1]})
                payload = [_row(info.id, b) for b in buckets if _non_empty(b)]
                if payload:
                    conn.execute(
                        text("INSERT OR REPLACE INTO stats_1h(entity_ref, ts, mean, min, max, first, last, delta, count, covered, source)"
                             " VALUES (:e, :ts, :mean, :min, :max, :first, :last, :delta, :count, :covered, 'local')"), payload)
                conn.execute(text("UPDATE entities SET rolled_1h=:r WHERE id=:e"), {"r": edges[-1], "e": info.id})
                written += len(payload)
            start1 = edges[-1]
        info.rolled_5m = rolled5
        return written

    def import_hourly_statistics(self, entity_ref: int, rows: list[dict]) -> int:
        """Store HA long-term statistics (hourly). Local rows are never overwritten."""
        if not rows:
            return 0
        with self.db.write() as conn:
            existing = {
                r[0] for r in conn.execute(
                    text("SELECT ts FROM stats_1h WHERE entity_ref=:e AND ts>=:a AND ts<=:b AND source='local'"),
                    {"e": entity_ref, "a": rows[0]["ts"], "b": rows[-1]["ts"]},
                )
            }
            payload = [{"e": entity_ref, **r} for r in rows if r["ts"] not in existing]
            if payload:
                conn.execute(
                    text("INSERT OR REPLACE INTO stats_1h(entity_ref, ts, mean, min, max, first, last, delta, count, covered, source)"
                         " VALUES (:e, :ts, :mean, :min, :max, :first, :last, :delta, :count, :covered, 'ha')"), payload)
        return len(payload)

    # ------------------------------------------------------------------ queries

    def query(self, info: EntityInfo, start: int, end: int, interval: str, tz_name: str,
              now: float | None = None) -> list[BucketStats]:
        tz = tzinfo(tz_name)
        edges = bucket_edges(start, end, interval, tz)
        return self.query_edges(info, edges, now=now, until=end)

    def query_edges(self, info: EntityInfo, edges: list[int], now: float | None = None,
                    until: float | None = None) -> list[BucketStats]:
        """Bucket statistics for arbitrary ascending edges (calendar buckets, single range ...).

        Source selection: raw samples for short ranges / sub-5-minute buckets (exact),
        5-minute rollups for sub-hour buckets, hourly rollups otherwise.
        """
        if len(edges) < 2:
            return []
        now = time.time() if now is None else now
        lim = int(min(now, until if until is not None else edges[-1]))
        span = edges[-1] - edges[0]
        min_bucket = min(edges[i + 1] - edges[i] for i in range(len(edges) - 1))
        with self.db.read() as conn:
            raw_from = self._watermark(conn, info, "raw_from")
            first_raw = conn.execute(text("SELECT MIN(ts) FROM samples WHERE entity_ref=:e"), {"e": info.id}).scalar()
            # raw samples only if they cover the start of the range; older data (purged or
            # imported HA long-term statistics) lives in the rollup tables
            raw_ok = (raw_from is None or edges[0] >= raw_from) and first_raw is not None and edges[0] >= first_raw // 1000
            if raw_ok and (min_bucket < 300 or span <= 3 * 86400):
                if span > 31 * 86400 and min_bucket < 300:
                    raise ValueError("Minutenauflösung ist auf 31 Tage begrenzt")
                return self._compute_from_raw(conn, info, edges, lim)
            if min_bucket < 3600:
                return self._combined(conn, info, edges, lim, "stats_5m", 300, self._watermark(conn, info, "rolled_5m"))
            return self._combined(conn, info, edges, lim, "stats_1h", 3600, self._watermark(conn, info, "rolled_1h"))

    @staticmethod
    def _watermark(conn, info: EntityInfo, column: str) -> int | None:
        return conn.execute(text(f"SELECT {column} FROM entities WHERE id=:e"), {"e": info.id}).scalar()

    def _combined(self, conn, info: EntityInfo, edges: list[int], until: int, table: str, step: int,
                  watermark: int | None) -> list[BucketStats]:
        a, b = edges[0], edges[-1]
        wm = watermark if watermark is not None else a
        wm = max(a, min(wm, b))
        rows = [dict(r) for r in conn.execute(
            text(f"SELECT ts, mean, min, max, first, last, delta, count, covered FROM {table}"
                 " WHERE entity_ref=:e AND ts>=:a AND ts<:b ORDER BY ts"),
            {"e": info.id, "a": a, "b": b},
        ).mappings()]
        if wm < b:
            # live tail that is not rolled up yet: compute from raw in `step` sized chunks
            tail_start = wm // step * step
            tail_end = min(b, -(-until // step) * step)
            if tail_end > tail_start:
                tail_edges = list(range(tail_start, tail_end + 1, step))
                by_ts = {r["ts"]: r for r in rows}
                for bucket in self._compute_from_raw(conn, info, tail_edges, until):
                    if _non_empty(bucket):
                        by_ts[bucket.ts] = _row(info.id, bucket)
                rows = list(by_ts.values())
        rows.sort(key=lambda r: r["ts"])
        max_delta = info.max_rate * step / 3600 if info.max_rate and info.kind != MEASUREMENT else None
        return combine(rows, edges, max_delta)

    def latest_value(self, info: EntityInfo) -> tuple[int | None, float | None]:
        return info.last_ts, info.last_value

    def time_bounds(self, info: EntityInfo) -> tuple[int | None, int | None]:
        with self.db.read() as conn:
            s1 = conn.execute(text("SELECT MIN(ts) FROM stats_1h WHERE entity_ref=:e"), {"e": info.id}).scalar()
            r0 = conn.execute(text("SELECT MIN(ts), MAX(ts) FROM samples WHERE entity_ref=:e"), {"e": info.id}).first()
        starts = [x for x in (s1, (r0[0] // 1000) if r0 and r0[0] is not None else None) if x is not None]
        end = (r0[1] // 1000) if r0 and r0[1] is not None else None
        return (min(starts) if starts else None), end

    # ------------------------------------------------------------------ retention

    def apply_retention(self, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        st = self.settings.get("storage")
        raw_days = int(st.get("raw_retention_days") or 0)
        s5_days = int(st.get("stats5m_retention_days") or 0)
        h_days = int(st.get("hourly_retention_days") or 0)
        removed = {"samples": 0, "stats_5m": 0, "stats_1h": 0}
        for info in self.known_entities():
            days = info.retention_days if info.retention_days is not None else raw_days
            with self.db.write() as conn:
                row = conn.execute(text("SELECT rolled_5m FROM entities WHERE id=:e"), {"e": info.id}).first()
                rolled5 = row[0] if row and row[0] is not None else 0
                if days and days > 0:
                    cutoff_ms = int(min(now - days * 86400, rolled5) * 1000)
                    # keep the last sample before the cutoff (carries state into the retained range)
                    keep = conn.execute(
                        text("SELECT MAX(ts) FROM samples WHERE entity_ref=:e AND ts<:c"), {"e": info.id, "c": cutoff_ms}
                    ).scalar()
                    if keep is not None:
                        res = conn.execute(text("DELETE FROM samples WHERE entity_ref=:e AND ts<:k"),
                                           {"e": info.id, "k": keep})
                        removed["samples"] += res.rowcount or 0
                        if res.rowcount:
                            conn.execute(text("UPDATE entities SET raw_from=:c WHERE id=:e"),
                                         {"c": cutoff_ms // 1000, "e": info.id})
                if s5_days > 0:
                    rolled1 = conn.execute(text("SELECT rolled_1h FROM entities WHERE id=:e"), {"e": info.id}).scalar() or 0
                    cutoff = int(min(now - s5_days * 86400, rolled1))
                    res = conn.execute(text("DELETE FROM stats_5m WHERE entity_ref=:e AND ts<:c"), {"e": info.id, "c": cutoff})
                    removed["stats_5m"] += res.rowcount or 0
                if h_days > 0:
                    res = conn.execute(text("DELETE FROM stats_1h WHERE entity_ref=:e AND ts<:c"),
                                       {"e": info.id, "c": int(now - h_days * 86400)})
                    removed["stats_1h"] += res.rowcount or 0
                if removed["samples"]:
                    self._refresh_entity_stats(conn, info.id)
        return removed

    def storage_by_entity(self) -> dict[int, dict]:
        out: dict[int, dict] = {}
        with self.db.read() as conn:
            for table, key in (("stats_5m", "rows_5m"), ("stats_1h", "rows_1h")):
                for ref, cnt in conn.execute(text(f"SELECT entity_ref, COUNT(*) FROM {table} GROUP BY entity_ref")):
                    out.setdefault(ref, {})[key] = cnt
            for ref, cnt in conn.execute(text("SELECT id, sample_count FROM entities")):
                out.setdefault(ref, {})["samples"] = cnt
        for ref, d in out.items():
            # empirical bytes per row in WITHOUT ROWID tables incl. b-tree overhead
            d["bytes"] = int(d.get("samples", 0) * 22 + d.get("rows_5m", 0) * 70 + d.get("rows_1h", 0) * 75)
        return out

    def check_disk(self) -> dict:
        st = self.settings.get("storage")
        usage = shutil.disk_usage(self.db.path.parent)
        free_mb = usage.free / 1024 / 1024
        size = self.db.size_info()
        db_mb = (size["db_bytes"] + size["wal_bytes"]) / 1024 / 1024
        reason = None
        if st.get("min_free_disk_mb") and free_mb < float(st["min_free_disk_mb"]):
            reason = f"Wenig freier Speicher ({free_mb:.0f} MB < {st['min_free_disk_mb']} MB) – Aufzeichnung pausiert"
        elif st.get("max_db_size_mb") and db_mb > float(st["max_db_size_mb"]):
            reason = f"Datenbank-Limit erreicht ({db_mb:.0f} MB > {st['max_db_size_mb']} MB) – Aufzeichnung pausiert"
        if reason != self.paused_reason:
            if reason:
                log.warning(reason)
            elif self.paused_reason:
                log.info("Aufzeichnung fortgesetzt")
        self.paused_reason = reason
        return {"total": usage.total, "used": usage.used, "free": usage.free, "db_mb": db_mb, "paused": reason, **size}


def _non_empty(b: BucketStats) -> bool:
    return b.count > 0 or b.covered > 0 or b.delta is not None


def _row(ref: int, b: BucketStats) -> dict:
    return {
        "e": ref, "ts": b.ts, "mean": b.mean, "min": b.min, "max": b.max, "first": b.first, "last": b.last,
        "delta": b.delta, "count": b.count, "covered": b.covered,
    }
