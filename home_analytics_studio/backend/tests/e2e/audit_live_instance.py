"""Live audit: websocket latency, recording delay, freshness of evaluated values, widget update modes."""
import asyncio
import http.cookiejar
import json
import sys
import time
from datetime import datetime

import aiohttp

sys.path.insert(0, "/dev/shm/has")
from hah import api  # noqa: E402

HOST = "192.168.178.101:8100"
WATCH = ["sensor.teich_leistung", "sensor.teich_aktueller_stromverbrauch", "sensor.stromzahler", "sensor.erdgeschoss_temperature",
         "sensor.aussentemperatur_sensor_temperature", "sensor.wohnzimmer_temperature", "climate.untere_etage_erdgeschoss::temperature",
         "sensor.garten_teich_springbrunnen_leistung", "sensor.kucheninsel_leistung"]


def ts(s):
    return datetime.fromisoformat(s).timestamp() if s else None


async def ws_watch(seconds):
    cj = http.cookiejar.MozillaCookieJar("/dev/shm/has/cj.txt")
    cj.load(ignore_discard=True, ignore_expires=True)
    cookie = "; ".join(f"{c.name}={c.value}" for c in cj)
    events = []
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(f"ws://{HOST}/api/ws", headers={"Cookie": cookie, "Origin": f"http://{HOST}"}) as ws:
            await ws.send_json({"type": "subscribe", "entities": WATCH})
            t_end = time.time() + seconds
            while time.time() < t_end:
                try:
                    msg = await asyncio.wait_for(ws.receive(), t_end - time.time())
                except asyncio.TimeoutError:
                    break
                if msg.type != aiohttp.WSMsgType.TEXT:
                    break
                got = time.time()
                data = json.loads(msg.data)
                for m in data if isinstance(data, list) else [data]:
                    if m.get("type") == "state" and m.get("state"):
                        events.append((m["entity_id"], m["state"]["state"], ts(m["state"]["last_updated"]), got))
    return events


print("1) Live-Übertragung Home Assistant -> Add-on -> Browser (WebSocket, 120 s beobachtet)")
events = asyncio.run(ws_watch(120))
lat = [got - lu for _, _, lu, got in events if lu]
print(f"   {len(events)} Live-Änderungen empfangen von {len({e[0] for e in events})} Entitäten")
if lat:
    lat.sort()
    print(f"   Verzögerung (HA-Zeitstempel bis Ankunft im Browser): Median {lat[len(lat)//2]:.2f} s, max {lat[-1]:.2f} s")
    print("   Hinweis: enthält die interne Bündelung von 150 ms im Browser nicht (die kommt noch hinzu)")
for eid in WATCH:
    n = [e for e in events if e[0] == eid]
    if n:
        print(f"   {eid:48} {len(n):3} Updates, zuletzt {n[-1][1]}")

print("\n2) Speicherung: liegt der zuletzt empfangene Wert in der Datenbank?")
for eid in {e[0] for e in events}:
    last = [e for e in events if e[0] == eid][-1]
    ent = api("GET", f"entities/{eid}")
    stored_ts = (ent.get("last_ts") or 0) / 1000
    if not ent.get("recorded"):
        print(f"   {eid:48} nicht aufgezeichnet (nur live)")
        continue
    same = abs(stored_ts - last[2]) < 1.5 if last[2] else False
    print(f"   {eid:48} {'gespeichert' if same else 'NICHT gespeichert'}: DB {ent.get('last_value')} @ {datetime.fromtimestamp(stored_ts):%H:%M:%S} | live {last[1]} @ {datetime.fromtimestamp(last[2]):%H:%M:%S}")

print("\n3) Enthalten Auswertungen den neuesten Messwert? (kein Warten auf Verdichtung)")
for eid in ["sensor.teich_leistung", "sensor.stromzahler", "sensor.erdgeschoss_temperature"]:
    live = api("POST", "data/states", {"entity_ids": [eid]})["states"][eid]
    last = api("POST", "data/scalar", {"source": {"type": "entity", "id": eid, "stat": "last"}, "range": "today"})["value"]
    hourly = api("POST", "data/series", {"source": {"type": "entity", "id": eid, "stat": "last"}, "range": "today", "interval": "1h"})
    tail = [v for v in hourly["values"] if v is not None][-1]
    print(f"   {eid:40} live {float(live['state']):>9.2f} | 'heute' letzter Wert {last:>9.2f} | Stundenreihe aktuelle Stunde {tail:>9.2f}"
          f"  {'OK' if abs(float(live['state']) - last) < 1e-6 and abs(tail - last) < 1e-6 else 'ABWEICHUNG'}")
info = api("GET", "system/info")
print(f"   Verdichtung zuletzt: vor {time.time() - (info['recorder']['last_rollup'] or 0):.0f} s, Schreibpuffer: {info['recorder']['pending']} offen,"
      f" zuletzt geschrieben vor {time.time() - (info['recorder']['last_flush'] or 0):.0f} s")

print("\n4) Aktualisierung der Kacheln auf deinen Dashboards")
LIVE_TYPES = {"energy_flow", "text", "info", "clock"}
for d in api("GET", "dashboards"):
    full = api("GET", f"dashboards/{d['id']}")
    instant, periodic, static = [], [], []
    for p in full["pages"]:
        for w in p["widgets"]:
            cfg = w["config"]
            srcs = (cfg.get("sources") or []) + list((cfg.get("slots") or {}).values())
            title = w.get("title") or w["type"]
            if w["type"] in ("heading", "image"):
                static.append(title)
            elif w["type"] in LIVE_TYPES or any((s or {}).get("stat") == "current" for s in srcs) or (w["type"] == "sparkline" and cfg.get("valueMode", "current") == "current"):
                instant.append(title)
            else:
                periodic.append((title, cfg.get("refresh", 60)))
    print(f"   {d['name']}: {len(instant)} sofort live, {len(periodic)} im Intervall, {len(static)} statisch")
    intervals = sorted({r for _, r in periodic})
    print(f"      Intervalle: {', '.join(f'{i} s' for i in intervals) or '–'}")
