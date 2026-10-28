"""E2E: animated scenes (templates + custom code) show live values, animate, stay sandboxed,
and free values can be dragged in the editor preview.
Usage: python tests/e2e/scene_widget.py http://localhost:18099 [screenshot-dir]
"""
import json
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18099"
SHOTS = sys.argv[2] if len(sys.argv) > 2 else None
HDR = {"X-Requested-With": "has", "Content-Type": "application/json"}


def api(method, path, body=None):
    req = urllib.request.Request(f"{BASE}/api/{path}", method=method, headers=HDR, data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b"null")


def e(i, stat="current"):
    return {"type": "entity", "id": i, "stat": stat}


api("POST", "entities/record", {"entity_ids": ["sensor.house_energy"], "recorded": True})
CUSTOM_HTML = """<div class="box"><div id="w">Leistung {{p}}</div><div class="bar"></div>
<div id="probe">unverändert</div><div data-show-if="p > 1000000" id="never">nie</div>
<script>document.getElementById('probe').textContent='SKRIPT LIEF'</script>
<img src="x" onerror="document.getElementById('probe').textContent='HANDLER LIEF'"></div>"""
CUSTOM_CSS = ".box{padding:40px;font-size:48px}.bar{height:30px;background:var(--accent);width:var(--p-pct)}"
d = api("POST", "dashboards", {"name": "Szenen-Test"})
api("PUT", f"pages/{d['pages'][0]['id']}", {"widgets": [
    {"id": "s", "type": "scene_solar", "title": "Solar", "config": {"template": "house_solar", "range": "today", "bind": {
        "pv": {"source": e("sensor.solar_power")}, "grid_import": {"source": e("sensor.grid_import")},
        "battery_soc": {"source": e("sensor.battery_soc")}, "home_today": {"source": e("sensor.house_energy", "auto")}},
        "labels": [{"id": "l_t", "title": "Wohnzimmer", "source": e("sensor.living_temperature"), "format": "temp", "x": 0.1, "y": 0.6}]}},
    {"id": "h", "type": "scene_heatpump", "title": "Wärmepumpe", "config": {"template": "heat_pump", "bind": {
        "hp_power": {"source": e("sensor.house_power")}, "outdoor_temp": {"source": e("sensor.living_temperature")},
        "flow_temp": {"source": e("sensor.living_temperature")}, "energy_today": {"source": e("sensor.house_energy", "auto")}}}},
    {"id": "c", "type": "scene", "title": "Eigen", "config": {"template": "custom", "custom": {
        "html": CUSTOM_HTML, "css": CUSTOM_CSS, "w": 800, "h": 400,
        "vars": [{"key": "p", "label": "P", "format": "power", "source": e("sensor.house_power"), "max": 3000}]}}}],
    "layouts": {"lg": [{"i": "s", "x": 0, "y": 0, "w": 12, "h": 9}, {"i": "h", "x": 12, "y": 0, "w": 12, "h": 9},
                       {"i": "c", "x": 0, "y": 9, "w": 12, "h": 7}]}})

fails = []


def check(cond, msg):
    print(("  OK   " if cond else "  FEHLER ") + msg)
    if not cond:
        fails.append(msg)


