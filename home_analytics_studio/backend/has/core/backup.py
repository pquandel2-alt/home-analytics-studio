"""Backups (zip with manifest + checksums), verification and restore."""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import shutil
import sqlite3
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any, Callable

from sqlalchemy import text

from ..config import VERSION
from ..db import SCHEMA_VERSION, Database, run_migrations

log = logging.getLogger(__name__)

CONFIG_TABLES = ("dashboards", "pages", "metrics", "constants", "share_links")
NAME_RE = re.compile(r"^[A-Za-z0-9_.\-]+\.zip$")


class BackupError(Exception):
    pass


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def export_config(db: Database) -> dict:
    """All configuration (no measurements) as JSON-serialisable dict."""
    out: dict[str, Any] = {"format": "has-config", "version": 1, "app_version": VERSION, "created_at": time.time()}
    with db.read() as conn:
        for table in CONFIG_TABLES:
            if table == "share_links":
                continue
            out[table] = [dict(r) for r in conn.execute(text(f"SELECT * FROM {table}")).mappings()]
        out["settings"] = {r[0]: json.loads(r[1]) for r in conn.execute(text("SELECT key, value FROM settings"))}
        out["entities"] = [dict(r) for r in conn.execute(text(
            "SELECT entity_id, recorded, kind, retention_days, unit, notes FROM entities")).mappings()]
    return out


def import_config(db: Database, data: dict) -> dict:
    if data.get("format") != "has-config":
        raise BackupError("Keine gültige Konfigurationssicherung")
    counts = {}
    with db.write() as conn:
        for table in ("dashboards", "pages", "metrics", "constants"):
            rows = data.get(table) or []
            conn.execute(text(f"DELETE FROM {table}"))
            if rows:
                cols = list(rows[0].keys())
                conn.execute(text(f"INSERT INTO {table}({', '.join(cols)}) VALUES ({', '.join(':' + c for c in cols)})"), rows)
            counts[table] = len(rows)
        for key, value in (data.get("settings") or {}).items():
            conn.execute(text("INSERT OR REPLACE INTO settings(key, value) VALUES (:k, :v)"),
                         {"k": key, "v": json.dumps(value)})
        n = 0
        for ent in data.get("entities") or []:
            conn.execute(text("INSERT OR IGNORE INTO entities(entity_id, recorded, kind, created_at, sample_count)"
                              " VALUES (:e, 0, 'auto', :t, 0)"), {"e": ent["entity_id"], "t": time.time()})
            conn.execute(text("UPDATE entities SET recorded=:r, kind=:k, retention_days=:rd, unit=COALESCE(:u, unit), notes=:n"
                              " WHERE entity_id=:e"),
                         {"r": ent.get("recorded", 0), "k": ent.get("kind") or "auto", "rd": ent.get("retention_days"),
                          "u": ent.get("unit"), "n": ent.get("notes"), "e": ent["entity_id"]})
            n += 1
        counts["entities"] = n
    return counts


