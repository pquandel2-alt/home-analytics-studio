"""E2E: a share link opened in a brand-new anonymous browser (no cookie, no sessionStorage, not ingress)
must load the presentation without any login.

Starts its own HA simulator and add-on instance (direct port = login listener, so no implicit ingress rights).
Usage: VENV=/path/venv python tests/e2e/share_anonymous.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
VENV_PY = os.environ.get("VENV", "/dev/shm/has/venv") + "/bin/python"
HA_PORT, ING, DIRECT = 18324, 18399, 18400
HDR = {"X-Requested-With": "has", "Content-Type": "application/json"}


def api(method, path, body=None):
    req = urllib.request.Request(f"http://localhost:{ING}/api/{path}", method=method, headers=HDR,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def wait_up():
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://localhost:{DIRECT}/api/health", timeout=2)
            return
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("instance did not start")


def present(browser, url, expect_ok=True):
    ctx = browser.new_context()  # new anonymous session: no cookies, empty storage
    page = ctx.new_page()
    reqs = []
    page.on("request", lambda r: "/api/" in r.url and reqs.append((r.url.split("/api/")[1].split("?")[0], r.headers.get("x-share-token"))))
    if expect_ok:
        with page.expect_response(lambda r: "/api/dashboards/" in r.url and r.status == 200, timeout=15000):
            page.goto(url)
        page.wait_for_timeout(1000)
    else:
        page.goto(url)
        page.wait_for_selector("text=Präsentation nicht verfügbar", timeout=15000)
    return ctx, page, reqs


def main():
    data = tempfile.mkdtemp()
    env = {**os.environ, "HAS_DATA_DIR": data, "HAS_HA_URL": f"http://127.0.0.1:{HA_PORT}", "HAS_HA_TOKEN": "test",
           "HAS_INGRESS_PORT": str(ING), "HAS_DIRECT_PORT": str(DIRECT), "HAS_INGRESS_TRUSTED_IPS": "127.0.0.1",
           "HAS_STATIC_DIR": str(ROOT.parent / "frontend" / "dist")}
    mock = subprocess.Popen([VENV_PY, "-m", "tests.mock_ha", "--port", str(HA_PORT), "--token", "test", "--days", "2"],
                            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2)
    app = subprocess.Popen([VENV_PY, "-m", "has"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_up()
        d6 = api("POST", "dashboards", {"name": "Hauszentrale"})
        d7 = api("POST", "dashboards", {"name": "Privat"})
        tok = api("POST", "auth/shares", {"name": "TV", "dashboard_id": d6["id"]})["token"]
        base = f"http://localhost:{DIRECT}/"
        with sync_playwright() as p:
            browser = p.chromium.launch()
            # 1) fresh anonymous session, first protected request already carries the token
            ctx, page, reqs = present(browser, f"{base}#/present/{d6['id']}?share={tok}&kiosk=1")
            assert reqs and all(t == tok for _, t in reqs), reqs
            assert any(u == f"dashboards/{d6['id']}" for u, _ in reqs), reqs
            assert "Anmeldung" not in page.inner_text("body")
            # 2) full reload keeps working
            reqs.clear()
            page.reload()
            page.wait_for_timeout(2000)
            assert any(u == f"dashboards/{d6['id']}" for u, _ in reqs) and all(t == tok for _, t in reqs), reqs
            # 3) the same token must not open another dashboard
            reqs.clear()
            page.goto(f"{base}#/present/{d7['id']}")
            page.reload()  # hash change alone does not reload; make it a real page load of the other dashboard
            page.wait_for_timeout(2000)
            assert all(t is None for _, t in reqs), reqs  # d6's token must not be sent for d7
            ctx.close()
            # 4) invalid token
            ctx, page, _ = present(browser, f"{base}#/present/{d6['id']}?share=shr_invalid", expect_ok=False)
            ctx.close()
            # 5) revoked token
            api("DELETE", f"auth/shares/{api('GET', 'auth/shares')[0]['id']}")
            ctx, page, _ = present(browser, f"{base}#/present/{d6['id']}?share={tok}", expect_ok=False)
            ctx.close()
            browser.close()
        print("[e2e] share_anonymous OK")
        return 0
    finally:
        app.terminate()
        mock.terminate()


if __name__ == "__main__":
    sys.exit(main())
