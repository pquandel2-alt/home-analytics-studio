"""Browser end-to-end smoke test (Playwright, Chromium).

Requires a running instance (scripts/dev-run.sh) whose ingress port trusts 127.0.0.1.
Usage: python tests/e2e/ui_smoke.py http://localhost:18099 /tmp/shots
"""
from __future__ import annotations

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


def api(method: str, path: str, body=None):
    req = urllib.request.Request(f"{BASE}/api/{path}", method=method, headers=HDR,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"null")


def step(name: str) -> None:
    print(f"[e2e] {name}", flush=True)


def main() -> int:
    errors: list[str] = []
    try:
        return _run(errors)
    except Exception:
        print("[e2e] FEHLER – Screenshot: failure.png", flush=True)
        raise


def _run(errors: list[str]) -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))
        try:
            return _steps(page, browser, errors)
        except Exception:
            page.screenshot(path=str(SHOTS / "failure.png"))
            print("[e2e] Toasts:", page.locator("[role=status]").all_inner_texts(), "Konsole:", errors[:5])
            raise


def _steps(page, browser, errors: list[str]) -> int:
    if True:  # keep step bodies at one indentation level
        step("Startseite")
        page.goto(BASE + "/")
        page.wait_for_selector("text=Dashboards")

        step("Entitäten: Aufzeichnung per Schalter aktivieren")
        page.click("nav >> text=Entitäten")
        page.fill("input[placeholder^='Suche nach Name']", "house_power")
        page.wait_for_selector("text=sensor.house_power")
        page.locator("tr", has_text="sensor.house_power").locator("button[role=switch]").click()
        page.wait_for_selector("text=werden aufgezeichnet")
        page.screenshot(path=str(SHOTS / "01_entities.png"))
        assert any(e["entity_id"] == "sensor.house_power" and e["recorded"] for e in api("GET", "entities?recorded=true")["entities"])

        step("Historie importieren (API) + Kennzahl anlegen")
        api("POST", "entities/record", {"entity_ids": ["sensor.house_energy", "sensor.living_temperature"], "recorded": True})
        job = api("POST", "import/history", {"entity_ids": ["sensor.house_energy", "sensor.house_power", "sensor.living_temperature"], "range": {"last": "10d"}})
        for _ in range(120):
            if api("GET", f"jobs/{job['job_id']}")["status"] in ("done", "failed"):
                break
            time.sleep(0.5)
        assert api("GET", f"jobs/{job['job_id']}")["status"] == "done"
        api("POST", "constants", {"key": "strompreis", "name": "Strompreis", "value": 0.32, "unit": "€/kWh"})

        step("Kennzahl im Formel-Editor anlegen (UI)")
        page.click("nav >> text=Kennzahlen")
        page.click("text=Neue Kennzahl")
        page.fill("input[placeholder='z. B. Stromkosten']", "Stromkosten")
        page.click("text=Erweiterter Formel-Editor")
        page.fill("textarea[placeholder^='z. B. sensor.stromzaehler']", "sensor.house_energy * strompreis")
        page.wait_for_selector("text=Formel gültig")
        page.wait_for_selector("text=Einheit: €")
        page.click("button:has-text('Berechnen')")
        page.wait_for_selector("text=Wert im Zeitraum")
        page.screenshot(path=str(SHOTS / "02_metric_editor.png"))
        page.click("button:has-text('Speichern')")
        page.wait_for_selector("text=Kennzahl gespeichert")
        # invalid formula shows a readable error
        page.click("text=Neue Kennzahl")
        page.click("text=Erweiterter Formel-Editor")
        page.fill("textarea[placeholder^='z. B. sensor.stromzaehler']", "sensor.house_energy * (2 + 1")
        page.wait_for_selector("text=Fehlende schließende Klammer")
        page.keyboard.press("Escape")

        step("Dashboard anlegen")
        page.click("nav >> text=Dashboards")
        page.click("text=Neues Dashboard")
        page.fill("div[role=dialog] input", "Energie")
        page.click("div[role=dialog] >> text=OK")
        page.wait_for_selector("text=Bearbeiten")
        dash_id = int(page.url.split("/d/")[1].split("/")[0].split("?")[0])
        page.click("text=Bearbeiten")

        step("Widgets aus der Palette hinzufügen und konfigurieren")
        page.click("aside >> button:has-text('Liniendiagramm')")
        page.click("button:has-text('Quelle hinzufügen')")
        page.fill("div[role=dialog] input[placeholder^='Suchen']", "house_power")
        page.locator("div[role=dialog] button", has_text="sensor.house_power").click()
        page.click("div[role=dialog] button:has-text('übernehmen')")
        page.wait_for_selector(".react-grid-item canvas", timeout=20000)

        page.click("aside >> button:has-text('KPI-Karte')")
        page.click("button:has-text('Quelle wählen')")
        page.click("div[role=dialog] >> text=Kennzahlen")
        page.locator("div[role=dialog] button", has_text="Stromkosten").click()
        page.click("aside >> button:has-text('Energieflussdiagramm')")
        page.click("aside >> button:has-text('Heatmap')")
        page.click("button:has-text('Quelle wählen')")
        page.fill("div[role=dialog] input[placeholder^='Suchen']", "house_energy")
        page.locator("div[role=dialog] button", has_text="sensor.house_energy").click()
        page.click("aside >> button:has-text('Datum/Uhrzeit')")
        page.wait_for_timeout(2500)

        step("Drag & Drop: Widget verschieben")
        before = api("GET", f"dashboards/{dash_id}")["pages"][0]
        first_id = before["widgets"][0]["id"]
        x_before = next(l for l in before["layouts"]["lg"] if l["i"] == first_id)["x"]
        item = page.locator(".react-grid-item").first
        item.scroll_into_view_if_needed()
        box = item.bounding_box()
        page.mouse.move(box["x"] + 60, box["y"] + 30)
        page.mouse.down()
        page.mouse.move(box["x"] + 60 + box["width"] * 0.6, box["y"] + 30, steps=15)
        page.mouse.up()
        page.wait_for_timeout(300)
        step("Rückgängig / Wiederherstellen")
        page.keyboard.press("Control+z")
        page.keyboard.press("Control+y")
        page.wait_for_selector("text=Gespeichert", timeout=10000)
        page.screenshot(path=str(SHOTS / "03_editor.png"))
        saved = api("GET", f"dashboards/{dash_id}")["pages"][0]
        assert len(saved["widgets"]) == 5, saved["widgets"]
        lg = next(l for l in saved["layouts"]["lg"] if l["i"] == first_id)
        assert lg["x"] > x_before, f"drag not persisted: {lg}"

        step("Ansichtsmodus + responsive Layouts")
        page.click("button:has-text('Fertig')")
        page.wait_for_timeout(3000)
        page.screenshot(path=str(SHOTS / "04_dashboard.png"), full_page=True)
        page.set_viewport_size({"width": 390, "height": 844})
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS / "05_mobile.png"))
        page.set_viewport_size({"width": 1600, "height": 1000})

        step("Design-Preset wechseln")
        page.click("button[title='Dashboard-Einstellungen']")
        page.click("div[role=dialog] >> text=Design")
        page.click("div[role=dialog] >> text=Futuristic Neon")
        page.click("div[role=dialog] button:has-text('Speichern')")
        page.wait_for_selector("text=Dashboard gespeichert")
        assert api("GET", f"dashboards/{dash_id}")["theme"]["preset"] == "futuristic-neon"
        page.wait_for_timeout(2000)
        page.screenshot(path=str(SHOTS / "06_neon.png"))

        step("Präsentationsmodus")
        page.click("button[title='Präsentationsmodus']")
        page.wait_for_selector(".react-grid-item")
        page.wait_for_timeout(2500)
        page.screenshot(path=str(SHOTS / "07_present.png"))

        step("Analyse")
        page.goto(BASE + "/#/analysis")
        page.click("button:has-text('Datenquelle wählen')")
        page.fill("div[role=dialog] input[placeholder^='Suchen']", "house_energy")
        page.locator("div[role=dialog] button", has_text="sensor.house_energy").click()
        page.click("button:has-text('Analysieren')")
        page.wait_for_selector("text=Automatische Erkenntnisse", timeout=30000)
        page.wait_for_timeout(1500)
        page.screenshot(path=str(SHOTS / "08_analysis.png"), full_page=True)
        text = page.inner_text("body")
        assert "Höchster Tageswert" in text, "no insights rendered"

        step("ChatGPT-Export")
        page.click("button:has-text('Mit ChatGPT analysieren')")
        page.click("button:has-text('Auswertung & Prompt erstellen')")
        page.wait_for_selector("text=Prompt kopieren", timeout=30000)
        page.screenshot(path=str(SHOTS / "09_chatgpt.png"))

        step("Einstellungen: Backup erstellen")
        page.goto(BASE + "/#/settings/backup")
        page.click("button:has-text('Vollständige Sicherung')")
        page.wait_for_selector("text=Sicherung erstellt")
        page.goto(BASE + "/#/settings/diagnostics")
        page.wait_for_selector("text=Datenbank-Integrität")
        page.screenshot(path=str(SHOTS / "10_diagnostics.png"))
        browser.close()

    relevant = [e for e in errors if "favicon" not in e]
    if relevant:
        print("[e2e] Browser-Konsolenfehler:", *relevant[:20], sep="\n  ")
        return 1
    print("[e2e] OK – alle Schritte erfolgreich")
    return 0


if __name__ == "__main__":
    sys.exit(main())