class BackupManager:
    def __init__(self, db: Database, backup_dir: Path, settings=None):
        self.db = db
        self.dir = Path(backup_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.settings = settings
        self.before_restore: list[Callable[[], None]] = []
        self.after_restore: list[Callable[[], None]] = []

    def path_for(self, name: str) -> Path:
        if not NAME_RE.match(name or ""):
            raise BackupError("Ungültiger Dateiname")
        p = self.dir / name
        if not p.exists():
            raise FileNotFoundError(name)
        return p

    def list(self) -> list[dict]:
        out = []
        for p in sorted(self.dir.glob("*.zip"), key=lambda x: x.stat().st_mtime, reverse=True):
            info = {"name": p.name, "size": p.stat().st_size, "created_at": p.stat().st_mtime}
            try:
                with zipfile.ZipFile(p) as zf:
                    manifest = json.loads(zf.read("manifest.json"))
                info.update({k: manifest.get(k) for k in ("kind", "include_data", "app_version", "schema_version", "label")})
                info["created_at"] = manifest.get("created_at", info["created_at"])
            except Exception:  # noqa: BLE001
                info["invalid"] = True
            out.append(info)
        return out

    def create(self, include_data: bool = True, kind: str = "manual", label: str | None = None) -> dict:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        name = f"has-{kind}-{stamp}{'' if include_data else '-config'}.zip"
        target = self.dir / name
        files: dict[str, str] = {}
        with tempfile.TemporaryDirectory(dir=self.dir) as tmp:
            tmpdir = Path(tmp)
            cfg_path = tmpdir / "config.json"
            cfg_path.write_text(json.dumps(export_config(self.db), ensure_ascii=False, default=str), "utf-8")
            files["config.json"] = _sha256_file(cfg_path)
            if include_data:
                db_copy = tmpdir / "has.db"
                self.db.snapshot_to(db_copy)
                files["has.db"] = _sha256_file(db_copy)
            manifest = {
                "format": "home-analytics-studio-backup", "app_version": VERSION, "schema_version": SCHEMA_VERSION,
                "created_at": time.time(), "kind": kind, "label": label, "include_data": include_data, "files": files,
            }
            part = target.with_suffix(".zip.part")
            with zipfile.ZipFile(part, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
                zf.writestr("manifest.json", json.dumps(manifest, indent=2))
                for fname in files:
                    zf.write(tmpdir / fname, fname)
            part.replace(target)
        log.info("Backup created: %s", target)
        return {"name": name, "size": target.stat().st_size, **manifest}

    def verify(self, path: Path) -> dict:
        """Check zip CRCs, manifest checksums, SQLite integrity and schema compatibility."""
        result: dict[str, Any] = {"ok": False, "errors": [], "manifest": None}
        try:
            with zipfile.ZipFile(path) as zf:
                bad = zf.testzip()
                if bad:
                    result["errors"].append(f"Beschädigte Datei im Archiv: {bad}")
                    return result
                manifest = json.loads(zf.read("manifest.json"))
                result["manifest"] = manifest
                if manifest.get("format") != "home-analytics-studio-backup":
                    result["errors"].append("Unbekanntes Sicherungsformat")
                    return result
                with tempfile.TemporaryDirectory(dir=self.dir) as tmp:
                    for fname, digest in (manifest.get("files") or {}).items():
                        if fname not in ("config.json", "has.db"):
                            result["errors"].append(f"Unerwartete Datei {fname}")
                            continue
                        out = Path(tmp) / fname
                        with zf.open(fname) as src, open(out, "wb") as dst:
                            shutil.copyfileobj(src, dst)
                        if _sha256_file(out) != digest:
                            result["errors"].append(f"Prüfsumme stimmt nicht: {fname}")
                        if fname == "has.db":
                            con = sqlite3.connect(str(out))
                            try:
                                chk = con.execute("PRAGMA integrity_check").fetchall()
                                ver = con.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
                            finally:
                                con.close()
                            if [r[0] for r in chk] != ["ok"]:
                                result["errors"].append("SQLite-Integritätsprüfung fehlgeschlagen")
                            if ver and int(ver[0]) > SCHEMA_VERSION:
                                result["errors"].append("Sicherung stammt von einer neueren Version")
                        if fname == "config.json":
                            json.loads(out.read_text("utf-8"))
        except (zipfile.BadZipFile, KeyError, ValueError, sqlite3.DatabaseError, OSError) as err:
            result["errors"].append(f"{type(err).__name__}: {err}")
            return result
        result["ok"] = not result["errors"]
        return result

    def save_upload(self, filename: str, data: bytes) -> str:
        base = re.sub(r"[^A-Za-z0-9_.\-]", "_", Path(filename or "upload.zip").name)
        if not base.endswith(".zip"):
            base += ".zip"
        name = f"uploaded-{time.strftime('%Y%m%d-%H%M%S')}-{base}"
        if len(name) > 120:
            name = name[:116] + ".zip"
        (self.dir / name).write_bytes(data)
        return name

    def delete(self, name: str) -> None:
        self.path_for(name).unlink()

    def restore(self, name: str, mode: str = "full") -> dict:
        path = self.path_for(name)
        check = self.verify(path)
        if not check["ok"]:
            raise BackupError("Sicherung ungültig: " + "; ".join(check["errors"]))
        manifest = check["manifest"]
        with zipfile.ZipFile(path) as zf:
            if mode == "config" or not manifest.get("include_data"):
                data = json.loads(zf.read("config.json"))
                counts = import_config(self.db, data)
                for cb in self.after_restore:
                    cb()
                return {"mode": "config", "restored": counts}
            # full restore: keep a safety copy of the current database
            safety = self.create(include_data=True, kind="pre-restore")
            for cb in self.before_restore:
                cb()
            tmp_db = self.db.path.with_suffix(".restore")
            with zf.open("has.db") as src, open(tmp_db, "wb") as dst:
                shutil.copyfileobj(src, dst)
        with self.db.write_lock:
            self.db.dispose()
            for suffix in ("-wal", "-shm"):
                p = Path(str(self.db.path) + suffix)
                if p.exists():
                    p.unlink()
            os.replace(tmp_db, self.db.path)
            self.db.reopen()
            run_migrations(self.db.engine)
        for cb in self.after_restore:
            cb()
        log.info("Database restored from %s", name)
        return {"mode": "full", "safety_backup": safety["name"]}

    def auto_backup(self) -> dict | None:
        conf = (self.settings.get("backup") if self.settings else None) or {}
        if not conf.get("auto_enabled", True):
            return None
        keep = int(conf.get("auto_keep", 3) or 3)
        res = self.create(include_data=bool(conf.get("auto_include_data", True)), kind="auto")
        autos = sorted(self.dir.glob("has-auto-*.zip"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in autos[keep:]:
            old.unlink()
        return res


def snapshot_for_ha_backup(db_path: Path, target: Path) -> None:
    """Called by the Supervisor backup_pre hook (separate process)."""
    src = sqlite3.connect(str(db_path), timeout=60)
    try:
        tmp = target.with_suffix(".tmp")
        dst = sqlite3.connect(str(tmp))
        try:
            src.backup(dst)
        finally:
            dst.close()
        os.replace(tmp, target)
    finally:
        src.close()


def bytes_of(obj: Any) -> bytes:
    buf = io.BytesIO()
    buf.write(json.dumps(obj, ensure_ascii=False, indent=2, default=str).encode())
    return buf.getvalue()
