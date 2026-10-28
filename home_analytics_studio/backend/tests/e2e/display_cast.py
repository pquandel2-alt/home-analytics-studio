"""E2E: a TV opens /tv, gets a pairing code, a phone pairs it and sends a dashboard which appears live.

Usage: python tests/e2e/display_cast.py http://localhost:18099 /tmp/shots
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18099"
SHOTS = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/has-shots")
SHOTS.mkdir(parents=True, exist_ok=True)
HDR = {"X-Requested-With": "has", "Content-Type": "application/json"}


def api(method, path, body=None):
    req = urllib.request.Request(f"{BASE}/api/{path}", method=method, headers=HDR,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"null")


def main() -> int:
    d = api("POST", "dashboards", {"name": "Fernseh-Test"})
    pages = d["pages"]
    api("PUT", f"pages/{pages[0]['id']}", {"widgets": [{"id": "h", "type": "heading", "title": "", "config": {"text": "Seite Eins"}}],
                                           "layouts": {"lg": [{"i": "h", "x": 0, "y": 0, "w": 24, "h": 3}]}})
    p2 = api("POST", f"dashboards/{d['id']}/pages", {"title": "Zwei"})
    api("PUT", f"pages/{p2['id']}", {"widgets": [{"id": "h2", "type": "heading", "title": "", "config": {"text": "Seite Zwei"}}],
                                     "layouts": {"lg": [{"i": "h2", "x": 0, "y": 0, "w": 24, "h": 3}]}})
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        tv = b.new_context(viewport={"width": 1920, "height": 1080}).new_page()
        tv.on("pageerror", lambda e: errors.append(str(e)))
        # 1. TV opens the short URL
        tv.goto(BASE + "/tv")
        tv.wait_for_selector("text=Kopplungscode")
        code = tv.locator(".font-mono").first.inner_text().strip()
        assert len(code) == 4 and code.isdigit(), code
        tv.screenshot(path=str(SHOTS / "tv_1_code.png"))
        print("[e2e] TV zeigt Code", code)
        # 2. phone: dashboard -> "Auf Bildschirm" -> pair
        phone = b.new_page(viewport={"width": 390, "height": 844})
        phone.on("pageerror", lambda e: errors.append(str(e)))
        phone.goto(f"{BASE}/#/d/{d['id']}/{p2['id']}")
        phone.wait_for_selector("text=Seite Zwei")
        name = f"TV-Test-{int(time.time()) % 100000}"
        phone.click("button[title^='Teilen']")
        phone.click("text=Gerät per Code koppeln")
        phone.fill("input[placeholder='1234']", code)
        phone.fill("input[value='Wohnzimmer-TV']", name)
        phone.click("button:has-text('Koppeln')")
        phone.wait_for_selector("text=gekoppelt")
        print("[e2e] gekoppelt")
        # pairing with a default dashboard: the TV shows it right away
        tv.wait_for_selector("text=Seite Eins", timeout=15000)
        # 3. the share sheet stays open with the new device – tap it to send page two
        phone.locator("button", has_text=name).first.click()
        phone.wait_for_selector(f"text=Wird auf „{name}“ angezeigt")
        tv.wait_for_selector("text=Seite Zwei", timeout=15000)
        tv.screenshot(path=str(SHOTS / "tv_2_dashboard.png"))
        phone.screenshot(path=str(SHOTS / "tv_phone.png"))
        print("[e2e] Dashboard-Seite 2 erscheint live auf dem TV")
        # 4. TV reload/power cycle: stays paired and restores the dashboard
        tv.reload()
        tv.wait_for_selector("text=Seite Zwei", timeout=15000)
        print("[e2e] nach Neuladen weiterhin gekoppelt und Dashboard wiederhergestellt")
        # 5. unpair -> new code
        disp = next(x for x in api("GET", "displays") if x["name"] == name)
        api("DELETE", f"displays/{disp['id']}")
        tv.wait_for_selector("text=Kopplungscode", timeout=20000)
        print("[e2e] Entkoppeln -> neuer Kopplungscode")
        b.close()
    if errors:
        print("[e2e] Fehler:", errors[:5])
        return 1
    print("[e2e] OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
