"""E2E: a chart of consumption ("today", hourly) re-evaluates as soon as the meter changes in HA –
not only after its 60 s polling interval. The dev HA simulator changes the meter every 10 s.
Usage: python tests/e2e/live_refresh.py http://localhost:18099
"""
import json
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18099"
HDR = {"X-Requested-With": "has", "Content-Type": "application/json"}


def api(method, path, body=None):
    req = urllib.request.Request(f"{BASE}/api/{path}", method=method, headers=HDR, data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"null")


api("POST", "entities/record", {"entity_ids": ["sensor.house_energy"], "recorded": True})
api("POST", "constants", {"key": "preis_live", "value": 0.3, "unit": "€/kWh"})
try:
    api("POST", "metrics", {"name": "Kosten live", "key": "kosten_live", "formula": "sensor.house_energy * preis_live", "unit": "€"})
except Exception:  # noqa: BLE001 – exists from a previous run
    pass
d = api("POST", "dashboards", {"name": "Live-Test"})
api("PUT", f"pages/{d['pages'][0]['id']}", {"widgets": [
    {"id": "c", "type": "bar", "title": "Verbrauch heute", "config": {"sources": [{"type": "entity", "id": "sensor.house_energy"}], "range": "today", "interval": "1h", "refresh": 300}},
    {"id": "k", "type": "value", "title": "Kosten heute", "config": {"sources": [{"type": "metric", "id": "kosten_live"}], "range": "today", "decimals": 4, "refresh": 300}}],
    "layouts": {"lg": [{"i": "c", "x": 0, "y": 0, "w": 12, "h": 6}, {"i": "k", "x": 12, "y": 0, "w": 6, "h": 4}]}})
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1600, "height": 900})
    batches = []
    pg.on("request", lambda r: "/api/data/batch" in r.url and batches.append((time.time(), r.post_data)))
    pg.goto(f"{BASE}/#/d/{d['id']}")
    pg.wait_for_selector("text=Kosten heute")
    pg.wait_for_timeout(2000)
    v0 = pg.locator(".react-grid-item", has_text="Kosten heute").inner_text()
    t0 = time.time()
    pg.wait_for_timeout(35000)
    v1 = pg.locator(".react-grid-item", has_text="Kosten heute").inner_text()
    chart = [t for t, body in batches if t > t0 and "series" in (body or "")]
    metric = [t for t, body in batches if t > t0 and "kosten_live" in (body or "")]
    b.close()
print(f"[e2e] in 35 s (Polling-Intervall 300 s): Diagramm {len(chart)}× neu berechnet, Kennzahl {len(metric)}× neu berechnet")
print(f"[e2e] Kosten-Kachel vorher: {v0.splitlines()[1:2]} nachher: {v1.splitlines()[1:2]}")
ok = len(chart) >= 2 and len(metric) >= 2 and v0 != v1
print("[e2e] OK" if ok else "[e2e] FEHLER: keine Live-Neuberechnung")
sys.exit(0 if ok else 1)
