"""MCP server: tools, security, token rotation/revocation and persistence across add-on restarts."""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from has.app import create_app

XRW = {"X-Requested-With": "has"}
KEY = "k" * 40
ROOT = Path(__file__).resolve().parent.parent


def write_options(data_dir: Path, **opts) -> None:
    (data_dir / "options.json").write_text(json.dumps(opts))


def make_cfg(config):
    config.ingress_port = 80
    config.ingress_trusted_ips = ["testclient"]
    return config


def new_token(ingress, role="editor", name="chatgpt", days=None):
    uid = ingress.post("/api/auth/users", json={"username": name, "password": "password123", "role": role}).json()["id"]
    r = ingress.post("/api/auth/tokens", json={"name": f"mcp-{name}", "user_id": uid, **({"days": days} if days else {})})
    assert r.status_code == 200, r.text
    return r.json()


class Rpc:
    def __init__(self, client, path="/mcp", headers=None):
        self.c, self.path, self.h, self.n = client, path, headers or {}, 0

    def post(self, method, params=None, **kw):
        self.n += 1
        return self.c.post(self.path, headers=self.h, json={"jsonrpc": "2.0", "id": self.n, "method": method,
                                                           "params": params or {}}, **kw)

    def call(self, tool, **args):
        r = self.post("tools/call", {"name": tool, "arguments": args})
        assert r.status_code == 200, r.text
        res = r.json()["result"]
        return res["isError"], (json.loads(res["content"][0]["text"]) if not res["isError"] else res["content"][0]["text"])


@pytest.fixture
def env(config):
    make_cfg(config)
    app = create_app(config, start_background=False)
    with TestClient(app) as ingress:
        ingress.headers.update({**XRW, "X-Remote-User-Name": "philipp"})
        tok = new_token(ingress)
        write_options(config.data_dir, mcp_access_key=KEY, mcp_api_token=tok["token"])
        direct = TestClient(app, base_url="http://testserver:8100")
        yield app, ingress, direct, tok, config


