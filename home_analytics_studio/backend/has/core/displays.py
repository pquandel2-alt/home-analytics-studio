"""Remote displays (TVs, wall tablets): pair once, then show dashboards sent from any device.

Flow
  1. The display opens ``/tv`` → registers anonymously and shows a 4 digit pairing code.
  2. A user enters the code (dashboard → "Auf Bildschirm anzeigen" or Settings → Bildschirme).
  3. The paired display keeps a secret token (localStorage) and a WebSocket connection; dashboards
     are pushed to it. Displays have read-only access, like presentation links.
"""
from __future__ import annotations

import json
import secrets
import time
from typing import Any

from sqlalchemy import text

from ..db import Database
from .auth import Principal, hash_token

UNPAIRED_TTL = 3600
MAX_UNPAIRED = 20


class DisplayService:
    def __init__(self, db: Database):
        self.db = db

    def _purge_unpaired(self, conn) -> None:
        conn.execute(text("DELETE FROM displays WHERE paired=0 AND created_at<:t"), {"t": time.time() - UNPAIRED_TTL})

    def register(self, user_agent: str | None, screen: str | None) -> dict:
        token = "dsp_" + secrets.token_urlsafe(24)
        with self.db.write() as conn:
            self._purge_unpaired(conn)
            if conn.execute(text("SELECT COUNT(*) FROM displays WHERE paired=0")).scalar() >= MAX_UNPAIRED:
                raise RuntimeError("Zu viele ungekoppelte Bildschirme – bitte später erneut versuchen")
            used = {r[0] for r in conn.execute(text("SELECT pair_code FROM displays WHERE paired=0"))}
            code = next(c for c in (f"{secrets.randbelow(10000):04d}" for _ in range(100)) if c not in used)
            res = conn.execute(text("INSERT INTO displays(name, token_hash, pair_code, paired, created_at, last_seen, user_agent, screen)"
                                    " VALUES (:n, :h, :c, 0, :t, :t, :ua, :s)"),
                               {"n": "Neuer Bildschirm", "h": hash_token(token), "c": code, "t": time.time(),
                                "ua": (user_agent or "")[:200], "s": (screen or "")[:40]})
        return {"id": res.lastrowid, "token": token, "code": code}

    def pair(self, code: str, name: str, default_dashboard_id: int | None = None) -> dict:
        code = (code or "").strip()
        with self.db.write() as conn:
            self._purge_unpaired(conn)
            row = conn.execute(text("SELECT id FROM displays WHERE paired=0 AND pair_code=:c"), {"c": code}).first()
            if not row:
                raise KeyError("Kein Bildschirm mit diesem Code gefunden (Code abgelaufen? Seite am Fernseher neu laden)")
            current = json.dumps({"dashboard_id": default_dashboard_id, "page_id": None, "present": True, "ts": time.time()}) \
                if default_dashboard_id else None
            conn.execute(text("UPDATE displays SET paired=1, pair_code=NULL, name=:n, current=:cur WHERE id=:i"),
                         {"n": (name or "Bildschirm").strip()[:60], "cur": current, "i": row[0]})
        return self.get(row[0])

    def principal(self, token: str) -> Principal | None:
        if not token or not token.startswith("dsp_"):
            return None
        with self.db.read() as conn:
            row = conn.execute(text("SELECT id, name, paired, last_seen FROM displays WHERE token_hash=:h"),
                               {"h": hash_token(token)}).first()
        if not row:
            return None
        if time.time() - (row[3] or 0) > 120:
            with self.db.write() as conn:
                conn.execute(text("UPDATE displays SET last_seen=:t WHERE id=:i"), {"t": time.time(), "i": row[0]})
        return Principal(None, f"display:{row[1]}", "viewer" if row[2] else "none", "display",
                         display_id=row[0], display_paired=bool(row[2]))

    def pair_code(self, display_id: int) -> str | None:
        with self.db.read() as conn:
            return conn.execute(text("SELECT pair_code FROM displays WHERE id=:i"), {"i": display_id}).scalar()

    def get(self, display_id: int) -> dict | None:
        with self.db.read() as conn:
            row = conn.execute(text("SELECT * FROM displays WHERE id=:i"), {"i": display_id}).mappings().first()
        return _row(row) if row else None

    def list(self) -> list[dict]:
        with self.db.read() as conn:
            rows = conn.execute(text("SELECT * FROM displays WHERE paired=1 ORDER BY name")).mappings().all()
        return [_row(r) for r in rows]

    def show(self, display_id: int, dashboard_id: int | None, page_id: int | None, present: bool) -> dict:
        with self.db.write() as conn:
            if dashboard_id is not None and not conn.execute(text("SELECT 1 FROM dashboards WHERE id=:d"), {"d": dashboard_id}).first():
                raise KeyError("Dashboard nicht gefunden")
            cur = {"dashboard_id": dashboard_id, "page_id": page_id, "present": bool(present), "ts": time.time()}
            res = conn.execute(text("UPDATE displays SET current=:c WHERE id=:i AND paired=1"), {"c": json.dumps(cur), "i": display_id})
            if not res.rowcount:
                raise KeyError("Bildschirm nicht gefunden")
        return cur

    def add_tv(self, name: str, tv_entity: str) -> dict:
        """Create an already paired display linked to a TV (media_player). The TV opens a URL that
        carries its own read-only display token – no input on the TV is ever needed."""
        token = "dsp_" + secrets.token_urlsafe(24)
        with self.db.write() as conn:
            if conn.execute(text("SELECT 1 FROM displays WHERE tv_entity=:e"), {"e": tv_entity}).first():
                raise ValueError("Dieser Fernseher ist bereits verknüpft")
            res = conn.execute(text("INSERT INTO displays(name, token_hash, paired, created_at, tv_entity, launch_token)"
                                    " VALUES (:n, :h, 1, :t, :e, :tok)"),
                               {"n": (name or "Fernseher").strip()[:60], "h": hash_token(token), "t": time.time(),
                                "e": tv_entity, "tok": token})
        return self.get(res.lastrowid)

    def link_tv(self, display_id: int, tv_entity: str | None) -> None:
        """Link/unlink an existing display with a TV; a launch token is created on demand."""
        with self.db.write() as conn:
            if tv_entity:
                token = "dsp_" + secrets.token_urlsafe(24)
                conn.execute(text("UPDATE displays SET tv_entity=:e, launch_token=:tok, token_hash=:h WHERE id=:i"),
                             {"e": tv_entity, "tok": token, "h": hash_token(token), "i": display_id})
            else:
                conn.execute(text("UPDATE displays SET tv_entity=NULL, launch_token=NULL WHERE id=:i"), {"i": display_id})

    def launch_info(self, display_id: int) -> tuple[str | None, str | None]:
        with self.db.read() as conn:
            row = conn.execute(text("SELECT tv_entity, launch_token FROM displays WHERE id=:i"), {"i": display_id}).first()
        return (row[0], row[1]) if row else (None, None)

    def set_launch_result(self, display_id: int, error: str | None) -> None:
        with self.db.write() as conn:
            conn.execute(text("UPDATE displays SET last_launch=:t, last_launch_error=:e WHERE id=:i"),
                         {"t": time.time(), "e": error, "i": display_id})

    def update(self, display_id: int, name: str | None) -> None:
        with self.db.write() as conn:
            conn.execute(text("UPDATE displays SET name=COALESCE(:n, name) WHERE id=:i"), {"n": name, "i": display_id})

    def delete(self, display_id: int) -> None:
        with self.db.write() as conn:
            conn.execute(text("DELETE FROM displays WHERE id=:i"), {"i": display_id})


def _row(row) -> dict[str, Any]:
    d = dict(row)
    d.pop("token_hash", None)
    d.pop("launch_token", None)
    d["current"] = json.loads(d["current"]) if d.get("current") else None
    d["paired"] = bool(d.get("paired"))
    return d
