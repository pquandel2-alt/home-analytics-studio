"""Runtime configuration.

Values come from (in increasing priority):
  1. built-in defaults
  2. /data/options.json (written by the Home Assistant Supervisor)
  3. environment variables (HAS_*), used for standalone/dev operation
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

VERSION = "1.0.1"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Config:
    data_dir: Path = Path("/data")
    static_dir: Path | None = None
    log_level: str = "info"
    # Ingress listener (only reachable from the Supervisor ingress proxy)
    ingress_port: int = 8099
    # Direct LAN listener (login required). 0 disables it.
    direct_port: int = 8100
    host: str = "0.0.0.0"
    # IPs whose requests on the ingress port are trusted as authenticated
    # Home Assistant users (Supervisor ingress gateway).
    ingress_trusted_ips: list[str] = field(default_factory=lambda: ["172.30.32.2"])
    supervisor_token: str | None = None
    ha_url: str | None = None  # e.g. http://homeassistant.local:8123 (standalone)
    ha_token: str | None = None
    base_url: str = ""  # public base URL behind reverse proxy, used for share links
    secure_cookies: bool = False
    trust_proxy_headers: bool = False

    @property
    def db_path(self) -> Path:
        return self.data_dir / "has.db"

    @property
    def backup_dir(self) -> Path:
        return self.data_dir / "backups"

    @property
    def upload_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def in_supervisor(self) -> bool:
        return bool(self.supervisor_token)


def load_config() -> Config:
    cfg = Config()
    cfg.data_dir = Path(os.environ.get("HAS_DATA_DIR", "/data"))
    options_file = cfg.data_dir / "options.json"
    options: dict = {}
    if options_file.exists():
        try:
            options = json.loads(options_file.read_text("utf-8"))
        except (OSError, ValueError):
            options = {}
    cfg.log_level = str(options.get("log_level", cfg.log_level))
    cfg.secure_cookies = bool(options.get("secure_cookies", cfg.secure_cookies))
    cfg.trust_proxy_headers = bool(options.get("trust_proxy_headers", cfg.trust_proxy_headers))
    cfg.base_url = str(options.get("base_url", "") or "")

    cfg.supervisor_token = os.environ.get("SUPERVISOR_TOKEN") or None
    cfg.ha_url = os.environ.get("HAS_HA_URL") or None
    cfg.ha_token = os.environ.get("HAS_HA_TOKEN") or None
    cfg.log_level = os.environ.get("HAS_LOG_LEVEL", cfg.log_level)
    cfg.ingress_port = int(os.environ.get("HAS_INGRESS_PORT", cfg.ingress_port))
    cfg.direct_port = int(os.environ.get("HAS_DIRECT_PORT", cfg.direct_port))
    cfg.host = os.environ.get("HAS_HOST", cfg.host)
    cfg.base_url = os.environ.get("HAS_BASE_URL", cfg.base_url)
    cfg.secure_cookies = _env_bool("HAS_SECURE_COOKIES", cfg.secure_cookies)
    cfg.trust_proxy_headers = _env_bool("HAS_TRUST_PROXY_HEADERS", cfg.trust_proxy_headers)
    trusted = os.environ.get("HAS_INGRESS_TRUSTED_IPS")
    if trusted is not None:
        cfg.ingress_trusted_ips = [ip.strip() for ip in trusted.split(",") if ip.strip()]
    static = os.environ.get("HAS_STATIC_DIR")
    if static:
        cfg.static_dir = Path(static)
    else:
        candidate = Path(__file__).resolve().parent.parent / "static"
        cfg.static_dir = candidate if candidate.exists() else None
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    cfg.backup_dir.mkdir(parents=True, exist_ok=True)
    cfg.upload_dir.mkdir(parents=True, exist_ok=True)
    return cfg