def test_discovery_and_tool_list(env):
    _, _, direct, tok, _ = env
    rpc = Rpc(direct, headers={"Authorization": f"Bearer {KEY}"})
    init = rpc.post("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}}).json()["result"]
    assert init["protocolVersion"] == "2025-06-18" and "tools" in init["capabilities"]
    assert direct.post("/mcp", headers=rpc.h, json={"jsonrpc": "2.0", "method": "notifications/initialized"}).status_code == 202
    tools = rpc.post("tools/list").json()["result"]["tools"]
    assert {t["name"] for t in tools} == {
        "analytics_list_dashboards", "analytics_get_dashboard", "analytics_create_dashboard",
        "analytics_update_dashboard", "analytics_update_page", "analytics_list_metrics", "analytics_get_data",
        "analytics_system_status"}
    # tool definitions never contain a token / the access key
    blob = json.dumps(tools)
    assert tok["token"] not in blob and KEY not in blob and "has_" not in blob
    assert all(t["inputSchema"]["type"] == "object" for t in tools)
    # the same path-style URL works for clients that cannot set headers
    assert Rpc(direct, path=f"/mcp/{KEY}").post("tools/list").status_code == 200


def test_dashboard_workflow_with_editor_token(env):
    _, _, direct, tok, _ = env
    rpc = Rpc(direct, headers={"Authorization": f"Bearer {KEY}"})
    err, created = rpc.call("analytics_create_dashboard", name="Energie (ChatGPT)")
    assert not err and created["name"] == "Energie (ChatGPT)"
    did, page = created["id"], created["pages"][0]
    err, lst = rpc.call("analytics_list_dashboards")
    assert not err and any(d["id"] == did for d in lst)
    widgets = [{"id": "w1", "type": "value", "title": "Kosten", "config": {"sources": [{"type": "metric", "id": "kosten"}]}}]
    err, upd = rpc.call("analytics_update_page", page_id=page["id"], widgets=widgets,
                        layouts={"lg": [{"i": "w1", "x": 0, "y": 0, "w": 4, "h": 3}]}, version=page["version"])
    assert not err and upd["version"] == page["version"] + 1
    # stale version -> conflict instead of overwriting
    err, msg = rpc.call("analytics_update_page", page_id=page["id"], title="x", version=page["version"])
    assert err and "409" in msg and "Version" in msg
    err, got = rpc.call("analytics_get_dashboard", dashboard_id=did)
    assert not err and got["pages"][0]["widgets"] == widgets
    err, renamed = rpc.call("analytics_update_dashboard", dashboard_id=did, name="Energie 2")
    assert not err and renamed["name"] == "Energie 2"
    assert rpc.call("analytics_get_dashboard", dashboard_id=99999)[0]


def test_metrics_data_and_status(env):
    _, ingress, direct, tok, _ = env
    assert ingress.post("/api/constants", json={"key": "preis", "value": 2.0}).status_code == 200
    assert ingress.post("/api/metrics", json={"name": "Kosten", "key": "kosten", "formula": "preis * 2", "unit": "€"}).status_code == 200
    rpc = Rpc(direct, headers={"Authorization": f"Bearer {KEY}"})
    err, metrics = rpc.call("analytics_list_metrics")
    assert not err and [m["key"] for m in metrics] == ["kosten"]
    err, both = rpc.call("analytics_list_metrics", include_constants=True)
    assert not err and both["constants"][0]["key"] == "preis"
    err, data = rpc.call("analytics_get_data", source={"type": "metric", "id": "kosten"}, range="today")
    assert not err and isinstance(data, dict)
    err, series = rpc.call("analytics_get_data", source={"type": "metric", "id": "kosten"}, range="7d", mode="series")
    assert not err, series
    assert rpc.call("analytics_get_data", source={"type": "metric"})[0]
    err, st = rpc.call("analytics_system_status")
    assert not err and st["access"]["role"] == "editor" and st["access"]["kind"] == "api"
    assert tok["token"] not in json.dumps(st) and "data_dir" not in st


def test_roles_are_respected(env, config):
    app, ingress, direct, _, _ = env
    viewer = new_token(ingress, role="viewer", name="vi")
    write_options(config.data_dir, mcp_access_key=KEY, mcp_api_token=viewer["token"])
    rpc = Rpc(direct, headers={"Authorization": f"Bearer {KEY}"})
    assert not rpc.call("analytics_list_dashboards")[0]
    err, msg = rpc.call("analytics_create_dashboard", name="nope")
    assert err and "Berechtigung" in msg


def test_endpoint_protection(env):
    app, ingress, direct, tok, config = env
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
    assert direct.post("/mcp", json=body).status_code == 401  # no key
    assert direct.post("/mcp", json=body, headers={"Authorization": "Bearer wrong" + "x" * 30}).status_code == 401
    assert direct.post("/mcp", json=body, headers={"Authorization": f"Bearer {tok['token']}"}).status_code == 401  # API token != access key
    assert direct.post("/mcp/" + "z" * 40, json=body).status_code == 401
    assert direct.get("/mcp", headers={"Authorization": f"Bearer {KEY}"}).status_code == 405
    # never through the ingress listener, even with the right key
    assert ingress.post("/mcp", json=body, headers={"Authorization": f"Bearer {KEY}"}).status_code == 404
    # too short key = feature off
    write_options(config.data_dir, mcp_access_key="short", mcp_api_token=tok["token"])
    assert direct.post("/mcp/short", json=body).status_code == 404
    assert direct.post("/mcp", json=body, headers={"Authorization": "Bearer short"}).status_code == 404
    write_options(config.data_dir, mcp_api_token=tok["token"])  # no key at all
    assert direct.post("/mcp", json=body).status_code == 404


def test_brute_force_is_rate_limited(env):
    from has import mcp as m
    m._limiter.hits.clear()
    _, _, direct, _, _ = env
    codes = {direct.post("/mcp", json={}, headers={"Authorization": "Bearer " + "a" * 30}).status_code for _ in range(40)}
    assert 429 in codes
    m._limiter.hits.clear()


def test_missing_and_bad_token_messages_do_not_leak(env, config):
    _, _, direct, tok, _ = env
    rpc = Rpc(direct, headers={"Authorization": f"Bearer {KEY}"})
    write_options(config.data_dir, mcp_access_key=KEY)
    err, msg = rpc.call("analytics_list_dashboards")
    assert err and "mcp_api_token" in msg
    write_options(config.data_dir, mcp_access_key=KEY, mcp_api_token="has_" + "0" * 43)
    err, msg = rpc.call("analytics_list_dashboards")
    assert err and "ungültig" in msg and "has_000" not in msg


def test_token_rotation_and_revocation_without_restart(env, config):
    app, ingress, direct, tok, _ = env
    rpc = Rpc(direct, headers={"Authorization": f"Bearer {KEY}"})
    assert not rpc.call("analytics_list_dashboards")[0]
    # revoke -> immediately refused (tool error with instructions)
    assert ingress.delete(f"/api/auth/tokens/{tok['id']}").status_code == 200
    err, msg = rpc.call("analytics_list_dashboards")
    assert err and "widerrufen" in msg
    # rotate: new token in the options file, picked up on the next call
    new = new_token(ingress, name="chatgpt2")
    time.sleep(0.01)
    write_options(config.data_dir, mcp_access_key=KEY, mcp_api_token=new["token"])
    assert not rpc.call("analytics_list_dashboards")[0]
    # demoting the user takes effect at once
    uid = new["user_id"]
    assert ingress.patch(f"/api/auth/users/{uid}", json={"role": "viewer"}).status_code == 200
    assert rpc.call("analytics_create_dashboard", name="x")[0]
    assert not rpc.call("analytics_list_dashboards")[0]


def test_token_never_logged(env, caplog):
    _, _, direct, tok, _ = env
    caplog.set_level("DEBUG")
    rpc = Rpc(direct, headers={"Authorization": f"Bearer {KEY}"})
    rpc.call("analytics_list_dashboards")
    rpc.call("analytics_get_dashboard", dashboard_id=12345)
    assert tok["token"] not in caplog.text and KEY not in caplog.text


def test_survives_restart_new_app_instance(config):
    """Add-on restart: new process/app on the same /data; a fresh client (= new chat) works without any setup."""
    make_cfg(config)
    app1 = create_app(config, start_background=False)
    with TestClient(app1) as ingress:
        ingress.headers.update({**XRW, "X-Remote-User-Name": "philipp"})
        tok = new_token(ingress)
        write_options(config.data_dir, mcp_access_key=KEY, mcp_api_token=tok["token"])
        d1 = TestClient(app1, base_url="http://testserver:8100")
        err, made = Rpc(d1, headers={"Authorization": f"Bearer {KEY}"}).call("analytics_create_dashboard", name="Persistent")
        assert not err
    app2 = create_app(config, start_background=False)  # restart
    with TestClient(app2) as client:
        d2 = TestClient(app2, base_url="http://testserver:8100")
        rpc = Rpc(d2, path=f"/mcp/{KEY}")  # brand-new conversation: only tools/list + calls
        names = {t["name"] for t in rpc.post("tools/list").json()["result"]["tools"]}
        assert "analytics_update_page" in names
        err, lst = rpc.call("analytics_list_dashboards")
        assert not err and any(d["id"] == made["id"] for d in lst)


def test_existing_data_untouched_by_reads(env):
    _, ingress, direct, _, _ = env
    before = ingress.get("/api/dashboards").json()
    rpc = Rpc(direct, headers={"Authorization": f"Bearer {KEY}"})
    for d in before:
        rpc.call("analytics_get_dashboard", dashboard_id=d["id"])
    rpc.call("analytics_list_dashboards")
    rpc.call("analytics_system_status")
    assert ingress.get("/api/dashboards").json() == before


# ---------------------------------------------------------------- real process restart


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _http(url, body=None, headers=None, method=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None


def _start(data_dir, ingress_port, direct_port):
    env = {**os.environ, "HAS_DATA_DIR": str(data_dir), "HAS_INGRESS_PORT": str(ingress_port),
           "HAS_DIRECT_PORT": str(direct_port), "HAS_HOST": "127.0.0.1", "HAS_INGRESS_TRUSTED_IPS": "127.0.0.1",
           "PYTHONPATH": str(ROOT)}
    for k in ("HAS_MCP_ACCESS_KEY", "HAS_MCP_API_TOKEN"):
        env.pop(k, None)
    proc = subprocess.Popen([sys.executable, "-m", "has"], env=env, cwd=ROOT, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True)
    for _ in range(100):
        try:
            if _http(f"http://127.0.0.1:{ingress_port}/api/health")[0] == 200 and \
                    _http(f"http://127.0.0.1:{direct_port}/api/health")[0] == 200:
                return proc
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(0.2)
    proc.kill()
    raise RuntimeError("Server startet nicht:\n" + (proc.stdout.read() if proc.stdout else ""))


def _stop(proc) -> str:
    proc.terminate()
    try:
        out, _ = proc.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, _ = proc.communicate()
    return out or ""


def test_real_process_restart_keeps_mcp_working(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    ip, dp = _free_port(), _free_port()
    proc = _start(data, ip, dp)
    logs = ""
    try:
        base = f"http://127.0.0.1:{ip}"  # ingress listener (trusted peer 127.0.0.1) to bootstrap user + token
        h = {**XRW, "X-Remote-User-Name": "philipp"}
        st, user = _http(base + "/api/auth/users", {"username": "chatgpt", "password": "password123", "role": "editor"}, h)
        assert st == 200
        st, tok = _http(base + "/api/auth/tokens", {"name": "mcp", "user_id": user["id"]}, h)
        assert st == 200
        write_options(data, mcp_access_key=KEY, mcp_api_token=tok["token"])
        url = f"http://127.0.0.1:{dp}/mcp"
        auth = {"Authorization": f"Bearer {KEY}"}
        call = lambda tool, **a: _http(url, {"jsonrpc": "2.0", "id": 1, "method": "tools/call",  # noqa: E731
                                              "params": {"name": tool, "arguments": a}}, auth)
        st, r = call("analytics_create_dashboard", name="Neustart-Test")
        assert st == 200 and not r["result"]["isError"]
        did = json.loads(r["result"]["content"][0]["text"])["id"]
        logs += _stop(proc)
        # --- restart (add-on restart): same /data, new process, new connection
        proc = _start(data, ip, dp)
        st, r = _http(url, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, auth)
        assert st == 200 and len(r["result"]["tools"]) == 8
        st, r = call("analytics_get_dashboard", dashboard_id=did)
        assert st == 200 and not r["result"]["isError"]
        assert json.loads(r["result"]["content"][0]["text"])["name"] == "Neustart-Test"
        # header-less access and ingress port stay closed
        assert _http(url, {"jsonrpc": "2.0", "id": 3, "method": "tools/list"})[0] == 401
        assert _http(f"http://127.0.0.1:{ip}/mcp", {"jsonrpc": "2.0", "id": 3, "method": "tools/list"}, auth)[0] == 404
    finally:
        logs += _stop(proc)
    assert tok["token"] not in logs and KEY not in logs
