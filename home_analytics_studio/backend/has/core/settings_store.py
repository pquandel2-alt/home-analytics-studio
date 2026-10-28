"""Persistent application settings (JSON per section, stored in SQLite)."""
from __future__ import annotations

import copy
import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert

from ..db import Database, settings as settings_t

SECRET_MASK = "********"

DEFAULTS: dict[str, dict[str, Any]] = {
    "general": {
        "instance_name": "Home Analytics Studio",
        "timezone": "",  # empty -> Home Assistant time zone, fallback Europe/Berlin
        "language": "de",
        "currency": "€",
        "week_start": "monday",
        "default_dashboard": None,
    },
    "homeassistant": {
        "mode": "auto",  # auto (Supervisor) | manual
        "url": "",
        "token": "",
        "verify_ssl": True,
    },
    "storage": {
        "raw_retention_days": 90,
        "stats5m_retention_days": 730,
        "hourly_retention_days": 0,  # 0 = unlimited
        "flush_interval_seconds": 5,
        "min_interval_seconds": 0,  # throttle: ignore samples closer than this (0 = keep all)
        "min_free_disk_mb": 300,
        "max_db_size_mb": 0,  # 0 = unlimited
        "auto_vacuum": True,
        "auto_import_on_record": True,  # import HA history when recording is enabled
        "auto_import_statistics_days": 365,
        "auto_import_history_days": 10,
    },
    "appearance": {
        "preset": "dark-analytics",
        "overrides": {},
    },
    "security": {
        "session_hours": 720,
        "ingress_role": "admin",
        "allow_direct_login": True,
        "login_rate_limit": 10,
    },
    "ai": {
        "provider": "none",  # none | ollama | openai_compatible
        "ollama_url": "http://localhost:11434",
        "ollama_model": "llama3.1",
        "openai_base_url": "",
        "openai_api_key": "",
        "openai_model": "",
        "timeout_seconds": 120,
        "chatgpt_url": "https://chatgpt.com/",
    },
    "backup": {
        "auto_enabled": True,
        "auto_keep": 3,
        "auto_include_data": True,
        "auto_hour": 3,
    },
    "displays": {
        "tv_control_enabled": False,  # explicit opt-in: allow turning on linked TVs + opening the dashboard URL
        "tv_url": "",  # base URL the TV opens, e.g. http://192.168.178.101:8100 (empty = derived from HA internal URL)
        "boot_wait_seconds": 12,
    },
    "presentation": {
        "interval_seconds": 30,
        "refresh_seconds": 60,
        "show_clock": True,
    },
}

SECRETS = {("homeassistant", "token"), ("ai", "openai_api_key")}


class SettingsStore:
    def __init__(self, db: Database):
        self.db = db
        self._cache: dict[str, dict[str, Any]] | None = None

    def _load(self) -> dict[str, dict[str, Any]]:
        if self._cache is None:
            data = copy.deepcopy(DEFAULTS)
            with self.db.read() as conn:
                for key, value in conn.execute(select(settings_t.c.key, settings_t.c.value)):
                    try:
                        stored = json.loads(value)
                    except ValueError:
                        continue
                    if key in data and isinstance(stored, dict):
                        data[key].update(stored)
                    else:
                        data[key] = stored
            self._cache = data
        return self._cache

    def invalidate(self) -> None:
        self._cache = None

    def get(self, section: str, key: str | None = None, default: Any = None) -> Any:
        data = self._load().get(section, {})
        if key is None:
            return copy.deepcopy(data)
        return data.get(key, default)

    def all(self, mask_secrets: bool = True) -> dict[str, dict[str, Any]]:
        data = copy.deepcopy(self._load())
        if mask_secrets:
            for section, key in SECRETS:
                if data.get(section, {}).get(key):
                    data[section][key] = SECRET_MASK
        return data

    def update(self, section: str, values: dict[str, Any]) -> dict[str, Any]:
        if section not in DEFAULTS:
            raise KeyError(f"Unbekannter Einstellungsbereich: {section}")
        current = self.get(section)
        for key, value in values.items():
            if key not in DEFAULTS[section]:
                raise KeyError(f"Unbekannte Einstellung: {section}.{key}")
            if (section, key) in SECRETS and value == SECRET_MASK:
                continue  # unchanged secret
            default = DEFAULTS[section][key]
            if isinstance(default, bool):
                value = bool(value)
            elif isinstance(default, int) and not isinstance(default, bool) and value is not None:
                value = int(value)
            current[key] = value
        with self.db.write() as conn:
            stmt = insert(settings_t).values(key=section, value=json.dumps(current))
            conn.execute(stmt.on_conflict_do_update(index_elements=["key"], set_={"value": stmt.excluded.value}))
        self.invalidate()
        return current

    def replace_all(self, data: dict[str, dict[str, Any]]) -> None:
        """Used by restore: replaces every known section."""
        with self.db.write() as conn:
            for section, values in data.items():
                if section not in DEFAULTS or not isinstance(values, dict):
                    continue
                clean = {k: v for k, v in values.items() if k in DEFAULTS[section]}
                for s, k in SECRETS:
                    if s == section and clean.get(k) == SECRET_MASK:
                        clean.pop(k)
                stmt = insert(settings_t).values(key=section, value=json.dumps(clean))
                conn.execute(stmt.on_conflict_do_update(index_elements=["key"], set_={"value": stmt.excluded.value}))
        self.invalidate()
