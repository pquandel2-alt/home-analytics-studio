"""E2E: phone presses "Senden" -> HA turns the (simulated) TV on and opens the dashboard URL in
the TV browser -> the TV shows the dashboard. Nothing is done "on the TV".

Starts its own HA simulator (with a TV entity) and an add-on instance.
Usage: VENV=/path/venv python tests/e2e/tv_launch.py /tmp/shots
"""
import asyncio
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tests.mock_ha import MockHA  # noqa: E402

SHOTS = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/has-shots")
SHOTS.mkdir(parents=True, exist_ok=True)
VENV_PY = os.environ.get("VENV", "/dev/shm/has/venv") + "/bin/python"
HA_PORT, ING, DIR = 18124, 18199, 18200
BASE = f"http://localhost:{ING}"
HDR = {"X-Requested-With": "has", "Content-Type": "application/json"}
opened: "queue.Queue[str]" = queue.Queue()


def api(method, path, body=None):
    req = urllib.request.Request(f"{BASE}/api/{path}", method=method, headers=HDR,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"null")


def run_mock(ready: threading.Event):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    ha = MockHA(token="t")
    ha.set_state("media_player.samsung_tv", "off", {"friendly_name": "Fernseh Wohnzimmer", "device_class": "tv",
                                                     "can_launch_apps": True, "can_power_on": True})

    async def on_service(msg):
        if msg["service"] == "play_media":
            opened.put(msg["service_data"]["media_content_id"])
    ha.on_service = on_service
    loop.run_until_complete(ha.start(HA_PORT))
    ready.set()
    loop.run_forever()


def main() -> int:
    ready = threading.Event()
    threading.Thread(target=run_mock, args=(ready,), daemon=True).start()
    ready.wait(10)
    data = tempfile.mkdtemp()
    env = {**os.environ, "HAS_DATA_DIR": data, "HAS_HA_URL": f"http://127.0.0.1:{HA_PORT}", "HAS_HA_TOKEN": "t",
           "HAS_INGRESS_PORT": str(ING), "HAS_DIRECT_PORT": str(DIR), "HAS_INGRESS_TRUSTED_IPS": "127.0.0.1",
           "HAS_STATIC_DIR": str(ROOT.parent / "frontend" / "dist")}
    app = subprocess.Popen([VENV_PY, "-m", "has"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    try:
        for _ in range(60):
            try:
                if api("GET", "health")["ha"] == "connected":
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.5)
        d = api("POST", "dashboards", {"name": "Energie TV"})
        api("PUT", f"pages/{d['pages'][0]['id']}", {"widgets": [{"id": "h", "type": "heading", "title": "", "config": {"text": "Energie auf dem TV"}}],
                                                    "layouts": {"lg": [{"i": "h", "x": 0, "y": 0, "w": 24, "h": 3}]}})
        api("PUT", "settings/displays", {"boot_wait_seconds": 1})
        errors = []
        with sync_playwright() as p:
            b = p.chromium.launch()
            phone = b.new_page(viewport={"width": 1280, "height": 900})
            phone.on("pageerror", lambda e: errors.append(str(e)))
            # 1. admin enables TV control and links the TV (settings UI)
            phone.goto(BASE + "/#/settings/displays")
            phone.wait_for_selector("text=Fernseher automatisch einschalten")
            phone.click("text=Fernseher-Steuerung erlauben")
            phone.wait_for_selector("text=Gespeichert")
            phone.fill("input[placeholder='http://192.168.178.101:8100']", f"http://localhost:{DIR}")
            phone.locator("button:has-text('Speichern')").first.click()
            phone.locator("select").filter(has_text="Fernseher wählen").select_option("media_player.samsung_tv")
            phone.click("button:has-text('Verknüpfen')")
            phone.wait_for_selector("text=verknüpft")
            print("[e2e] Fernseher-Steuerung erlaubt und TV verknüpft")
            # 2. phone: dashboard -> "Auf Bildschirm" -> Senden
            phone.set_viewport_size({"width": 390, "height": 844})
            phone.goto(f"{BASE}/#/d/{d['id']}")
            phone.wait_for_selector("text=Energie auf dem TV")
            phone.click("button[title^='Dashboard auf einem anderen Bildschirm']")
            phone.wait_for_selector("text=wird beim Senden eingeschaltet")
            phone.click("button:has-text('Senden')")
            phone.wait_for_selector("text=wird eingeschaltet")
            print("[e2e] Senden gedrückt – TV wird eingeschaltet")
            # 3. HA opens the URL in the TV browser
            url = opened.get(timeout=30)
            assert url.startswith(f"http://localhost:{DIR}/tv?display=dsp_"), url
            tv = b.new_page(viewport={"width": 1920, "height": 1080})
            tv.on("pageerror", lambda e: errors.append(str(e)))
            tv.goto(url)
            tv.wait_for_selector("text=Energie auf dem TV", timeout=20000)
            tv.screenshot(path=str(SHOTS / "tv_launch.png"))
            print("[e2e] TV zeigt das Dashboard ohne Eingabe am TV")
            phone.wait_for_selector("text=zeigt jetzt das Dashboard", timeout=40000)
            print("[e2e] Handy bekommt Erfolgsmeldung")
            b.close()
        disp = api("GET", "displays")[0]
        assert disp["last_launch_error"] is None, disp
        if errors:
            print("[e2e] Fehler:", errors[:5])
            return 1
        print("[e2e] OK")
        return 0
    finally:
        app.terminate()
        app.wait(10)


if __name__ == "__main__":
    sys.exit(main())
