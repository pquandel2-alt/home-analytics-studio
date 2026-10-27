"""Query engine: time series & scalar values for entities and computed metrics."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from sqlalchemy import text

from ..db import Database
from . import formula as fx
from .stats import MEASUREMENT, BucketStats, SeriesState, compute_buckets
from .store import EntityInfo, Store, detect_kind, parse_state_value
from .timeutil import APPROX_SECONDS, add_interval, auto_interval, bucket_edges, resolve_range, tzinfo
from . import units

log = logging.getLogger(__name__)

STAT_FIELDS = ("auto", "state", "mean", "min", "max", "first", "last", "delta", "count", "coverage")
MAX_LIVE_HISTORY = 10 * 86400


class SourceError(ValueError):
    pass


class DataEngine:
    def __init__(self, db: Database, store: Store, settings, ha=None):
        self.db = db
        self.store = store
        self.settings = settings
        self.ha = ha

    # ------------------------------------------------------------------ context

    def tz_name(self) -> str:
        tz = self.settings.get("general", "timezone") or ""
        if not tz and self.ha is not None:
            tz = (self.ha.config or {}).get("time_zone") or ""
        return tz or "Europe/Berlin"

    def tz(self):
        return tzinfo(self.tz_name())

    def constants(self) -> dict[str, tuple[float, str | None]]:
        with self.db.read() as conn:
            return {r[0]: (r[1], r[2]) for r in conn.execute(text("SELECT key, value, unit FROM constants"))}

    def metric_defs(self) -> dict[str, dict]:
        with self.db.read() as conn:
            return {r["key"]: dict(r) for r in conn.execute(text("SELECT * FROM metrics")).mappings()}

    # ------------------------------------------------------------------ entity meta

    def entity_meta(self, entity_id: str) -> dict | None:
        info = self.store.get(entity_id)
        st = self.ha.state_of(entity_id) if self.ha else None
        if info is None and st is None:
            return None
        attrs = (st or {}).get("attributes") or {}
        if info is not None:
            return {"entity_id": entity_id, "kind": info.kind, "unit": info.unit or units.canonical_unit(attrs.get("unit_of_measurement")),
                    "recorded": info.recorded, "name": attrs.get("friendly_name") or info.name or entity_id}
        src_unit = attrs.get("unit_of_measurement")
        return {"entity_id": entity_id, "kind": detect_kind(attrs.get("state_class"), attrs.get("device_class"), src_unit),
                "unit": units.canonical_unit(src_unit), "recorded": False, "name": attrs.get("friendly_name") or entity_id}

    def known_entity(self, entity_id: str) -> bool:
        return self.entity_meta(entity_id) is not None

    # ------------------------------------------------------------------ buckets

    async def entity_buckets(self, entity_id: str, edges: list[int], now: float | None = None) -> list[BucketStats]:
        info = self.store.get(entity_id)
        has_data = info is not None and (info.recorded or info.last_ts is not None)
        if has_data:
            local = await asyncio.to_thread(self.store.query_edges, info, edges, now)
            if info.recorded or any(b.count or b.covered for b in local):
                return local
        return await self._live_history_buckets(entity_id, edges, now)

    async def _live_history_buckets(self, entity_id: str, edges: list[int], now: float | None) -> list[BucketStats]:
        """Entities that are not recorded: use HA's own recorder history (limited range)."""
        meta = self.entity_meta(entity_id)
        if meta is None:
            raise SourceError(f"Unbekannte Entität '{entity_id}'")
        empty = [BucketStats(ts=edges[i], end=edges[i + 1]) for i in range(len(edges) - 1)]
        if self.ha is None or not self.ha.connected:
            return empty
        now = time.time() if now is None else now
        start = max(edges[0], now - MAX_LIVE_HISTORY)
        end = min(edges[-1], now)
        if end <= start:
            return empty
        try:
            data = await self.ha.history([entity_id], start, end)
        except Exception as err:  # noqa: BLE001
            log.debug("history fallback failed: %s", err)
            return empty
        target = meta["unit"]
        samples: list[tuple[int, float | None]] = []
        state = SeriesState()
        for ts, st, attrs in data.get(entity_id, []):
            v = parse_state_value(st)
            if v is not None:
                v = units.convert(v, (attrs or {}).get("unit_of_measurement"), target)
            if ts <= edges[0]:
                state = SeriesState(value=v, baseline=v if v is not None else state.baseline)
                continue
            samples.append((int(ts * 1000), v))
        return compute_buckets(samples, edges, meta["kind"], state, int(min(now, edges[-1])))

    # ------------------------------------------------------------------ public API

    def resolve(self, range_spec: Any, interval: str | None, earliest: float | None = None) -> tuple[int, int, str]:
        tz = self.tz()
        start, end = resolve_range(range_spec, tz, earliest=earliest)
        if not interval or interval == "auto":
            interval = auto_interval(start, end)
        return start, end, interval

    async def series(self, source: dict, range_spec: Any, interval: str | None = "auto",
                     now: float | None = None) -> dict:
        start, end, interval = self.resolve(range_spec, interval)
        tz = self.tz()
        edges = bucket_edges(start, end, interval, tz)
        stype = source.get("type", "entity")
        if stype == "entity":
            eid = source.get("id") or source.get("entity_id")
            meta = self.entity_meta(eid)
            if meta is None:
                raise SourceError(f"Unbekannte Entität '{eid}'")
            buckets = await self.entity_buckets(eid, edges, now)
            stat = source.get("stat") or "auto"
            values = [_stat_value(b, stat, meta["kind"]) for b in buckets]
            return {
                "source": source, "start": start, "end": end, "interval": interval,
                "ts": [b.ts for b in buckets], "values": values,
                "min": [b.min for b in buckets], "max": [b.max for b in buckets],
                "coverage": [round(b.coverage, 4) for b in buckets],
                "unit": meta["unit"], "kind": meta["kind"], "name": meta["name"],
            }
        if stype == "metric":
            key = source.get("id")
            defs = self.metric_defs()
            if key not in defs:
                raise SourceError(f"Unbekannte Kennzahl '{key}'")
            values = await self.evaluate_formula(defs[key]["formula"], edges, interval, now)
            return {
                "source": source, "start": start, "end": end, "interval": interval,
                "ts": edges[:-1], "values": values, "unit": defs[key]["unit"], "kind": "metric",
                "name": defs[key]["name"], "min": None, "max": None, "coverage": None,
            }
        if stype == "formula":
            values = await self.evaluate_formula(source.get("formula", ""), edges, interval, now)
            return {"source": source, "start": start, "end": end, "interval": interval, "ts": edges[:-1],
                    "values": values, "unit": source.get("unit"), "kind": "formula", "name": source.get("name") or "Formel",
                    "min": None, "max": None, "coverage": None}
        raise SourceError(f"Unbekannter Quelltyp '{stype}'")

    async def scalar(self, source: dict, range_spec: Any, now: float | None = None) -> dict:
        """Single value for KPI widgets.

        Entities: counters -> consumption in range, measurements -> time weighted mean
        (or the requested stat). Metrics: formula evaluated over the whole range as one
        bucket (ratio of totals is correct), or – for time dependent formulas – per day
        and aggregated with the metric's aggregation.
        """
        tz = self.tz()
        start, end = resolve_range(range_spec, tz)
        stype = source.get("type", "entity")
        if stype == "entity":
            eid = source.get("id")
            meta = self.entity_meta(eid)
            if meta is None:
                raise SourceError(f"Unbekannte Entität '{eid}'")
            stat = source.get("stat") or "auto"
            if stat == "current":
                st = self.ha.state_of(eid) if self.ha else None
                if st is not None:
                    v = parse_state_value(st.get("state"))
                    if v is not None:
                        v = units.convert(v, (st.get("attributes") or {}).get("unit_of_measurement"), meta["unit"])
                    return {"value": v, "unit": meta["unit"], "start": start, "end": end, "coverage": None,
                            "ts": None, "name": meta["name"]}
                info = self.store.get(eid)
                return {"value": info.last_value if info else None, "unit": meta["unit"], "start": start, "end": end,
                        "coverage": None, "ts": (info.last_ts / 1000) if info and info.last_ts else None, "name": meta["name"]}
            buckets = await self.entity_buckets(eid, [start, end], now)
            b = buckets[0] if buckets else BucketStats(ts=start, end=end)
            return {"value": _stat_value(b, stat, meta["kind"]), "unit": meta["unit"], "start": start, "end": end,
                    "coverage": round(b.coverage, 4), "name": meta["name"], "count": b.count}
        if stype in ("metric", "formula"):
            if stype == "metric":
                defs = self.metric_defs()
                key = source.get("id")
                if key not in defs:
                    raise SourceError(f"Unbekannte Kennzahl '{key}'")
                formula, agg, unit, name = defs[key]["formula"], defs[key]["aggregation"], defs[key]["unit"], defs[key]["name"]
            else:
                formula, agg, unit, name = source.get("formula", ""), source.get("aggregation", "auto"), source.get("unit"), "Formel"
            metrics = {k: v["formula"] for k, v in self.metric_defs().items()}
            _, _, _, time_dep = fx.dependencies(formula, metrics, self.constants())
            if agg in (None, "", "auto") and not time_dep:
                values = await self.evaluate_formula(formula, [start, end], None, now)
                value = values[0] if values else None
            else:
                interval = "1d" if end - start > 2 * 86400 else "1h"
                edges = bucket_edges(start, end, interval, tz)
                edges[0] = max(edges[0], start)
                values = await self.evaluate_formula(formula, edges, interval, now)
                value = fx.aggregate(values, agg if agg not in (None, "", "auto") else "last")
            return {"value": value, "unit": unit, "start": start, "end": end, "coverage": None, "name": name}
        raise SourceError(f"Unbekannter Quelltyp '{stype}'")

    async def evaluate_formula(self, formula: str, edges: list[int], interval: str | None,
                               now: float | None = None) -> list[float | None]:
        constants = self.constants()
        defs = self.metric_defs()
        metrics = {k: v["formula"] for k, v in defs.items()}
        entities, lookback_s, lookback_b, _ = fx.dependencies(formula, metrics, constants)
        for e in entities:
            if not self.known_entity(e):
                raise fx.FormulaError(f"Unbekannte Entität '{e}'")
        tz = self.tz()
        # extend range backwards for windows / lags
        extra = 0
        ext_edges = list(edges)
        if (lookback_s or lookback_b) and len(edges) >= 2:
            if interval and interval in APPROX_SECONDS:
                extra = max(lookback_b, int(round(lookback_s / APPROX_SECONDS[interval])))
                first = edges[0]
                prefix = [add_interval(first, interval, tz, -k) for k in range(extra, 0, -1)]
                ext_edges = prefix + list(edges)
            else:
                span = edges[1] - edges[0]
                extra = max(lookback_b, int(round(lookback_s / span)) if span else 0)
                ext_edges = [edges[0] - span * k for k in range(extra, 0, -1)] + list(edges)
        loaded: dict[str, list[BucketStats]] = {}
        for e in entities:
            loaded[e] = await self.entity_buckets(e, ext_edges, now)
        metas = {e: self.entity_meta(e) for e in entities}
        ctx = fx.EvalContext(
            edges=ext_edges, tz=tz, interval=interval,
            entity_loader=lambda eid, _edges: loaded[eid],
            entity_kind=lambda eid: (metas.get(eid) or self.entity_meta(eid) or {}).get("kind"),
            entity_unit=lambda eid: (metas.get(eid) or {}).get("unit"),
            constants=constants, metrics=metrics,
        )
        values = await asyncio.to_thread(fx.evaluate, formula, ctx)
        return values[extra:]

    def validate(self, formula: str, self_key: str | None = None) -> dict:
        defs = self.metric_defs()
        metrics = {k: v["formula"] for k, v in defs.items() if k != self_key}
        res = fx.validate(
            formula,
            known_entities=self.known_entity,
            constants=self.constants(),
            metrics=metrics,
            entity_unit=lambda e: (self.entity_meta(e) or {}).get("unit"),
            metric_units={k: v["unit"] for k, v in defs.items()},
            self_key=self_key,
        )
        return res.as_dict()


def _stat_value(b: BucketStats, stat: str, kind: str) -> float | None:
    if stat in (None, "", "auto"):
        stat = "mean" if kind == MEASUREMENT else "delta"
    elif stat == "state":  # like the HA history graph: sensor value / meter reading
        stat = "mean" if kind == MEASUREMENT else "last"
    if stat == "coverage":
        return round(b.coverage, 4)
    if stat == "count":
        return float(b.count)
    return getattr(b, stat, None)
