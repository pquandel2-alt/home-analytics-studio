"""Personal API tokens: Bearer authentication next to sessions/ingress."""
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from has.app import create_app
from has.db import Database, run_migrations

XRW = {"X-Requested-With": "has"}


@pytest.fixture
def app(config):
    config.ingress_port = 80
    config.ingress_trusted_ips = ["testclient"]
    return create_app(config, start_background=False)


@pytest.fixture
def ingress(app):
    with TestClient(app) as c:
        c.headers.update({**XRW, "X-Remote-User-Name": "philipp"})
        yield c


def direct(app):
    return TestClient(app, base_url="http://testserver:8100")  # no cookies, no ingress


def make_user(ingress, name, role):
    return ingress.post("/api/auth/users", json={"username": name, "password": "password123", "role": role}).json()["id"]


def make_token(ingress, name, role, **kw):
    uid = make_user(ingress, name, role)
    r = ingress.post("/api/auth/tokens", json={"name": f"tok-{name}", "user_id": uid, **kw})
    assert r.status_code == 200, r.text
    return uid, r.json()


def bearer(tok):
    return {"Authorization": f"Bearer {tok}"}


def test_token_only_stored_hashed_and_shown_once(app, ingress):
    _, t = make_token(ingress, "ed", "editor")
    assert t["token"].startswith("has_") and len(t["token"]) > 40
    listing = ingress.get("/api/auth/tokens").json()
    assert listing[0]["status"] == "active" and "token" not in listing[0] and "token_hash" not in listing[0]
    assert t["token"] not in str(listing)
    with app.state.services.db.read() as conn:
        rows = [tuple(r) for r in conn.execute(text("SELECT * FROM api_tokens"))]
    assert rows and not any(t["token"] in str(v) for r in rows for v in r)


def test_bearer_roles_and_no_implicit_admin(app, ingress):
    _, ed = make_token(ingress, "ed", "editor")
    _, vi = make_token(ingress, "vi", "viewer")
    _, ad = make_token(ingress, "ad", "admin")
    with direct(app) as d:
        # editor: reads and writes dashboards without cookie / CSRF header, but is not admin
        assert d.get("/api/dashboards", headers=bearer(ed["token"])).status_code == 200
        r = d.post("/api/dashboards", json={"name": "ChatGPT"}, headers=bearer(ed["token"]))
        assert r.status_code == 200
        assert d.get("/api/settings", headers=bearer(ed["token"])).status_code == 403
        assert d.get("/api/auth/users", headers=bearer(ed["token"])).status_code == 403
        # viewer: read only
        assert d.get("/api/dashboards", headers=bearer(vi["token"])).status_code == 200
        assert d.post("/api/dashboards", json={"name": "x"}, headers=bearer(vi["token"])).status_code == 403
        # admin token may use admin endpoints ...
        assert d.get("/api/auth/users", headers=bearer(ad["token"])).status_code == 200
        # ... but cannot mint/list/revoke tokens (no self-perpetuating access)
        assert d.get("/api/auth/tokens", headers=bearer(ad["token"])).status_code == 403
        assert d.post("/api/auth/tokens", json={"name": "x", "user_id": 1}, headers=bearer(ad["token"])).status_code == 403


def test_invalid_tokens_are_401_without_fallback_to_ingress(app, ingress):
    # ingress would be admin, but an explicit (bad) bearer must not inherit that
    for h in ({"Authorization": "Bearer has_nope"}, {"Authorization": "Bearer "}, {"Authorization": "Bearer garbage"}):
        r = ingress.get("/api/dashboards", headers=h)
        assert r.status_code == 401, h
        assert "has_nope" not in r.text
    assert ingress.get("/api/dashboards").status_code == 200
    with direct(app) as d:
        r = d.get("/api/dashboards", headers={"Authorization": "Basic abc"})
        assert r.status_code == 401
        assert r.headers["www-authenticate"] == "Bearer"


def test_valid_token_on_ingress_gets_token_rights_not_admin(app, ingress):
    _, vi = make_token(ingress, "vi", "viewer")
    r = ingress.post("/api/dashboards", json={"name": "x"}, headers=bearer(vi["token"]))
    assert r.status_code == 403
    assert ingress.get("/api/settings", headers=bearer(vi["token"])).status_code == 403
    assert ingress.get("/api/auth/me", headers=bearer(vi["token"])).json()["kind"] == "api"


def test_revoked_token_stops_working_immediately(app, ingress):
    _, t = make_token(ingress, "ed", "editor")
    with direct(app) as d:
        assert d.get("/api/dashboards", headers=bearer(t["token"])).status_code == 200
        assert ingress.delete(f"/api/auth/tokens/{t['id']}").status_code == 200
        assert d.get("/api/dashboards", headers=bearer(t["token"])).status_code == 401
        assert d.post("/api/dashboards", json={"name": "x"}, headers=bearer(t["token"])).status_code == 401
    assert ingress.get("/api/auth/tokens").json()[0]["status"] == "revoked"
    assert ingress.delete("/api/auth/tokens/9999").status_code == 404


def test_expired_token_and_validity_checks(app, ingress):
    uid, t = make_token(ingress, "ed", "editor", days=1)
    assert t["expires_at"] > time.time()
    svc = app.state.services
    with svc.db.write() as conn:
        conn.execute(text("UPDATE api_tokens SET expires_at=:e WHERE id=:i"), {"e": time.time() - 5, "i": t["id"]})
    with direct(app) as d:
        assert d.get("/api/dashboards", headers=bearer(t["token"])).status_code == 401
    assert ingress.get("/api/auth/tokens").json()[0]["status"] == "expired"
    for bad in (0, -1, 99999):
        assert ingress.post("/api/auth/tokens", json={"name": "x", "user_id": uid, "days": bad}).status_code == 400
    assert ingress.post("/api/auth/tokens", json={"name": " ", "user_id": uid}).status_code == 400
    assert ingress.post("/api/auth/tokens", json={"name": "x", "user_id": 9999}).status_code == 404


