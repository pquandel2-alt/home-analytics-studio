"""Connects the HA client with the store: live recording, gap backfill, maintenance."""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable

from ..core.jobs import JobManager
from ..core.store import Store
from .client import HAClient, parse_ha_time
from . import virtual
from .importer import import_history

log = logging.getLogger(__name__)

MAX_BACKFILL = 10 * 86400


class Recorder:
    def __init__(self, ha: HAClient, store: Store, settings, jobs: JobManager,
                 live_publish: Callable[[str, dict | None], Any] | None = None):
        self.ha = ha
        self.store = store
        self.settings = settings
        self.jobs = jobs
        self.live_publish = live_publish
        self._tasks: list[asyncio.Task] = []
        self.maintenance: dict[str, Any] = {"last_retention": None, "last_integrity": None, "integrity": None,
                                            "last_vacuum": None, "last_auto_backup": None}
        self.backfill_job: int | None = None
        self.on_hourly: list[Callable[[], Any]] = []
        ha.state_listeners.append(self._on_state)
        ha.connect_listeners.append(self._on_connect)

    # ------------------------------------------------------------------ events

    async def _on_state(self, entity_id: str, new: dict | None, old: dict | None) -> None:
        if self.live_publish:
            self.live_publish(entity_id, new)
        for vid in virtual.virtual_ids(entity_id):
            vinfo = self.store.get(vid)
            vstate = virtual.synthetic_state(vid, new)
            if self.live_publish:
                self.live_publish(vid, vstate)
            if vinfo is not None and vinfo.recorded and vstate is not None:
                ts = parse_ha_time(vstate.get("last_updated")) or time.time()
                self.store.add_state(vid, vstate["state"], vstate["attributes"], ts)
        info = self.store.get(entity_id)
        if info is None or not info.recorded:
            return
        if new is None:
            self.store.add_state(entity_id, None, {}, time.time())
            return
        ts = parse_ha_time(new.get("last_updated")) or time.time()
        self.store.add_state(entity_id, new.get("state"), new.get("attributes") or {}, ts)

    async def _on_connect(self) -> None:
        await asyncio.to_thread(self.sync_metadata)
        now = time.time()
        starts = {
            e.entity_id: max(e.last_ts / 1000.0, now - MAX_BACKFILL)
            for e in self.store.recorded_entities() if e.last_ts and now - e.last_ts / 1000.0 > 90
        }
        for info in self.store.recorded_entities():
            st = self.ha.state_of(info.entity_id)
            if not st:
                continue
            ts = parse_ha_time(st.get("last_updated")) or now
            self.store.add_state(info.entity_id, st.get("state"), st.get("attributes") or {}, ts)
        if starts:
            ids = sorted(starts)
            log.info("Backfilling %d entities after connection gap", len(ids))

            async def job(handle):
                return await import_history(self.ha, self.store, ids, starts, now, handle)

            self.backfill_job = self.jobs.start("backfill", {"entities": ids, "end": now}, job)

    def sync_metadata(self) -> None:
        for info in self.store.known_entities():
            st = self.ha.state_of(info.entity_id)
            if not st:
                continue
            area, device = self.ha.area_of(info.entity_id)
            self.store.update_metadata(info.entity_id, st.get("attributes") or {}, area, device)

    # ------------------------------------------------------------------ loops

    def start(self) -> None:
        self._tasks = [
            asyncio.create_task(self._flush_loop(), name="flush"),
            asyncio.create_task(self._rollup_loop(), name="rollup"),
            asyncio.create_task(self._maintenance_loop(), name="maintenance"),
        ]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await asyncio.to_thread(self.store.flush)

    async def _flush_loop(self) -> None:
        while True:
            interval = max(1, int(self.settings.get("storage", "flush_interval_seconds", 5) or 5))
            await asyncio.sleep(interval)
            try:
                await asyncio.to_thread(self.store.flush)
            except Exception:  # noqa: BLE001
                log.exception("flush failed – will retry")

    async def _rollup_loop(self) -> None:
        await asyncio.sleep(10)
        while True:
            try:
                await asyncio.to_thread(self.store.rollup)
            except Exception:  # noqa: BLE001
                log.exception("rollup failed")
            await asyncio.sleep(60)

    async def _maintenance_loop(self) -> None:
        await asyncio.sleep(30)
        last_daily = 0.0
        while True:
            try:
                await self.run_maintenance(daily=time.time() - last_daily > 86400)
                if time.time() - last_daily > 86400:
                    last_daily = time.time()
            except Exception:  # noqa: BLE001
                log.exception("maintenance failed")
            await asyncio.sleep(3600)

    async def run_maintenance(self, daily: bool = False) -> dict:
        result: dict[str, Any] = {}
        result["disk"] = await asyncio.to_thread(self.store.check_disk)
        result["retention"] = await asyncio.to_thread(self.store.apply_retention)
        self.maintenance["last_retention"] = time.time()
        if self.settings.get("storage", "auto_vacuum", True):
            await asyncio.to_thread(self.store.db.incremental_vacuum)
            self.maintenance["last_vacuum"] = time.time()
        await asyncio.to_thread(self.store.db.optimize)
        if daily:
            checks = await asyncio.to_thread(self.store.db.integrity_check, True)
            self.maintenance["integrity"] = "ok" if checks == ["ok"] else "; ".join(checks[:5])
            self.maintenance["last_integrity"] = time.time()
            result["integrity"] = self.maintenance["integrity"]
        for cb in self.on_hourly:
            try:
                res = cb()
                if asyncio.iscoroutine(res):
                    await res
            except Exception:  # noqa: BLE001
                log.exception("hourly hook failed")
        return result
