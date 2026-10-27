"""HTTP API: authentication, CSRF, roles, share links, dashboards, metrics, data, settings."""
import time

import pytest
from fastapi.testclient import TestClient

from has.app import create_app

XRW = {"X-Requested-With": "has"}


@pytest.fixture
def app(config):
    config.ingress_port = 80  # TestClient default server port -> "ingress" listener
    config.ingress_trusted_ips = ["testclient"]
    return create_app(config, start_background=False)


@pytest.fixture
def ingress(app):
    with TestClient(app) as c:
        c.headers.update({**XRW, "X-Remote-User-Name": "philipp"})
        yield c


def direct_client(app):
    return TestClient(app, base_url="http://testserver:8100")


def test_health_and_status(ingress):
    assert ingress.get("/api/health").json()["status"] == "ok"
    st = ingress.get("/api/auth/status").json()
    assert st["authenticated"] and st["ingress"] and st["user"]["role"] == "admin"


def test_direct_access_requires_login_and_setup_code(app, ingress):
    with direct_client(app) as d:
        svc = app.state.services  # each TestClient context runs the lifespan (new Services)
        assert d.get("/api/dashboards").status_code == 401
        st = d.get("/api/auth/status").json()
        assert st["setup_required"] and not st["authenticated"]
        svc.setup_token = "ABCD1234"
        r = d.post("/api/auth/setup", json={"username": "admin", "password": "supersecret", "setup_code": "WRONG"}, headers=XRW)
        assert r.status_code == 403
        r = d.post("/api/auth/setup", json={"username": "admin", "password": "supersecret", "setup_code": "abcd1234"}, headers=XRW)
        assert r.status_code == 200
        csrf = r.json()["csrf"]
        # session cookie works, CSRF required for writes
        assert d.get("/api/dashboards").status_code == 200
        assert d.post("/api/dashboards", json={"name": "x"}, headers=XRW).status_code == 403
        assert d.post("/api/dashboards", json={"name": "x"}, headers={**XRW, "X-CSRF-Token": csrf}).status_code == 200
        # custom header required (blocks cross-site form posts)
        assert d.post("/api/dashboards", json={"name": "x"}, headers={"X-CSRF-Token": csrf}).status_code == 403
        assert d.post("/api/auth/setup", json={"username": "b", "password": "supersecret"}, headers=XRW).status_code == 409


def test_login_logout_and_rate_limit(app, ingress):
    ingress.post("/api/auth/users", json={"username": "anna", "password": "password123", "role": "viewer"})
    with direct_client(app) as d:
        assert d.post("/api/auth/login", json={"username": "anna", "password": "wrong"}, headers=XRW).status_code == 401
        r = d.post("/api/auth/login", json={"username": "anna", "password": "password123"}, headers=XRW)
        assert r.status_code == 200
        csrf = r.json()["csrf"]
        # viewer cannot write
        assert d.post("/api/dashboards", json={"name": "x"}, headers={**XRW, "X-CSRF-Token": csrf}).status_code == 403
        assert d.get("/api/settings").status_code == 403
        assert d.post("/api/auth/logout", headers={**XRW, "X-CSRF-Token": csrf}).status_code == 200
        assert d.get("/api/dashboards").status_code == 401
        for _ in range(12):
            r = d.post("/api/auth/login", json={"username": "anna", "password": "bad"}, headers=XRW)
        assert r.status_code == 429


def test_untrusted_ip_on_ingress_port_is_not_trusted(app):
    app.state  # noqa: B018
    with TestClient(app) as c:
        c.app.state.services.config.ingress_trusted_ips = ["172.30.32.2"]
        assert c.get("/api/dashboards").status_code == 401


def test_dashboard_crud_pages_versioning_export_import(ingress):
    d = ingress.post("/api/dashboards", json={"name": "Energie"}).json()
    assert d["pages"] and d["settings"]["grid"]["cols"]["lg"] == 24
    page = d["pages"][0]
    widgets = [{"id": "w1", "type": "value", "title": "Strom", "config": {"sources": [{"type": "metric", "id": "kosten"}]}}]
    layouts = {"lg": [{"i": "w1", "x": 0, "y": 0, "w": 4, "h": 3}]}
    r = ingress.put(f"/api/pages/{page['id']}", json={"widgets": widgets, "layouts": layouts, "version": page["version"]})
    assert r.status_code == 200 and r.json()["version"] == page["version"] + 1
    # stale version -> conflict
    assert ingress.put(f"/api/pages/{page['id']}", json={"widgets": [], "version": page["version"]}).status_code == 409
    p2 = ingress.post(f"/api/dashboards/{d['id']}/pages", json={"title": "Zwei"}).json()
    ingress.post(f"/api/dashboards/{d['id']}/pages/reorder", json={"order": [p2["id"], page["id"]]})
    got = ingress.get(f"/api/dashboards/{d['id']}").json()
    assert [p["title"] for p in got["pages"]] == ["Zwei", "Übersicht"]
    assert got["pages"][1]["widgets"][0]["title"] == "Strom"
    # rename / duplicate
    ingress.put(f"/api/dashboards/{d['id']}", json={"name": "Energie 2"})
    dup = ingress.post(f"/api/dashboards/{d['id']}/duplicate").json()
    assert dup["name"] == "Energie 2 (Kopie)" and len(dup["pages"]) == 2
    # export includes referenced metric definitions
    ingress.post("/api/constants", json={"key": "preis", "value": 0.3, "unit": "€/kWh"})
    ingress.post("/api/metrics", json={"name": "Kosten", "key": "kosten", "formula": "preis * 2", "unit": "€"})
    exp = ingress.get(f"/api/dashboards/{d['id']}/export").json()
    assert exp["format"] == "has-dashboard" and [m["key"] for m in exp["metrics"]] == ["kosten"]
    assert [c["key"] for c in exp["constants"]] == ["preis"]
    imp = ingress.post("/api/dashboards/import", json=exp).json()
    assert imp["dashboard"]["name"] == "Energie 2" and imp["created"]["skipped"] == ["preis", "kosten"]
    # last page cannot be deleted
    single = ingress.post("/api/dashboards", json={"name": "S"}).json()
    assert ingress.delete(f"/api/pages/{single['pages'][0]['id']}").status_code == 400
    assert ingress.delete(f"/api/dashboards/{single['id']}").status_code == 200
    assert ingress.get(f"/api/dashboards/{single['id']}").status_code == 404


