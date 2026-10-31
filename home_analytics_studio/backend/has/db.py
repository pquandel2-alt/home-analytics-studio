"""Database layer: SQLite (WAL) via SQLAlchemy Core, schema + migrations."""
from __future__ import annotations

import logging
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator

from sqlalchemy import (
    Column,
    Float,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    create_engine,
    event,
    text,
)
from sqlalchemy.engine import Connection, Engine

log = logging.getLogger(__name__)

metadata = MetaData()

meta = Table("meta", metadata, Column("key", Text, primary_key=True), Column("value", Text))

settings = Table(
    "settings", metadata, Column("key", Text, primary_key=True), Column("value", Text, nullable=False)
)

users = Table(
    "users",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("username", Text, nullable=False, unique=True),
    Column("display_name", Text),
    Column("password_hash", Text),
    Column("role", Text, nullable=False, server_default="viewer"),  # admin | editor | viewer
    Column("source", Text, nullable=False, server_default="local"),  # local | homeassistant
    Column("created_at", Float, nullable=False),
    Column("last_login", Float),
)

sessions = Table(
    "sessions",
    metadata,
    Column("token_hash", Text, primary_key=True),
    Column("user_id", Integer),
    Column("kind", Text, nullable=False, server_default="login"),  # login | share
    Column("share_id", Integer),
    Column("csrf", Text, nullable=False),
    Column("created_at", Float, nullable=False),
    Column("expires_at", Float, nullable=False),
    Column("last_seen", Float),
    Column("user_agent", Text),
)

share_links = Table(
    "share_links",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("name", Text, nullable=False),
    Column("token_hash", Text, nullable=False, unique=True),
    Column("token_hint", Text),
    Column("dashboard_id", Integer, nullable=False),
    Column("created_by", Integer),
    Column("created_at", Float, nullable=False),
    Column("expires_at", Float),
    Column("last_used", Float),
)

api_tokens = Table(
    "api_tokens",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("name", Text, nullable=False),
    Column("token_hash", Text, nullable=False, unique=True),  # sha256 only, never the token itself
    Column("token_hint", Text),
    Column("user_id", Integer, nullable=False),
    Column("role", Text, nullable=False),  # cap: effective role = min(token role, current user role)
    Column("created_by", Integer),
    Column("created_at", Float, nullable=False),
    Column("expires_at", Float),
    Column("last_used", Float),
    Column("revoked_at", Float),
)

entities = Table(
    "entities",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("entity_id", Text, nullable=False, unique=True),
    Column("recorded", Integer, nullable=False, server_default=text('0')),
    Column("kind", Text, nullable=False, server_default="auto"),  # auto|measurement|counter|total
    Column("name", Text),
    Column("source_unit", Text),
    Column("unit", Text),  # canonical unit of stored values
    Column("device_class", Text),
    Column("state_class", Text),
    Column("area", Text),
    Column("device", Text),
    Column("retention_days", Integer),
    Column("created_at", Float, nullable=False),
    Column("recording_since", Float),
    Column("last_ts", Integer),
    Column("last_value", Float),
    Column("sample_count", Integer, nullable=False, server_default=text('0')),
    Column("rolled_5m", Integer),  # rollup watermark (epoch s, exclusive)
    Column("rolled_1h", Integer),
    Column("notes", Text),
    Column("raw_from", Integer),  # raw samples before this epoch second were purged
    Column("max_rate", Float),  # counters: max plausible consumption per hour (larger jumps are ignored)
)

# Raw measurements. ts in epoch milliseconds (UTC). value NULL = unavailable marker.
samples = Table(
    "samples",
    metadata,
    Column("entity_ref", Integer, nullable=False),
    Column("ts", Integer, nullable=False),
    Column("value", Float),
    PrimaryKeyConstraint("entity_ref", "ts"),
    sqlite_with_rowid=False,
)


def _stats_table(name: str, with_source: bool = False) -> Table:
    cols = [
        Column("entity_ref", Integer, nullable=False),
        Column("ts", Integer, nullable=False),  # bucket start epoch seconds UTC
        Column("mean", Float),
        Column("min", Float),
        Column("max", Float),
        Column("first", Float),
        Column("last", Float),
        Column("delta", Float),
        Column("count", Integer, nullable=False, server_default=text('0')),
        Column("covered", Float, nullable=False, server_default=text('0')),  # seconds with known value
    ]
    if with_source:
        cols.append(Column("source", Text, nullable=False, server_default="local"))
    return Table(name, metadata, *cols, PrimaryKeyConstraint("entity_ref", "ts"), sqlite_with_rowid=False)


stats_5m = _stats_table("stats_5m")
stats_1h = _stats_table("stats_1h", with_source=True)

