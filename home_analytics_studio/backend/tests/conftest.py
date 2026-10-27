from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from has.config import Config  # noqa: E402
from has.core.settings_store import SettingsStore  # noqa: E402
from has.core.store import Store  # noqa: E402
from has.db import Database  # noqa: E402


@pytest.fixture
def db(tmp_path: Path) -> Database:
    d = Database(tmp_path / "test.db")
    d.init()
    yield d
    d.dispose()


@pytest.fixture
def settings(db: Database) -> SettingsStore:
    return SettingsStore(db)


@pytest.fixture
def store(db: Database, settings: SettingsStore) -> Store:
    s = Store(db, settings)
    s.load_cache()
    return s


@pytest.fixture
def config(tmp_path: Path) -> Config:
    cfg = Config()
    cfg.data_dir = tmp_path / "data"
    cfg.data_dir.mkdir()
    cfg.backup_dir.mkdir()
    cfg.upload_dir.mkdir()
    cfg.ingress_port = 18099
    cfg.direct_port = 0
    cfg.ingress_trusted_ips = ["127.0.0.1"]
    cfg.static_dir = None
    return cfg