with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1600, "height": 1000})
    console = []
    pg.on("console", lambda m: console.append(m.text))
    pg.goto(f"{BASE}/#/d/{d['id']}")
    pg.wait_for_selector("iframe[title=Szene]")
    pg.wait_for_timeout(4000)
    frames = pg.locator("iframe[title=Szene]")
    check(frames.count() == 3, f"3 Szenen gerendert ({frames.count()})")
    for i in range(frames.count()):
        sb = frames.nth(i).get_attribute("sandbox")
        check(sb == "allow-scripts", f"Szene {i}: sandbox='{sb}' (ohne allow-same-origin)")

    def frame(i):
        return frames.nth(i).element_handle().content_frame()

    solar = frame(0)
    live = api("POST", "data/states", {"entity_ids": ["sensor.solar_power", "sensor.house_power"]})["states"]
    pv_txt = solar.locator("[data-value=pv]").inner_text()
    check(pv_txt.endswith("W") and pv_txt != "–", f"Solar zeigt PV-Leistung: {pv_txt} (HA: {live['sensor.solar_power']['state']} W)")
    check(solar.locator("[data-value=home]").inner_text() != "–", f"Verbrauch berechnet: {solar.locator('[data-value=home]').inner_text()}")
    check(solar.locator("[data-value=battery_soc]").first.inner_text() == "64 %", "Batterie-Ladestand 64 %")
    check(solar.locator(".row.opt-home_today b").inner_text().endswith("kWh"), f"Verbrauch heute: {solar.locator('.row.opt-home_today b').inner_text()}")
    check(not solar.locator(".chip.opt-car").is_visible(), "E-Auto ausgeblendet (nicht zugeordnet)")
    check(solar.locator(".has-label").inner_text().endswith("°C"), f"freier Wert: {solar.locator('.has-label').inner_text()!r}")
    cls = solar.evaluate("document.documentElement.className")
    check("has-pv" in cls and "has-battery_soc" in cls, f"Klassen gesetzt: {cls}")

    hp = frame(1)
    check(hp.locator("[data-value=hp_power]").inner_text() != "–", f"WP Strom: {hp.locator('[data-value=hp_power]').inner_text()}")
    anim = hp.evaluate("getComputedStyle(document.querySelector('.fan')).animationPlayState")
    check(anim == "running", f"Lüfter dreht (animation-play-state={anim})")
    check(hp.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--hp_power-dur').trim()").endswith("s"), "Drehzahl-Variable gesetzt")

    c = frame(2)
    check(c.locator("#probe").inner_text() == "unverändert", f"eigenes Skript/Event-Handler blockiert: {c.locator('#probe').inner_text()!r}")
    check(c.locator("#w").inner_text().startswith("Leistung ") and c.locator("#w").inner_text() != "Leistung –", f"Platzhalter ersetzt: {c.locator('#w').inner_text()!r}")
    check(not c.locator("#never").is_visible(), "data-show-if blendet aus")
    w = c.evaluate("document.querySelector('.bar').getBoundingClientRect().width")
    check(w > 0, f"Balken folgt var(--p-pct): {w:.0f}px")
    blocked = c.evaluate("""() => { try { return document.cookie, localStorage.length, 'ZUGRIFF' } catch (e) { return 'blockiert' } }""")
    check(blocked == "blockiert", f"kein Zugriff auf Cookies/Speicher: {blocked}")

    # live update
    before = frame(1).locator("[data-value=hp_power]").inner_text()
    changed = False
    for _ in range(25):
        pg.wait_for_timeout(1000)
        if frame(1).locator("[data-value=hp_power]").inner_text() != before:
            changed = True
            break
    check(changed, f"Wert aktualisiert live ohne Neuladen: {before} → {frame(1).locator('[data-value=hp_power]').inner_text()}")
    if SHOTS:
        pg.screenshot(path=f"{SHOTS}/scenes.png")
        frames.nth(0).screenshot(path=f"{SHOTS}/scene_solar.png")
        frames.nth(1).screenshot(path=f"{SHOTS}/scene_heatpump.png")

    # editor: drag the free value in the preview
    pg.click("button:has-text('Bearbeiten')")
    pg.wait_for_timeout(800)
    pg.get_by_role("button", name="Solar", exact=True).click()
    pg.wait_for_timeout(1500)
    prev = pg.locator("iframe[title=Szene]").last
    pf = prev.element_handle().content_frame()
    pf.wait_for_selector(".has-label")
    box = pf.locator(".has-label").bounding_box()
    fb = prev.bounding_box()
    pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    pg.mouse.down()
    pg.mouse.move(fb["x"] + fb["width"] * 0.8, fb["y"] + fb["height"] * 0.3, steps=8)
    pg.mouse.up()
    pg.wait_for_timeout(800)
    if SHOTS:
        pg.screenshot(path=f"{SHOTS}/scene_editor.png")
    pg.click("button:has-text('Fertig')")
    pg.wait_for_timeout(2500)
    page = api("GET", f"dashboards/{d['id']}")["pages"][0]
    lab = next(w for w in page["widgets"] if w["id"] == "s")["config"]["labels"][0]
    check(abs(lab["x"] - 0.8) < 0.05 and abs(lab["y"] - 0.3) < 0.05, f"freier Wert verschoben und gespeichert: x={lab['x']} y={lab['y']}")
    errs = [m for m in console if "error" in m.lower() and "favicon" not in m.lower()]
    print("Konsole:", errs[:5])
    b.close()

print("[e2e] OK" if not fails else f"[e2e] FEHLER: {fails}")
sys.exit(1 if fails else 0)
