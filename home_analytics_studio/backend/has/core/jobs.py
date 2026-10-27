"""Background job tracking (history imports, rebuilds ...)."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable

from sqlalchemy import text

from ..db import Database

log = logging.getLogger(__name__)


class JobCancelled(Exception):
    pass


class JobHandle:
    def __init__(self, manager: "JobManager", job_id: int):
        self.manager = manager
        self.id = job_id
        self.cancelled = False

    def progress(self, fraction: float, message: str | None = None) -> None:
        if self.cancelled:
            raise JobCancelled()
        self.manager._update(self.id, progress=max(0.0, min(1.0, fraction)), message=message)


class JobManager:
    def __init__(self, db: Database):
        self.db = db
        self._tasks: dict[int, tuple[asyncio.Task, JobHandle]] = {}
        self.listeners: list[Callable[[dict], Any]] = []

    def recover(self) -> None:
        """Jobs that were running when the add-on stopped are marked as failed."""
        with self.db.write() as conn:
            conn.execute(text("UPDATE jobs SET status='failed', message='Durch Neustart unterbrochen', updated_at=:t"
                              " WHERE status IN ('queued','running')"), {"t": time.time()})

    def _update(self, job_id: int, **fields: Any) -> None:
        fields["updated_at"] = time.time()
        if "result" in fields and not isinstance(fields["result"], (str, type(None))):
            fields["result"] = json.dumps(fields["result"])
        sets = ", ".join(f"{k}=:{k}" for k in fields)
        with self.db.write() as conn:
            conn.execute(text(f"UPDATE jobs SET {sets} WHERE id=:id"), {**fields, "id": job_id})
        job = self.get(job_id)
        for cb in self.listeners:
            try:
                cb(job)
            except Exception:  # noqa: BLE001
                pass

    def start(self, job_type: str, params: dict, fn: Callable[[JobHandle], Awaitable[Any]]) -> int:
        now = time.time()
        with self.db.write() as conn:
            res = conn.execute(
                text("INSERT INTO jobs(type, status, progress, message, params, created_at, updated_at)"
                     " VALUES (:t, 'running', 0, 'Gestartet', :p, :n, :n)"),
                {"t": job_type, "p": json.dumps(params), "n": now},
            )
            job_id = int(res.lastrowid)
        handle = JobHandle(self, job_id)

        async def runner() -> None:
            try:
                result = await fn(handle)
                self._update(job_id, status="done", progress=1.0, message="Abgeschlossen", result=result)
            except (JobCancelled, asyncio.CancelledError):
                self._update(job_id, status="cancelled", message="Abgebrochen")
            except Exception as err:  # noqa: BLE001
                log.exception("Job %s failed", job_id)
                self._update(job_id, status="failed", message=f"{type(err).__name__}: {err}")
            finally:
                self._tasks.pop(job_id, None)

        task = asyncio.create_task(runner(), name=f"job-{job_id}")
        self._tasks[job_id] = (task, handle)
        return job_id

    def cancel(self, job_id: int) -> bool:
        entry = self._tasks.get(job_id)
        if not entry:
            return False
        entry[1].cancelled = True
        entry[0].cancel()
        return True

    def get(self, job_id: int) -> dict | None:
        with self.db.read() as conn:
            row = conn.execute(text("SELECT * FROM jobs WHERE id=:id"), {"id": job_id}).mappings().first()
        return _job(row) if row else None

    def list(self, limit: int = 50) -> list[dict]:
        with self.db.read() as conn:
            rows = conn.execute(text("SELECT * FROM jobs ORDER BY id DESC LIMIT :l"), {"l": limit}).mappings().all()
        return [_job(r) for r in rows]

    async def wait(self, job_id: int, timeout: float = 60) -> dict | None:
        entry = self._tasks.get(job_id)
        if entry:
            try:
                await asyncio.wait_for(asyncio.shield(entry[0]), timeout)
            except asyncio.TimeoutError:
                pass
        return self.get(job_id)


def _job(row) -> dict:
    d = dict(row)
    for key in ("params", "result"):
        if d.get(key):
            try:
                d[key] = json.loads(d[key])
            except ValueError:
                pass
    return d