def test_token_role_capped_by_user_and_follows_demotion(app, ingress):
    uid = make_user(ingress, "ed", "editor")
    # cannot exceed the user's role
    assert ingress.post("/api/auth/tokens", json={"name": "x", "user_id": uid, "role": "admin"}).status_code == 400
    # may be lower
    low = ingress.post("/api/auth/tokens", json={"name": "ro", "user_id": uid, "role": "viewer"}).json()
    full = ingress.post("/api/auth/tokens", json={"name": "rw", "user_id": uid}).json()
    with direct(app) as d:
        assert d.post("/api/dashboards", json={"name": "x"}, headers=bearer(low["token"])).status_code == 403
        assert d.post("/api/dashboards", json={"name": "x"}, headers=bearer(full["token"])).status_code == 200
        ingress.patch(f"/api/auth/users/{uid}", json={"role": "viewer"})
        assert d.post("/api/dashboards", json={"name": "y"}, headers=bearer(full["token"])).status_code == 403


def test_deleting_user_removes_tokens(app, ingress):
    uid, t = make_token(ingress, "ed", "editor")
    ingress.delete(f"/api/auth/users/{uid}")
    with direct(app) as d:
        assert d.get("/api/dashboards", headers=bearer(t["token"])).status_code == 401
    assert ingress.get("/api/auth/tokens").json() == []


def test_last_used_is_recorded(app, ingress):
    _, t = make_token(ingress, "ed", "editor")
    assert ingress.get("/api/auth/tokens").json()[0]["last_used"] is None
    with direct(app) as d:
        d.get("/api/dashboards", headers=bearer(t["token"]))
    assert ingress.get("/api/auth/tokens").json()[0]["last_used"] is not None


def test_cookie_sessions_keep_csrf_protection(app, ingress):
    make_user(ingress, "anna", "editor")
    with direct(app) as d:
        csrf = d.post("/api/auth/login", json={"username": "anna", "password": "password123"}, headers=XRW).json()["csrf"]
        assert d.post("/api/dashboards", json={"name": "x"}, headers=XRW).status_code == 403
        assert d.post("/api/dashboards", json={"name": "x"}, headers={**XRW, "X-CSRF-Token": csrf}).status_code == 200


def test_token_not_in_audit_log_and_management_audited(app, ingress):
    _, t = make_token(ingress, "ed", "editor")
    ingress.delete(f"/api/auth/tokens/{t['id']}")
    audit = ingress.get("/api/system/audit").json()
    assert {a["action"] for a in audit} >= {"token.create", "token.revoke"}
    assert t["token"] not in str(audit)


def test_chatgpt_editor_workflow_uses_existing_endpoints(app, ingress):
    """The goal scenario: a dedicated editor token builds and evolves a dashboard via the normal REST API."""
    _, t = make_token(ingress, "chatgpt", "editor", days=30)
    h = bearer(t["token"])
    with direct(app) as d:
        dash = d.post("/api/dashboards", json={"name": "Von ChatGPT"}, headers=h).json()
        page = dash["pages"][0]
        assert d.post("/api/constants", json={"key": "preis", "value": 0.3, "unit": "€/kWh"}, headers=h).status_code == 200
        v = d.post("/api/metrics/validate", json={"formula": "preis * 2"}, headers=h).json()
        assert v["ok"]
        assert d.post("/api/metrics", json={"name": "Kosten", "key": "kosten", "formula": "preis * 2", "unit": "€"},
                      headers=h).status_code == 200
        assert any(m["key"] == "kosten" for m in d.get("/api/metrics", headers=h).json())
        widgets = [{"id": "w1", "type": "value", "title": "Kosten", "config": {"sources": [{"type": "metric", "id": "kosten"}]}}]
        r = d.put(f"/api/pages/{page['id']}", json={"widgets": widgets, "layouts": {"lg": [{"i": "w1", "x": 0, "y": 0, "w": 4, "h": 3}]},
                                                    "version": page["version"]}, headers=h)
        assert r.status_code == 200
        assert d.post(f"/api/dashboards/{dash['id']}/duplicate", headers=h).status_code == 200
        assert d.post("/api/data/scalar", json={"source": {"type": "metric", "id": "kosten"}, "range": "today"},
                      headers=h).json()["value"] == 0.6
        assert d.post("/api/data/series", json={"sources": [{"type": "metric", "id": "kosten"}], "range": "today"},
                      headers=h).status_code in (200, 422)
        assert d.get("/api/dashboards", headers=h).status_code == 200


def test_migration_8_is_additive_and_idempotent(tmp_path):
    path = tmp_path / "old.db"
    db = Database(path)
    db.init()
    with db.write() as conn:
        conn.execute(text("INSERT INTO users(username, role, source, created_at) VALUES ('keep','admin','local',1)"))
        conn.execute(text("DROP TABLE api_tokens"))
        conn.execute(text("UPDATE meta SET value='7' WHERE key='schema_version'"))
    assert run_migrations(db.engine) == 8
    assert run_migrations(db.engine) == 8
    db.dispose()
    con = sqlite3.connect(path)
    assert con.execute("SELECT username FROM users").fetchall() == [("keep",)]
    assert con.execute("SELECT COUNT(*) FROM api_tokens").fetchone() == (0,)
