"""Backups (integrity, restore), migrations, corruption recovery, persistence across restarts."""
import json
import sqlite3
import time
import zipfile

import pytest
from sqlalchemy import create_engine, text

from has.cli import pre_backup, post_backup, prepare_database, SNAPSHOT_NAME
from has.core.backup import BackupError, BackupManager
from has.db import MIGRATIONS, SCHEMA_VERSION, Database, get_schema_version, run_migrations


def _seed(db: Database):
    with db.write() as conn:
        conn.execute(text("INSERT INTO dashboards(name, theme, settings, created_at, updated_at) VALUES ('D', '{}', '{}', 0, 0)"))
        conn.execute(text("INSERT INTO metrics(name, key, formula, aggregation, decimals, created_at, updated_at) VALUES ('M', 'm', '1+1', 'auto', 2, 0, 0)"))
        conn.execute(text("INSERT INTO entities(entity_id, recorded, kind, created_at, sample_count) VALUES ('sensor.a', 1, 'auto', 0, 0)"))
        conn.execute(text("INSERT INTO samples(entity_ref, ts, value) VALUES (1, 1000, 1.5)"))


def test_migrations_from_older_version(tmp_path):
    path = tmp_path / "old.db"
    engine = create_engine(f"sqlite:///{path}")
    assert run_migrations(engine, MIGRATIONS[:1]) == 1
    with engine.begin() as conn:
        assert get_schema_version(conn) == 1
    # simulate a v1 database without the later column
    with engine.begin() as conn:
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info(entities)"))}
    assert run_migrations(engine) == SCHEMA_VERSION
    with engine.begin() as conn:
        assert get_schema_version(conn) == SCHEMA_VERSION
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info(entities)"))}
        idx = {r[1] for r in conn.execute(text("PRAGMA index_list(samples)"))}
    assert "raw_from" in cols and "ix_samples_ts" in idx
    # idempotent
    assert run_migrations(engine) == SCHEMA_VERSION


def test_newer_schema_is_refused(tmp_path):
    db = Database(tmp_path / "n.db")
    db.init()
    with db.write() as conn:
        conn.execute(text("UPDATE meta SET value='999' WHERE key='schema_version'"))
    with pytest.raises(RuntimeError, match="neuer"):
        run_migrations(db.engine)


def test_wal_mode_enabled(db):
    with db.read() as conn:
        assert conn.exec_driver_sql("PRAGMA journal_mode").scalar().lower() == "wal"


def test_backup_create_verify_restore_full(db, tmp_path):
    _seed(db)
    bm = BackupManager(db, tmp_path / "backups")
    b = bm.create(include_data=True)
    assert bm.verify(bm.path_for(b["name"]))["ok"]
    # change data after backup
    with db.write() as conn:
        conn.execute(text("DELETE FROM dashboards"))
        conn.execute(text("DELETE FROM samples"))
    res = bm.restore(b["name"], "full")
    assert res["mode"] == "full" and res["safety_backup"]
    with db.read() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM dashboards")).scalar() == 1
        assert conn.execute(text("SELECT value FROM samples")).scalar() == 1.5


def test_backup_restore_config_only_keeps_measurements(db, tmp_path):
    _seed(db)
    bm = BackupManager(db, tmp_path / "backups")
    b = bm.create(include_data=False)
    with db.write() as conn:
        conn.execute(text("DELETE FROM metrics"))
        conn.execute(text("INSERT INTO samples(entity_ref, ts, value) VALUES (1, 2000, 7)"))
    bm.restore(b["name"], "config")
    with db.read() as conn:
        assert conn.execute(text("SELECT key FROM metrics")).scalar() == "m"
        assert conn.execute(text("SELECT COUNT(*) FROM samples")).scalar() == 2


def test_tampered_backup_is_rejected(db, tmp_path):
    _seed(db)
    bm = BackupManager(db, tmp_path / "backups")
    b = bm.create(include_data=True)
    src = bm.path_for(b["name"])
    bad = tmp_path / "backups" / "tampered.zip"
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(bad, "w") as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "config.json":
                data = data.replace(b'"D"', b'"X"')
            zout.writestr(item, data)
    res = bm.verify(bad)
    assert not res["ok"] and any("Prüfsumme" in e for e in res["errors"])
    with pytest.raises(BackupError):
        bm.restore("tampered.zip", "full")
    junk = tmp_path / "backups" / "junk.zip"
    junk.write_bytes(b"not a zip")
    assert not bm.verify(junk)["ok"]
    with pytest.raises(BackupError):
        bm.path_for("../etc/passwd.zip")


def test_auto_backup_retention(db, tmp_path):
    class S:
        def get(self, section):
            return {"auto_enabled": True, "auto_keep": 2, "auto_include_data": False}

    bm = BackupManager(db, tmp_path / "backups", S())
    for _ in range(3):
        bm.auto_backup()
        time.sleep(1.05)
    assert len(list((tmp_path / "backups").glob("has-auto-*.zip"))) == 2


def test_corrupt_database_is_recovered_from_backup(config):
    db = Database(config.db_path)
    db.init()
    _seed(db)
    BackupManager(db, config.backup_dir).create(include_data=True)
    db.dispose()
    for suffix in ("-wal", "-shm"):
        p = config.db_path.with_name(config.db_path.name + suffix)
        if p.exists():
            p.unlink()
    config.db_path.write_bytes(b"garbage" * 1000)
    res = prepare_database(config)
    assert res["action"] == "restored_from_backup"
    con = sqlite3.connect(str(config.db_path))
    assert con.execute("SELECT COUNT(*) FROM dashboards").fetchone()[0] == 1
    con.close()


def test_ha_backup_hooks_and_restore_from_snapshot(config, monkeypatch):
    monkeypatch.setenv("HAS_DATA_DIR", str(config.data_dir))
    db = Database(config.db_path)
    db.init()
    _seed(db)
    assert pre_backup() == 0
    snap = config.data_dir / SNAPSHOT_NAME
    assert snap.exists()
    db.dispose()
    # simulate HA restore: live DB excluded from the backup, snapshot present
    for p in config.data_dir.glob("has.db*"):
        p.unlink()
    res = prepare_database(config)
    assert res["action"] == "restored_from_ha_snapshot"
    assert not snap.exists()
    db2 = Database(config.db_path)
    db2.init()
    with db2.read() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM metrics")).scalar() == 1
    db2.dispose()
    assert post_backup() == 0


def test_persistence_across_restart(config):
    from has.services import Services

    s1 = Services(config)
    s1.store.set_recording(["sensor.x"], True, {"sensor.x": {"unit_of_measurement": "W"}})
    s1.store.add_state("sensor.x", "42", {}, time.time() - 5)
    s1.store.flush()
    s1.settings.update("general", {"instance_name": "Persistenz"})
    s1.db.dispose()
    s2 = Services(config)
    assert s2.store.get("sensor.x").recorded
    assert s2.store.get("sensor.x").last_value == 42
    assert s2.settings.get("general", "instance_name") == "Persistenz"
    s2.db.dispose()


def test_backup_manifest_contents(db, tmp_path):
    _seed(db)
    bm = BackupManager(db, tmp_path / "b")
    b = bm.create(include_data=True)
    with zipfile.ZipFile(bm.path_for(b["name"])) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        assert set(manifest["files"]) == {"config.json", "has.db"}
        assert manifest["schema_version"] == SCHEMA_VERSION
