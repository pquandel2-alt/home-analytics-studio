"""Supervisor backup hooks and start-up database recovery."""
from __future__ import annotations

import logging
import os
import shutil
import sqlite3
import time
import zipfile
from pathlib import Path

from .config import Config, load_config
from .core.backup import snapshot_for_ha_backup

log = logging.getLogger(__name__)

SNAPSHOT_NAME = "ha_backup_snapshot.db"


def pre_backup() -> int:
    """backup_pre hook: write a consistent snapshot that the HA backup includes.

    The live database files are excluded from HA backups (backup_exclude), so a
    restored add-on always starts from a consistent copy."""
    cfg = load_config()
    if not cfg.db_path.exists():
        return 0
    target = cfg.data_dir / SNAPSHOT_NAME
    snapshot_for_ha_backup(cfg.db_path, target)
    print(f"Snapshot für Home-Assistant-Backup erstellt: {target} ({target.stat().st_size} Bytes)")
    return 0


def post_backup() -> int:
    cfg = load_config()
    target = cfg.data_dir / SNAPSHOT_NAME
    if target.exists() and cfg.db_path.exists():
        target.unlink()
    return 0


def _healthy(path: Path) -> bool:
    try:
        con = sqlite3.connect(str(path), timeout=30)
        try:
            return con.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        finally:
            con.close()
    except sqlite3.DatabaseError:
        return False


def prepare_database(cfg: Config) -> dict:
    """Restore after HA backup restore, and recover from a corrupted database."""
    result: dict = {"action": None}
    db = cfg.db_path
    snap = cfg.data_dir / SNAPSHOT_NAME
    if not db.exists() and snap.exists():
        if _healthy(snap):
            shutil.copy2(snap, db)
            snap.unlink()
            log.warning("Datenbank aus Home-Assistant-Backup-Snapshot wiederhergestellt")
            result["action"] = "restored_from_ha_snapshot"
        return result
    if db.exists() and not _healthy(db):
        stamp = time.strftime("%Y%m%d-%H%M%S")
        corrupt = db.with_name(f"has.db.corrupt-{stamp}")
        os.replace(db, corrupt)
        for suffix in ("-wal", "-shm"):
            p = Path(str(db) + suffix)
            if p.exists():
                os.replace(p, Path(str(corrupt) + suffix))
        log.error("Datenbank beschädigt – verschoben nach %s", corrupt)
        result["action"] = "corrupt_moved"
        result["corrupt_file"] = str(corrupt)
        candidates = sorted(cfg.backup_dir.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
        for cand in candidates:
            try:
                with zipfile.ZipFile(cand) as zf:
                    if "has.db" not in zf.namelist():
                        continue
                    tmp = db.with_suffix(".recover")
                    with zf.open("has.db") as src, open(tmp, "wb") as dst:
                        shutil.copyfileobj(src, dst)
                if _healthy(tmp):
                    os.replace(tmp, db)
                    log.warning("Datenbank aus Sicherung %s wiederhergestellt", cand.name)
                    result["action"] = "restored_from_backup"
                    result["backup"] = cand.name
                    break
                tmp.unlink()
            except (zipfile.BadZipFile, OSError, KeyError):
                continue
    return result