def test_metrics_validation_cycles_and_usage(ingress):
    assert ingress.post("/api/metrics", json={"name": "A", "key": "a", "formula": "1 +"}).status_code == 422
    assert ingress.post("/api/metrics", json={"name": "A", "key": "A!", "formula": "1"}).status_code == 400
    assert ingress.post("/api/metrics", json={"name": "A", "key": "a", "formula": "2"}).status_code == 200
    b = ingress.post("/api/metrics", json={"name": "B", "key": "b", "formula": "a * 3"}).json()
    a_id = [m for m in ingress.get("/api/metrics").json() if m["key"] == "a"][0]["id"]
    # cycle a -> b -> a rejected
    r = ingress.put(f"/api/metrics/{a_id}", json={"name": "A", "key": "a", "formula": "b + 1"})
    assert r.status_code == 422 and "Zirkelbezug" in r.json()["detail"]["message"]
    # cannot delete a metric that is used
    assert ingress.delete(f"/api/metrics/{a_id}").status_code == 400
    v = ingress.post("/api/metrics/validate", json={"formula": "sensor.unknown * 2"}).json()
    assert not v["ok"] and "Unbekannte Entität" in v["error"]["message"]
    res = ingress.post("/api/data/scalar", json={"source": {"type": "metric", "id": "b"}, "range": "today"}).json()
    assert res["value"] == 6
    assert ingress.delete(f"/api/metrics/{b['id']}").status_code == 200
    funcs = ingress.get("/api/metrics/functions").json()
    assert any(f["name"] == "MOVING_AVG" for f in funcs)


