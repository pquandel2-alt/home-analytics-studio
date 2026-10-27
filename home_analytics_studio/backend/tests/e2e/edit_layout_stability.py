"""Regression (1.0.5): tiles must not jump when leaving edit mode.

Creates a dashboard, edits on a wide window (1920 px), moves a tile, presses "Fertig"
and checks the order/relative position of tiles in view mode equals the edited layout.
Usage: python tests/e2e/edit_layout_stability.py http://localhost:18099
"""
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18099"
HDR = {"X-Requested-With": "has", "Content-Type": "application/json"}


def api(method, path, body=None):
    req = urllib.request.Request(f"{BASE}/api/{path}", method=method, headers=HDR,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"null")


def positions(page):
    """grid positions (x, y) of tiles derived from the rendered DOM, keyed by title"""
    return page.evaluate("""() => {
        const out = {}; const grid = document.querySelector('.react-grid-layout').getBoundingClientRect()
        for (const el of document.querySelectorAll('.react-grid-item')) {
            const r = el.getBoundingClientRect(); const t = el.querySelector('h3')?.textContent || '?'
            out[t] = [(r.left - grid.left) / grid.width, Math.round(r.top - grid.top)]
        }
        return out }""")


def main() -> int:
    d = api("POST", "dashboards", {"name": "Layout-Test"})
    page_id = d["pages"][0]["id"]
    widgets = [{"id": f"w{i}", "type": "heading", "title": f"Kachel {i}", "config": {"text": f"K{i}"}} for i in range(3)]
    layouts = {"lg": [{"i": f"w{i}", "x": i * 6, "y": 0, "w": 6, "h": 3} for i in range(3)],
               # deliberately different layout for large monitors (as on the user's dashboard)
               "xl": [{"i": f"w{i}", "x": 0, "y": i * 4, "w": 4, "h": 3} for i in range(3)]}
    api("PUT", f"pages/{page_id}", {"widgets": widgets, "layouts": layouts})
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1920, "height": 1000})
        pg.goto(f"{BASE}/#/d/{d['id']}")
        pg.wait_for_selector(".react-grid-item")
        pg.wait_for_timeout(800)
        before = positions(pg)
        pg.click("button:has-text('Bearbeiten')")
        pg.wait_for_timeout(1000)
        # move "Kachel 0" down by dragging
        item = pg.locator(".react-grid-item", has_text="Kachel 0")
        box = item.bounding_box()
        pg.mouse.move(box["x"] + 30, box["y"] + 15)
        pg.mouse.down()
        pg.mouse.move(box["x"] + 30, box["y"] + 15 + 160, steps=12)
        pg.mouse.up()
        pg.wait_for_selector("text=Gespeichert", timeout=10000)
        edited = positions(pg)
        pg.click("button:has-text('Fertig')")
        pg.wait_for_timeout(1200)
        after = positions(pg)
        b.close()
    print("view before:", before)
    print("editor     :", edited)
    print("view after :", after)
    ok = True
    for t in edited:
        # horizontal position as fraction of grid width must match; vertical order must match
        if abs(edited[t][0] - after[t][0]) > 0.02:
            print("FEHLER: horizontale Position verschoben:", t)
            ok = False
    order_e = sorted(edited, key=lambda t: (edited[t][1], edited[t][0]))
    order_a = sorted(after, key=lambda t: (after[t][1], after[t][0]))
    if order_e != order_a:
        print("FEHLER: Reihenfolge verschoben", order_e, order_a)
        ok = False
    if before["Kachel 0"] == after["Kachel 0"]:
        print("FEHLER: Verschieben im Editor hatte in der Ansicht keine Wirkung")
        ok = False
    print("OK" if ok else "FEHLGESCHLAGEN")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
