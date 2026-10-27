"""Service container wiring all components together."""
from __future__ import annotations

import asyncio
import collections
import logging
import secrets
import time
from typing import Any

from .config import Config
from .core.analysis import AnalysisEngine
from .core.auth import AuthService
from .core.backup import BackupManager
from .core.engine import DataEngine
from .core.jobs import JobManager
from .core.settings_store import SettingsStore
from .core.store import Store
from .db import Database
from .ha.client import Endpoint, HAClient, build_ws_url
from .ha.recorder import Recorder
from .live import LiveHub

log = logging.getLogger(__name__)


class RingBufferHandler(logging.Handler):
    def __init__(self, capacity: int = 1000):
        super().__init__()
        self.records: collections.deque = collections.deque(maxlen=capacity)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.records.append({"ts": record.created, "level": record.levelname, "logger": record.name,
                                 "message": self.format(record)})
        except Exception:  # noqa: BLE001
            pass


LOG_BUFFER = RingBufferHandler()
LOG_BUFFER.setFormatter(logging.Formatter("%(message)s"))


class Services:
    def __init__(self, config: Config):
        self.config = config
        self.started_at = time.time()
        from .cli import prepare_database

        self.recovery = prepare_database(config)
        self.db = Database(config.db_path)
        self.schema_version = self.db.init()
        self.settings = SettingsStore(self.db)
        self.store = Store(self.db, self.settings)
        self.store.load_cache()
        self.jobs = JobManager(self.db)
        self.jobs.recover()
        self.auth = AuthService(self.db, self.settings)
        self.ha = HAClient(self._endpoint)
        self.live = LiveHub(self)
        self.recorder = Recorder(self.ha, self.store, self.settings, self.jobs, self.live.publish_state)
        self.engine = DataEngine(self.db, self.store, self.settings, self.ha)
        self.analysis = AnalysisEngine(self.engine)
        self.backups = BackupManager(self.db, config.backup_dir, self.settings)
        self.backups.before_restore.append(self._before_restore)
        self.backups.after_restore.append(self._after_restore)
        self.ha.status_listeners.append(lambda st: self.live.broadcast({"type": "ha_status", "status": st.as_dict()}))
        self.jobs.listeners.append(lambda job: self.live.broadcast({"type": "job", "job": job}))
        self.recorder.on_hourly.append(self._hourly)
        self.setup_token: str | None = None
        self._last_auto_backup_day: str | None = None

    # ------------------------------------------------------------------ HA endpoint

    def _endpoint(self) -> Endpoint | None:
        conf = self.settings.get("homeassistant")
        if conf.get("mode") == "manual" and conf.get("url") and conf.get("token"):
            return Endpoint(build_ws_url(conf["url"]), conf["token"], bool(conf.get("verify_ssl", True)), conf["url"])
        if self.config.ha_url and self.config.ha_token:
            return Endpoint(build_ws_url(self.config.ha_url), self.config.ha_token, True, self.config.ha_url)
        if self.config.supervisor_token:
            return Endpoint("ws://supervisor/core/websocket", self.config.supervisor_token, True, "Supervisor")
        return None

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        self.ha.start()
        self.recorder.start()
        if not self.auth.has_local_admin():
            self.setup_token = secrets.token_hex(4).upper()
            log.warning("Kein lokaler Administrator vorhanden. Einrichtungscode für den Direktzugriff: %s "
                        "(alternativ über die Home-Assistant-Seitenleiste einrichten)", self.setup_token)

    async def stop(self) -> None:
        await self.recorder.stop()
        await self.ha.stop()

    def _before_restore(self) -> None:
        try:
            self.store.flush()
        except Exception:  # noqa: BLE001
            log.exception("flush before restore failed")
        with self.store._buf_lock:
            self.store._buffer.clear()
        self.store._last_written.clear()

    def _after_restore(self) -> None:
        self.settings.invalidate()
        self.store.load_cache()

    async def _hourly(self) -> None:
        await asyncio.to_thread(self.auth.purge_sessions)
        conf = self.settings.get("backup")
        day = time.strftime("%Y-%m-%d")
        if conf.get("auto_enabled") and int(time.strftime("%H")) >= int(conf.get("auto_hour", 3)) \
                and self._last_auto_backup_day != day:
            existing = [b for b in self.backups.list() if b.get("kind") == "auto"
                        and time.strftime("%Y-%m-%d", time.localtime(b["created_at"])) == day]
            self._last_auto_backup_day = day
            if not existing:
                await asyncio.to_thread(self.backups.auto_backup)
                self.recorder.maintenance["last_auto_backup"] = time.time()

    def info(self) -> dict[str, Any]:
        from .config import VERSION

        return {
            "version": VERSION,
            "schema_version": self.schema_version,
            "started_at": self.started_at,
            "supervisor": self.config.in_supervisor,
            "data_dir": str(self.config.data_dir),
            "ingress_port": self.config.ingress_port,
            "direct_port": self.config.direct_port,
            "timezone": self.engine.tz_name(),
        }
