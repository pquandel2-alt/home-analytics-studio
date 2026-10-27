"""Remote displays: register, pair, push, read-only access."""
from fastapi.testclient import TestClient

from has.app import create_app

XRW = {"X-Requested-With": "has"}


def test_display_pairing_show_and_permissions(config):
    config.ingress_port = 80
    config.ingress_trusted_ips = ["testclient"]
    app = create_app(config, start_background=False)
    with TestClient(app) as user:
        user.headers.update(XRW)
        dash = user.post("/api/dashboards", json={"name": "TV"}).json()
        with TestClient(app, base_url="http://testserver:8100") as tv:
            reg = tv.post("/api/displays/register", json={"screen": "1920x1080"}, headers=XRW).json()
            h = {**XRW, "X-Display-Token": reg["token"]}
            me = tv.get("/api/displays/me", headers=h).json()
            assert not me["paired"] and me["code"] == reg["code"]
            # no data access before pairing
            assert tv.get(f"/api/dashboards/{dash['id']}", headers=h).status_code == 403
            assert user.post("/api/displays/pair", json={"code": "0000" if reg["code"] != "0000" else "1111", "name": "x"}).status_code == 404
            d = user.post("/api/displays/pair", json={"code": reg["code"], "name": "Wohnzimmer-TV"}).json()
            assert d["paired"] and d["name"] == "Wohnzimmer-TV"
            assert tv.get(f"/api/dashboards/{dash['id']}", headers=h).status_code == 200
            assert tv.post("/api/data/scalar", json={"source": {"type": "formula", "formula": "2*3"}, "range": "today"}, headers=h).json()["value"] == 6
            # read-only: no writes, no settings, cannot push to other displays
            assert tv.post("/api/dashboards", json={"name": "y"}, headers=h).status_code == 403
            assert tv.get("/api/settings", headers=h).status_code == 403
            assert tv.post(f"/api/displays/{d['id']}/show", json={"dashboard_id": dash["id"]}, headers=h).status_code == 403
            # user sends a dashboard
            r = user.post(f"/api/displays/{d['id']}/show", json={"dashboard_id": dash["id"], "page_id": dash["pages"][0]["id"], "present": True}).json()
            assert r["current"]["dashboard_id"] == dash["id"]
            assert tv.get("/api/displays/me", headers=h).json()["current"]["dashboard_id"] == dash["id"]
            assert [x["name"] for x in user.get("/api/displays").json()] == ["Wohnzimmer-TV"]
            assert user.post(f"/api/displays/{d['id']}/show", json={"dashboard_id": 999}).status_code == 404
            # short URL for TV remotes
            assert tv.get("/tv", follow_redirects=False).headers["location"] == "./#/display"
            # unpairing revokes access
            user.delete(f"/api/displays/{d['id']}")
            assert tv.get(f"/api/dashboards/{dash['id']}", headers=h).status_code == 401
        # register requires custom header (no cross-site abuse)
        with TestClient(app, base_url="http://testserver:8100") as anon:
            assert anon.post("/api/displays/register", json={}).status_code == 403


def test_display_websocket_receives_show(config):
    config.ingress_port = 80
    config.ingress_trusted_ips = ["testclient"]
    app = create_app(config, start_background=False)
    with TestClient(app) as user:
        user.headers.update(XRW)
        dash = user.post("/api/dashboards", json={"name": "TV"}).json()
        reg = user.post("/api/displays/register", json={}).json()
        d = user.post("/api/displays/pair", json={"code": reg["code"], "name": "Flur"}).json()
        if True:
            with user.websocket_connect(f"/api/ws?display={reg['token']}") as ws:
                assert ws.receive_json()["type"] == "hello"
                assert user.get("/api/displays").json()[0]["online"] is True
                res = user.post(f"/api/displays/{d['id']}/show", json={"dashboard_id": dash["id"], "present": False}).json()
                assert res["delivered"] is True
                msg = ws.receive_json()
                assert msg["type"] == "display_show" and msg["current"]["dashboard_id"] == dash["id"]