def test_data_endpoints_with_recorded_values(app, ingress):
    svc = app.state.services
    attrs = {"unit_of_measurement": "kWh", "state_class": "total_increasing", "device_class": "energy"}
    svc.store.set_recording(["sensor.meter"], True, {"sensor.meter": attrs})
    info = svc.store.get("sensor.meter")
    now = time.time()
    t = int(now // 3600 * 3600) - 6 * 3600
    svc.store.insert_samples(info.id, [((t + i * 900) * 1000, 100 + i * 0.25) for i in range(24)])
    series = ingress.post("/api/data/series", json={"source": {"type": "entity", "id": "sensor.meter"}, "range": {"start": t, "end": t + 6 * 3600}, "interval": "1h"}).json()
    assert series["kind"] == "counter" and series["values"][1] == pytest.approx(1.0)
    batch = ingress.post("/api/data/batch", json={"requests": [
        {"kind": "scalar", "source": {"type": "entity", "id": "sensor.meter"}, "range": {"start": t, "end": t + 6 * 3600}},
        {"kind": "scalar", "source": {"type": "entity", "id": "sensor.nope"}, "range": "today"},
        {"kind": "series", "source": {"type": "formula", "formula": "sensor.meter * 0.5"}, "range": {"start": t, "end": t + 2 * 3600}, "interval": "1h"},
    ]}).json()["results"]
    assert batch[0]["ok"] and batch[0]["data"]["value"] == pytest.approx(5.75)
    assert not batch[1]["ok"]
    assert batch[2]["data"]["values"][1] == pytest.approx(0.5)
    csv = ingress.post("/api/export/series", json={"sources": [{"type": "entity", "id": "sensor.meter"}], "range": {"start": t, "end": t + 3 * 3600}, "interval": "1h", "format": "csv"})
    assert csv.status_code == 200 and "time;" in csv.text and ";1\r\n" in csv.text
    js = ingress.post("/api/export/series", json={"source": {"type": "entity", "id": "sensor.meter"}, "range": {"start": t, "end": t + 3 * 3600}, "interval": "1h", "format": "json"}).json()
    assert js[0]["points"][1]["value"] == pytest.approx(1.0)
    ent = ingress.get("/api/entities?recorded=true").json()["entities"]
    assert ent[0]["entity_id"] == "sensor.meter" and ent[0]["samples"] == 24
    an = ingress.post("/api/analysis/run", json={"source": {"type": "entity", "id": "sensor.meter"}, "days": 7}).json()
    assert "insights" in an and "comparisons" in an


def test_share_link_is_read_only_and_scoped(app, ingress):
    d1 = ingress.post("/api/dashboards", json={"name": "Wand"}).json()
    d2 = ingress.post("/api/dashboards", json={"name": "Privat"}).json()
    tok = ingress.post("/api/auth/shares", json={"name": "Flur", "dashboard_id": d1["id"]}).json()["token"]
    with direct_client(app) as s:
        h = {**XRW, "X-Share-Token": tok}
        assert s.get(f"/api/dashboards/{d1['id']}", headers=h).status_code == 200
        assert s.get(f"/api/dashboards/{d2['id']}", headers=h).status_code == 403
        assert s.get("/api/dashboards", headers=h).status_code == 200
        assert s.post("/api/data/scalar", json={"source": {"type": "formula", "formula": "1+1"}, "range": "today"}, headers=h).json()["value"] == 2
        assert s.put(f"/api/pages/{d1['pages'][0]['id']}", json={"widgets": []}, headers=h).status_code == 403
        assert s.post("/api/dashboards", json={"name": "x"}, headers=h).status_code == 403
        assert s.get("/api/settings", headers=h).status_code == 403
        assert s.get("/api/appearance", headers=h).status_code == 200
        assert s.get("/api/dashboards/1", headers={**XRW, "X-Share-Token": "shr_invalid"}).status_code == 401
    share_id = ingress.get("/api/auth/shares").json()[0]["id"]
    ingress.delete(f"/api/auth/shares/{share_id}")
    with direct_client(app) as s:
        assert s.get(f"/api/dashboards/{d1['id']}", headers={"X-Share-Token": tok}).status_code == 401


def test_settings_secrets_masked_and_validated(ingress):
    r = ingress.put("/api/settings/homeassistant", json={"mode": "manual", "url": "http://ha:8123", "token": "secret-token"})
    assert r.status_code == 200 and r.json()["token"] == "********"
    s = ingress.get("/api/settings").json()
    assert s["homeassistant"]["token"] == "********"
    # sending the mask back keeps the stored secret
    ingress.put("/api/settings/homeassistant", json={"token": "********", "mode": "auto"})
    svc = ingress.app.state.services
    assert svc.settings.get("homeassistant", "token") == "secret-token"
    assert ingress.put("/api/settings/nonsense", json={}).status_code == 400
    assert ingress.put("/api/settings/storage", json={"unknown_key": 1}).status_code == 400
    exp = ingress.get("/api/export/config").json()
    assert exp["settings"]["homeassistant"]["token"] == "********"


def test_user_management_protects_last_admin(ingress):
    users = ingress.get("/api/auth/users").json()
    admin = users[0]
    assert ingress.patch(f"/api/auth/users/{admin['id']}", json={"role": "viewer"}).status_code == 400
    assert ingress.post("/api/auth/users", json={"username": "x", "password": "short", "role": "viewer"}).status_code == 400


def test_uploads(ingress):
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 100
    r = ingress.post("/api/uploads", files={"file": ("bg.png", png, "image/png")})
    assert r.status_code == 200
    name = r.json()["name"]
    assert ingress.get(f"/api/uploads/{name}").content == png
    assert ingress.post("/api/uploads", files={"file": ("x.svg", b"<svg><script>alert(1)</script></svg>", "image/svg+xml")}).status_code == 400
    assert ingress.get("/api/uploads/..%2f..%2fetc%2fpasswd").status_code == 404


def test_state_stat_shows_meter_reading_like_ha(app, ingress):
    svc = app.state.services
    svc.store.set_recording(["sensor.zaehler"], True, {"sensor.zaehler": {"unit_of_measurement": "kWh", "state_class": "total_increasing"}})
    info = svc.store.get("sensor.zaehler")
    t = int(time.time() // 3600 * 3600) - 4 * 3600
    # 1 kWh resolution: readings change rarely, buckets in between must carry the reading
    svc.store.insert_samples(info.id, [(t * 1000, 3560.0), ((t + 5400) * 1000, 3561.0), ((t + 9000) * 1000, 3562.0)])
    rng = {"start": t, "end": t + 4 * 3600}
    state = ingress.post("/api/data/series", json={"source": {"type": "entity", "id": "sensor.zaehler", "stat": "state"}, "range": rng, "interval": "1h"}).json()
    assert state["values"] == [3560.0, 3561.0, 3562.0, 3562.0]
    delta = ingress.post("/api/data/series", json={"source": {"type": "entity", "id": "sensor.zaehler"}, "range": rng, "interval": "1h"}).json()
    assert delta["values"] == [0.0, 1.0, 1.0, 0.0]