metrics = Table(
    "metrics",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("name", Text, nullable=False),
    Column("key", Text, nullable=False, unique=True),
    Column("description", Text),
    Column("formula", Text, nullable=False),
    Column("unit", Text),
    Column("aggregation", Text, nullable=False, server_default="sum"),  # sum|mean|last|min|max
    Column("decimals", Integer, nullable=False, server_default=text('2')),
    Column("color", Text),
    Column("builder", Text),  # JSON of visual builder state
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

constants = Table(
    "constants",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("key", Text, nullable=False, unique=True),
    Column("name", Text),
    Column("value", Float, nullable=False),
    Column("unit", Text),
    Column("description", Text),
    Column("updated_at", Float, nullable=False),
)

dashboards = Table(
    "dashboards",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("name", Text, nullable=False),
    Column("description", Text),
    Column("icon", Text),
    Column("sort", Integer, nullable=False, server_default=text('0')),
    Column("theme", Text, nullable=False, server_default="{}"),  # JSON
    Column("settings", Text, nullable=False, server_default="{}"),  # JSON grid/navigation/presentation
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

pages = Table(
    "pages",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("dashboard_id", Integer, nullable=False),
    Column("title", Text, nullable=False),
    Column("icon", Text),
    Column("sort", Integer, nullable=False, server_default=text('0')),
    Column("hidden", Integer, nullable=False, server_default=text('0')),
    Column("settings", Text, nullable=False, server_default="{}"),
    Column("widgets", Text, nullable=False, server_default="[]"),
    Column("layouts", Text, nullable=False, server_default="{}"),
    Column("version", Integer, nullable=False, server_default=text('1')),
    Column("updated_at", Float, nullable=False),
    Index("ix_pages_dashboard", "dashboard_id"),
)

jobs = Table(
    "jobs",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("type", Text, nullable=False),
    Column("status", Text, nullable=False),  # queued|running|done|failed|cancelled
    Column("progress", Float, nullable=False, server_default=text('0')),
    Column("message", Text),
    Column("params", Text),
    Column("result", Text),
    Column("created_at", Float, nullable=False),
    Column("updated_at", Float, nullable=False),
)

displays = Table(
    "displays",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("name", Text, nullable=False),
    Column("token_hash", Text, nullable=False, unique=True),
    Column("pair_code", Text),
    Column("paired", Integer, nullable=False, server_default=text("0")),
    Column("current", Text),  # JSON: dashboard_id, page_id, present, ts
    Column("created_at", Float, nullable=False),
    Column("last_seen", Float),
    Column("user_agent", Text),
    Column("screen", Text),
    Column("tv_entity", Text),  # linked media_player (opened remotely, see displays.launch)
    Column("launch_token", Text),  # read-only display token embedded in the URL opened on the TV
    Column("last_launch", Float),
    Column("last_launch_error", Text),
    Column("launch_mode", Text),  # url | app (detected automatically)
    Column("launch_app", Text),  # app id that brought up the dashboard (app mode)
)

audit_log = Table(
    "audit_log",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("ts", Float, nullable=False),
    Column("user", Text),
    Column("action", Text, nullable=False),
    Column("detail", Text),
)


# --------------------------------------------------------------------------- migrations

Migration = Callable[[Connection], None]


def _m1_initial(conn: Connection) -> None:
    metadata.create_all(conn)


def _m2_indexes(conn: Connection) -> None:
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_samples_ts ON samples(ts)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_sessions_expiry ON sessions(expires_at)"))
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_log(ts)"))


def _m3_raw_from(conn: Connection) -> None:
    cols = {r[1] for r in conn.execute(text("PRAGMA table_info(entities)"))}
    if "raw_from" not in cols:
        conn.execute(text("ALTER TABLE entities ADD COLUMN raw_from INTEGER"))


def _m4_max_rate(conn: Connection) -> None:
    cols = {r[1] for r in conn.execute(text("PRAGMA table_info(entities)"))}
    if "max_rate" not in cols:
        conn.execute(text("ALTER TABLE entities ADD COLUMN max_rate REAL"))


def _m5_displays(conn: Connection) -> None:
    displays.create(conn, checkfirst=True)


def _m6_tv_launch(conn: Connection) -> None:
    cols = {r[1] for r in conn.execute(text("PRAGMA table_info(displays)"))}
    for name, typ in (("tv_entity", "TEXT"), ("launch_token", "TEXT"), ("last_launch", "REAL"), ("last_launch_error", "TEXT")):
        if name not in cols:
            conn.execute(text(f"ALTER TABLE displays ADD COLUMN {name} {typ}"))


def _m7_launch_mode(conn: Connection) -> None:
    cols = {r[1] for r in conn.execute(text("PRAGMA table_info(displays)"))}
    for name in ("launch_mode", "launch_app"):
        if name not in cols:
            conn.execute(text(f"ALTER TABLE displays ADD COLUMN {name} TEXT"))


def _m8_api_tokens(conn: Connection) -> None:
    # additive only: creates a new table, touches no existing data
    api_tokens.create(conn, checkfirst=True)
    conn.execute(text("CREATE INDEX IF NOT EXISTS ix_api_tokens_user ON api_tokens(user_id)"))


MIGRATIONS: list[tuple[int, str, Migration]] = [
    (1, "initial schema", _m1_initial),
    (2, "secondary indexes", _m2_indexes),
    (3, "raw retention watermark", _m3_raw_from),
    (4, "counter plausibility limit", _m4_max_rate),
    (5, "remote displays", _m5_displays),
    (6, "tv remote launch", _m6_tv_launch),
    (7, "tv launch mode", _m7_launch_mode),
    (8, "personal API tokens", _m8_api_tokens),
]

SCHEMA_VERSION = MIGRATIONS[-1][0]


def get_schema_version(conn: Connection) -> int:
    exists = conn.execute(
        text("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    ).first()
    if not exists:
        return 0
    row = conn.execute(text("SELECT value FROM meta WHERE key='schema_version'")).first()
    return int(row[0]) if row else 0


def run_migrations(engine: Engine, migrations: list[tuple[int, str, Migration]] | None = None) -> int:
    migrations = migrations or MIGRATIONS
    with engine.begin() as conn:
        current = get_schema_version(conn)
        latest = migrations[-1][0]
        if current > latest:
            raise RuntimeError(
                f"Das Datenbankschema (Version {current}) ist neuer als diese Anwendung unterstützt ({latest})."
            )
        for version, label, fn in migrations:
            if version <= current:
                continue
            log.info("Applying migration %s: %s", version, label)
            fn(conn)
            if version == 1 or get_schema_version(conn) == 0:
                meta.create(conn, checkfirst=True)
            conn.execute(
                text("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', :v)"),
                {"v": str(version)},
            )
            current = version
    return current


# --------------------------------------------------------------------------- engine


class Database:
    """Owns the engine and a process-wide write lock (SQLite allows one writer)."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.write_lock = threading.RLock()
        self.engine = self._make_engine()

    def _make_engine(self) -> Engine:
        engine = create_engine(
            f"sqlite:///{self.path}",
            connect_args={"check_same_thread": False, "timeout": 30},
            pool_pre_ping=False,
        )

        @event.listens_for(engine, "connect")
        def _on_connect(dbapi_conn: sqlite3.Connection, _record) -> None:  # noqa: ANN001
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=30000")
            cur.execute("PRAGMA temp_store=MEMORY")
            cur.execute("PRAGMA cache_size=-8000")
            cur.execute("PRAGMA auto_vacuum=INCREMENTAL")
            cur.close()

        return engine

    def init(self) -> int:
        version = run_migrations(self.engine)
        return version

    @contextmanager
    def write(self) -> Iterator[Connection]:
        with self.write_lock:
            with self.engine.begin() as conn:
                yield conn

    @contextmanager
    def read(self) -> Iterator[Connection]:
        with self.engine.connect() as conn:
            yield conn

    def dispose(self) -> None:
        self.engine.dispose()

    def reopen(self) -> None:
        with self.write_lock:
            self.engine.dispose()
            self.engine = self._make_engine()

    # ------------------------------------------------------------------ maintenance

    def integrity_check(self, quick: bool = True) -> list[str]:
        pragma = "quick_check" if quick else "integrity_check"
        with self.engine.connect() as conn:
            rows = conn.exec_driver_sql(f"PRAGMA {pragma}").fetchall()
        return [r[0] for r in rows]

    def checkpoint(self, mode: str = "TRUNCATE") -> None:
        with self.write_lock:
            with self.engine.connect() as conn:
                conn.exec_driver_sql(f"PRAGMA wal_checkpoint({mode})")

    def snapshot_to(self, target: Path) -> None:
        """Consistent online copy via the SQLite backup API."""
        target = Path(target)
        tmp = target.with_suffix(target.suffix + ".tmp")
        if tmp.exists():
            tmp.unlink()
        with self.write_lock:
            src = sqlite3.connect(str(self.path), timeout=30)
            try:
                dst = sqlite3.connect(str(tmp))
                try:
                    src.backup(dst)
                    dst.execute("PRAGMA journal_mode=DELETE")
                finally:
                    dst.close()
            finally:
                src.close()
        tmp.replace(target)

    def incremental_vacuum(self, pages: int = 2000) -> None:
        with self.write_lock:
            with self.engine.connect() as conn:
                conn.exec_driver_sql(f"PRAGMA incremental_vacuum({int(pages)})")

    def vacuum(self) -> None:
        with self.write_lock:
            with self.engine.connect() as conn:
                conn.exec_driver_sql("VACUUM")

    def optimize(self) -> None:
        with self.engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA optimize")

    def size_info(self) -> dict:
        info = {"db_bytes": 0, "wal_bytes": 0}
        if self.path.exists():
            info["db_bytes"] = self.path.stat().st_size
        wal = Path(str(self.path) + "-wal")
        if wal.exists():
            info["wal_bytes"] = wal.stat().st_size
        with self.engine.connect() as conn:
            page_size = conn.exec_driver_sql("PRAGMA page_size").scalar() or 0
            page_count = conn.exec_driver_sql("PRAGMA page_count").scalar() or 0
            free = conn.exec_driver_sql("PRAGMA freelist_count").scalar() or 0
        info["page_size"] = page_size
        info["page_count"] = page_count
        info["free_bytes"] = free * page_size
        return info


def now() -> float:
    return time.time()
