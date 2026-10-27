"""Users, sessions, share links (read-only presentation access)."""
from __future__ import annotations

import hashlib
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass

import bcrypt
from sqlalchemy import text

from ..db import Database

ROLES = ("viewer", "editor", "admin")
ROLE_LEVEL = {r: i for i, r in enumerate(ROLES)}


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode()[:72], bcrypt.gensalt(rounds=12)).decode()


def check_password(password: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(password.encode()[:72], hashed.encode())
    except ValueError:
        return False


def validate_password(password: str) -> None:
    if len(password or "") < 8:
        raise ValueError("Das Passwort muss mindestens 8 Zeichen lang sein")


@dataclass
class Principal:
    user_id: int | None
    username: str
    role: str
    kind: str  # login | ingress | share
    share_dashboard_id: int | None = None
    csrf: str | None = None
    session_hash: str | None = None
    display_id: int | None = None
    display_paired: bool = False

    def has(self, role: str) -> bool:
        return ROLE_LEVEL.get(self.role, -1) >= ROLE_LEVEL[role]

    def as_dict(self) -> dict:
        return {"id": self.user_id, "username": self.username, "role": self.role, "kind": self.kind,
                "share_dashboard_id": self.share_dashboard_id, "display_id": self.display_id}


class RateLimiter:
    def __init__(self, limit: int = 10, window: float = 300):
        self.limit = limit
        self.window = window
        self.hits: dict[str, deque] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.time()
        q = self.hits[key]
        while q and now - q[0] > self.window:
            q.popleft()
        if len(q) >= self.limit:
            return False
        q.append(now)
        return True

    def reset(self, key: str) -> None:
        self.hits.pop(key, None)


class AuthService:
    def __init__(self, db: Database, settings):
        self.db = db
        self.settings = settings
        self.limiter = RateLimiter()

    # ------------------------------------------------------------------ users

    def has_local_admin(self) -> bool:
        with self.db.read() as conn:
            return bool(conn.execute(text(
                "SELECT 1 FROM users WHERE role='admin' AND source='local' AND password_hash IS NOT NULL LIMIT 1")).first())

    def list_users(self) -> list[dict]:
        with self.db.read() as conn:
            rows = conn.execute(text("SELECT id, username, display_name, role, source, created_at, last_login FROM users"
                                     " ORDER BY username")).mappings().all()
        return [dict(r) for r in rows]

    def create_user(self, username: str, password: str | None, role: str, display_name: str | None = None,
                    source: str = "local") -> dict:
        username = (username or "").strip()
        if not username or len(username) > 64:
            raise ValueError("Ungültiger Benutzername")
        if role not in ROLES:
            raise ValueError("Ungültige Rolle")
        pw_hash = None
        if source == "local":
            validate_password(password or "")
            pw_hash = hash_password(password or "")
        with self.db.write() as conn:
            if conn.execute(text("SELECT 1 FROM users WHERE lower(username)=lower(:u)"), {"u": username}).first():
                raise ValueError("Benutzername existiert bereits")
            res = conn.execute(text("INSERT INTO users(username, display_name, password_hash, role, source, created_at)"
                                    " VALUES (:u, :d, :p, :r, :s, :t)"),
                               {"u": username, "d": display_name, "p": pw_hash, "r": role, "s": source, "t": time.time()})
            uid = res.lastrowid
        return {"id": uid, "username": username, "role": role, "source": source}

    def update_user(self, user_id: int, role: str | None = None, password: str | None = None,
                    display_name: str | None = None) -> None:
        with self.db.write() as conn:
            row = conn.execute(text("SELECT * FROM users WHERE id=:i"), {"i": user_id}).mappings().first()
            if not row:
                raise KeyError("Benutzer nicht gefunden")
            if role is not None:
                if role not in ROLES:
                    raise ValueError("Ungültige Rolle")
                if row["role"] == "admin" and role != "admin" and self._admin_count(conn) <= 1:
                    raise ValueError("Der letzte Administrator kann nicht herabgestuft werden")
                conn.execute(text("UPDATE users SET role=:r WHERE id=:i"), {"r": role, "i": user_id})
            if password:
                validate_password(password)
                conn.execute(text("UPDATE users SET password_hash=:p WHERE id=:i"),
                             {"p": hash_password(password), "i": user_id})
                conn.execute(text("DELETE FROM sessions WHERE user_id=:i"), {"i": user_id})
            if display_name is not None:
                conn.execute(text("UPDATE users SET display_name=:d WHERE id=:i"), {"d": display_name, "i": user_id})

    def _admin_count(self, conn) -> int:
        return conn.execute(text("SELECT COUNT(*) FROM users WHERE role='admin'")).scalar() or 0

    def delete_user(self, user_id: int) -> None:
        with self.db.write() as conn:
            row = conn.execute(text("SELECT role FROM users WHERE id=:i"), {"i": user_id}).first()
            if not row:
                raise KeyError("Benutzer nicht gefunden")
            if row[0] == "admin" and self._admin_count(conn) <= 1:
                raise ValueError("Der letzte Administrator kann nicht gelöscht werden")
            conn.execute(text("DELETE FROM sessions WHERE user_id=:i"), {"i": user_id})
            conn.execute(text("DELETE FROM users WHERE id=:i"), {"i": user_id})

    def authenticate(self, username: str, password: str) -> dict | None:
        with self.db.read() as conn:
            row = conn.execute(text("SELECT * FROM users WHERE lower(username)=lower(:u) AND source='local'"),
                               {"u": (username or "").strip()}).mappings().first()
        if row and check_password(password or "", row["password_hash"]):
            return dict(row)
        # constant-ish time: hash anyway
        if not row:
            check_password(password or "", "$2b$12$C6UzMDM.H6dfI/f/IKcEeO5w6tq5a1WjQqzZ5sJzZ0bPjSx1Ff7l6")
        return None

    def ensure_ingress_user(self, ha_user_id: str | None, username: str | None, display: str | None) -> Principal:
        name = (username or ha_user_id or "homeassistant").strip()[:64]
        role = self.settings.get("security", "ingress_role", "admin")
        uname = f"ha:{name}"
        with self.db.write() as conn:
            row = conn.execute(text("SELECT id, role FROM users WHERE username=:u"), {"u": uname}).first()
            if not row:
                res = conn.execute(text("INSERT INTO users(username, display_name, role, source, created_at, last_login)"
                                        " VALUES (:u, :d, :r, 'homeassistant', :t, :t)"),
                                   {"u": uname, "d": display or name, "r": role, "t": time.time()})
                uid = res.lastrowid
            else:
                uid = row[0]
                role = row[1]
        return Principal(uid, uname, role, "ingress")

    # ------------------------------------------------------------------ sessions

    def create_session(self, user_id: int, user_agent: str | None = None) -> tuple[str, str]:
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(24)
        hours = int(self.settings.get("security", "session_hours", 720) or 720)
        now = time.time()
        with self.db.write() as conn:
            conn.execute(text("INSERT INTO sessions(token_hash, user_id, kind, csrf, created_at, expires_at, last_seen, user_agent)"
                              " VALUES (:h, :u, 'login', :c, :n, :e, :n, :ua)"),
                         {"h": hash_token(token), "u": user_id, "c": csrf, "n": now, "e": now + hours * 3600,
                          "ua": (user_agent or "")[:200]})
            conn.execute(text("UPDATE users SET last_login=:n WHERE id=:u"), {"n": now, "u": user_id})
        return token, csrf

    def session_principal(self, token: str) -> Principal | None:
        if not token:
            return None
        h = hash_token(token)
        now = time.time()
        with self.db.read() as conn:
            row = conn.execute(text(
                "SELECT s.token_hash, s.kind, s.csrf, s.expires_at, s.last_seen, s.share_id, u.id AS uid, u.username, u.role"
                " FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.token_hash=:h"), {"h": h}).mappings().first()
        if not row or row["expires_at"] < now or row["uid"] is None:
            return None
        if now - (row["last_seen"] or 0) > 300:
            with self.db.write() as conn:
                conn.execute(text("UPDATE sessions SET last_seen=:n WHERE token_hash=:h"), {"n": now, "h": h})
        return Principal(row["uid"], row["username"], row["role"], "login", csrf=row["csrf"], session_hash=h)

    def delete_session(self, session_hash: str) -> None:
        with self.db.write() as conn:
            conn.execute(text("DELETE FROM sessions WHERE token_hash=:h"), {"h": session_hash})

    def purge_sessions(self) -> int:
        with self.db.write() as conn:
            res = conn.execute(text("DELETE FROM sessions WHERE expires_at<:n"), {"n": time.time()})
            return res.rowcount or 0

    # ------------------------------------------------------------------ share links

    def create_share(self, name: str, dashboard_id: int, created_by: int | None, days: int | None) -> dict:
        token = "shr_" + secrets.token_urlsafe(24)
        now = time.time()
        with self.db.write() as conn:
            if not conn.execute(text("SELECT 1 FROM dashboards WHERE id=:d"), {"d": dashboard_id}).first():
                raise KeyError("Dashboard nicht gefunden")
            res = conn.execute(text("INSERT INTO share_links(name, token_hash, token_hint, dashboard_id, created_by, created_at, expires_at)"
                                    " VALUES (:n, :h, :hint, :d, :u, :t, :e)"),
                               {"n": name or "Präsentation", "h": hash_token(token), "hint": token[-4:], "d": dashboard_id,
                                "u": created_by, "t": now, "e": now + days * 86400 if days else None})
        return {"id": res.lastrowid, "token": token, "dashboard_id": dashboard_id}

    def list_shares(self) -> list[dict]:
        with self.db.read() as conn:
            rows = conn.execute(text("SELECT id, name, token_hint, dashboard_id, created_at, expires_at, last_used"
                                     " FROM share_links ORDER BY id DESC")).mappings().all()
        return [dict(r) for r in rows]

    def delete_share(self, share_id: int) -> None:
        with self.db.write() as conn:
            conn.execute(text("DELETE FROM share_links WHERE id=:i"), {"i": share_id})

    def share_principal(self, token: str) -> Principal | None:
        if not token or not token.startswith("shr_"):
            return None
        with self.db.read() as conn:
            row = conn.execute(text("SELECT * FROM share_links WHERE token_hash=:h"), {"h": hash_token(token)}).mappings().first()
        if not row or (row["expires_at"] and row["expires_at"] < time.time()):
            return None
        if time.time() - (row["last_used"] or 0) > 300:
            with self.db.write() as conn:
                conn.execute(text("UPDATE share_links SET last_used=:n WHERE id=:i"), {"n": time.time(), "i": row["id"]})
        return Principal(None, f"share:{row['name']}", "viewer", "share", share_dashboard_id=row["dashboard_id"])
