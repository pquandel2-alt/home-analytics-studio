"""Import of history and long-term statistics from Home Assistant."""
from __future__ import annotations

import asyncio
import logging
import time

from ..core import units
from ..core.jobs import JobHandle
from ..core.stats import MEASUREMENT
from ..core.store import Store, parse_state_value
from .client import HAClient

log = logging.getLogger(__name__)

HISTORY_CHUNK = 86400  # one day per request
STATS_CHUNK = 30 * 86400


async def import_history(ha: HAClient, store: Store, entity_ids: list[str], start: float | dict[str, float],
                         end: float, job: JobHandle | None = None) -> dict:
    """Import raw state history (limited by the HA recorder's purge_keep_days).

    ``start`` may be a dict with an individual start time per entity."""
    starts = start if isinstance(start, dict) else {eid: start for eid in entity_ids}
    total_chunks = sum(max(1, int((end - starts[e]) // HISTORY_CHUNK) + 1) for e in entity_ids) or 1
    done = 0
    inserted = 0
    for eid in entity_ids:
        info = store.ensure_entity(eid, (ha.states.get(eid) or {}).get("attributes"))
        t = starts[eid]
        while t < end:
            t2 = min(end, t + HISTORY_CHUNK)
            data = await ha.history([eid], t, t2)
            rows: list[tuple[int, float | None]] = []
            for ts, state, attrs in data.get(eid, []):
                if ts < t:  # include_start_time_state may yield an older state stamped at start
                    ts = t
                value = parse_state_value(state)
                value = store.convert_value(info, value, (attrs or {}).get("unit_of_measurement"))
                rows.append((int(round(ts * 1000)), value))
            inserted += await asyncio.to_thread(store.insert_samples, info.id, rows)
            done += 1
            if job:
                job.progress(done / total_chunks, f"{eid}: {time.strftime('%Y-%m-%d', time.localtime(t))}")
            t = t2
    await asyncio.to_thread(store.rollup, None, entity_ids)
    return {"inserted_samples": inserted, "entities": len(entity_ids)}


async def import_statistics(ha: HAClient, store: Store, entity_ids: list[str], start: float, end: float,
                            job: JobHandle | None = None) -> dict:
    """Import hourly long-term statistics. Never overwrites locally recorded hours."""
    meta = await ha.statistics_metadata(entity_ids)
    imported = 0
    skipped: list[str] = []
    total = max(1, len(entity_ids)) * max(1, int((end - start) // STATS_CHUNK) + 1)
    done = 0
    for eid in entity_ids:
        md = meta.get(eid)
        if not md:
            skipped.append(eid)
            done += max(1, int((end - start) // STATS_CHUNK) + 1)
            continue
        info = store.ensure_entity(eid, (ha.states.get(eid) or {}).get("attributes"))
        stat_unit = md.get("statistics_unit_of_measurement") or md.get("display_unit_of_measurement")
        target = info.unit or units.canonical_unit(stat_unit)
        conv = (lambda v: units.convert(v, stat_unit, target)) if stat_unit and target else (lambda v: v)
        has_sum = bool(md.get("has_sum"))
        prev_sum: float | None = None
        t = start
        while t < end:
            t2 = min(end, t + STATS_CHUNK)
            data = await ha.statistics([eid], t, t2, "hour")
            rows = []
            for r in data.get(eid, []):
                ts = int(r["start"])
                row = {"ts": ts, "mean": None, "min": None, "max": None, "first": None, "last": None,
                       "delta": None, "count": 0, "covered": 3600.0}
                if has_sum and info.kind != MEASUREMENT:
                    change = r.get("change")
                    s = r.get("sum")
                    if change is None and s is not None and prev_sum is not None:
                        change = s - prev_sum
                    if s is not None:
                        prev_sum = s
                    if change is None:
                        continue
                    row["delta"] = conv(change) if stat_unit else change
                    if r.get("state") is not None:
                        row["last"] = conv(r["state"])
                else:
                    for key in ("mean", "min", "max"):
                        if r.get(key) is not None:
                            row[key] = conv(r[key])
                    if row["mean"] is None:
                        if r.get("state") is None:
                            continue
                        row["mean"] = conv(r["state"])
                    row["first"] = row["last"] = row["mean"]
                rows.append(row)
            imported += await asyncio.to_thread(store.import_hourly_statistics, info.id, rows)
            done += 1
            if job:
                job.progress(done / total, f"{eid}: {time.strftime('%Y-%m-%d', time.localtime(t))}")
            t = t2
    return {"imported_hours": imported, "skipped_without_statistics": skipped}
