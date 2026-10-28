"""Independent audit of the add-on's calculations on the live instance.

Every value is computed (1) by the add-on, (2) where possible by Home Assistant itself,
(3) independently here from the stored raw samples (own implementation, not the add-on code).
"""
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, "/dev/shm/has")
from hah import api  # noqa: E402

TZ = ZoneInfo("Europe/Berlin")
NOW = time.time()
MIDNIGHT = int(datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
MONTH = int(datetime.now(TZ).replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())
results = []


def check(name, addon, reference, tol, ref_label, note=""):
    ok = addon is not None and reference is not None and abs(addon - reference) <= tol
    results.append(ok)
    a = "–" if addon is None else f"{addon:.3f}"
    r = "–" if reference is None else f"{reference:.3f}"
    print(f"{'OK ' if ok else 'ABW'} {name:46} Add-on {a:>10} | {ref_label} {r:>10} {note}")


def scalar(src, rng):
    r = api("POST", "data/scalar", {"source": src, "range": rng})
    return r.get("value")


def E(i, stat=None):
    return {"type": "entity", "id": i, **({"stat": stat} if stat else {})}


def M(k):
    return {"type": "metric", "id": k}


def raw(eid, start, end):
    """stored samples incl. 3 days before start (for the value in effect at start)"""
    r = api("GET", f"entities/{eid}/raw?start={int(start) - 3 * 86400}&end={int(end) + 1}&limit=100000")
    return [(t / 1000, v) for t, v in r["samples"]]


def tw_mean(samples, start, end):
    """own time-weighted mean (step function, None = gap)"""
    cur, total, cov = None, 0.0, 0.0
    t_prev = start
    for t, v in samples:
        if t <= start:
            cur = v
            continue
        if t >= end:
            break
        if cur is not None:
            total += cur * (t - t_prev)
            cov += t - t_prev
        cur, t_prev = v, t
    if cur is not None:
        total += cur * (end - t_prev)
        cov += end - t_prev
    return total / cov if cov else None


def counter_delta(samples, start, end):
    """own consumption: last reading in range minus last reading before range (resets: +new value)"""
    base = None
    total = 0.0
    for t, v in samples:
        if v is None:
            continue
        if t <= start:
            base = v
            continue
        if t >= end:
            break
        if base is not None:
            total += v - base if v >= base else v
        base = v
    return total


def ha_state(eid):
    st = api("POST", "data/states", {"entity_ids": [eid]})["states"][eid]
    return float(st["state"]) if st and st["state"] not in ("unknown", "unavailable") else None


print("=" * 100)
print("STROM")
Z = "sensor.stromzahler"
now = time.time()
zs = raw(Z, MIDNIGHT, now)
today = scalar(E(Z), "today")
check("Verbrauch heute (Zähler)", today, ha_state("sensor.tagesverbrauch"), 1.0, "HA Tagesverbrauch ", "(Zähler meldet ganze kWh: ±1)")
check("Verbrauch heute – Rohdaten nachgerechnet", today, counter_delta(zs, MIDNIGHT, now), 0.001, "Rohdaten         ")
check("Tagesverbrauch-Sensor als Zähler (heute)", scalar(E("sensor.tagesverbrauch"), "today"), ha_state("sensor.tagesverbrauch"), 1.0, "HA Zustand       ", "(täglicher Reset)")
month = scalar(E(Z), "this_month")
check("Verbrauch diesen Monat", month, ha_state("sensor.monatsverbrauch"), 2.0, "HA Monatsverbrauch")
check("Stromkosten heute = Verbrauch × 0,39", scalar(M("stromkosten"), "today"), today * 0.39, 0.005, "nachgerechnet    ")
check("Stromkosten Monat = Verbrauch × 0,39", scalar(M("stromkosten"), "this_month"), month * 0.39, 0.01, "nachgerechnet    ")
daily = api("POST", "data/series", {"source": E(Z), "range": "last_30d", "interval": "1d"})
full_days = [v for v, c in zip(daily["values"][:-1], daily["coverage"][:-1]) if v is not None]
avg30 = scalar(M("strom_tag"), "last_30d")
check("Ø Tagesverbrauch 30 Tage", avg30, sum(daily["values"]) / len([v for v in daily["values"] if v is not None]), 0.05, "Mittel Tageswerte")
check("Ø Tagesverbrauch 30 Tage (vs. HA-Sensor)", avg30, ha_state("sensor.durchschnittlicher_stromverbrauch_30_tage"), 1.0, "HA Ø 30 Tage     ", "(HA zählt Tage anders: grobe Kontrolle)")
s30 = scalar(E(Z), {"last": "30d"})
check("Hochrechnung Jahr = 30-Tage-Summe × 365/30", scalar(M("strom_hochrechnung_jahr"), "today"), s30 * 365 / 30, 365 / 30 * 1.01, "nachgerechnet    ", "(±1 kWh Zählerauflösung × 12,2)")
check("Hochrechnung Kosten = Jahr × 0,39", scalar(M("strom_hochrechnung_kosten"), "today"), scalar(M("strom_hochrechnung_jahr"), "today") * 0.39, 0.05, "nachgerechnet    ")
teich = scalar(E("sensor.teich_energie"), "last_30d") + (scalar(E("sensor.garten_teich_springbrunnen_energie"), "last_30d") or 0)
z30 = scalar(E(Z), "last_30d")
check("Teich-Anteil 30 Tage (%)", scalar(M("teich_anteil"), "last_30d"), teich / z30 * 100, 0.05, "nachgerechnet    ")
check("Teichkosten 30 Tage", scalar(M("teich_kosten"), "last_30d"), teich * 0.39, 0.01, "nachgerechnet    ")
lights = ["sensor.flur_licht_energie", "sensor.buro_licht_switch_0_energy", "sensor.treppen_licht_switch_0_energy", "sensor.schlafzimmer_licht_energie", "sensor.terrassen_licht_energie"]
check("Licht gesamt 30 Tage", scalar(M("licht_energie"), "last_30d"), sum((scalar(E(e), "last_30d") or 0) for e in lights), 0.001, "Summe Lichtkreise")
cov_m = api("POST", "data/scalar", {"source": E(Z, "coverage"), "range": "this_month"})["value"]
check("Mehrverbrauch Monat = Verbr. − 15,2 × Tage", scalar(M("strom_mehrverbrauch"), "this_month"), month - 15.2 * (now - MONTH) / 86400 * cov_m, 1.5, "nachgerechnet    ", f"(Abdeckung {cov_m:.2f})")
tp = raw("sensor.teich_leistung", MIDNIGHT, now)
check("Teichpumpe Ø Leistung heute (W)", scalar(E("sensor.teich_leistung"), "today"), tw_mean(tp, MIDNIGHT, now), 0.5, "Rohdaten zeitgew.")
check("Teichpumpe Energie aus Leistung ≈ Zähler (kWh)", tw_mean(tp, MIDNIGHT, now) * (now - MIDNIGHT) / 3600 / 1000, scalar(E("sensor.teich_energie"), "today"), 0.25, "Teich-Zähler     ", "(Plausibilität W→kWh)")

print("=" * 100)
print("TEMPERATUREN")
rooms = {"Wohnraum": "sensor.erdgeschoss_temperature", "Poleraum": "sensor.dachgeschoss_temperatur", "Büro": "sensor.bad_temperatur",
         "Bad": "sensor.badezimmer_thermostat", "Schlafzimmer": "sensor.schlafzimmer_thermostat", "Wohnzimmer": "sensor.wohnzimmer_temperature",
         "Außen": "sensor.aussentemperatur_sensor_temperature"}
day_start = MIDNIGHT
raws = {n: raw(e, day_start, now) for n, e in rooms.items()}
for n, e in rooms.items():
    check(f"Ø {n} heute (zeitgewichtet)", scalar(E(e), "today"), tw_mean(raws[n], day_start, now), 0.02, "Rohdaten zeitgew.")
    mn = min(v for t, v in raws[n] if day_start < t < now and v is not None) if any(day_start < t < now for t, v in raws[n]) else None
    prior = [v for t, v in raws[n] if t <= day_start and v is not None]
    cand = [mn] + prior[-1:] if mn is not None else prior[-1:]
    check(f"Min {n} heute", scalar(E(e, "min"), "today"), min(cand) if cand else None, 0.001, "Rohdaten         ")
# hourly averages for metrics that combine rooms
hours = list(range(day_start, int(now // 3600 * 3600), 3600))
inner = ["Wohnraum", "Poleraum", "Büro", "Bad", "Schlafzimmer", "Wohnzimmer"]
bad_old = raw("sensor.bad_temperatur::archiv_20261027", day_start, now)
hour_avgs, spreads, hdd = [], [], 0.0
for h in hours:
    vals = []
    for n in inner:
        v = tw_mean(raws[n], h, h + 3600)
        if n == "Bad" and v is None:
            v = tw_mean(bad_old, h, h + 3600)
        if v is not None:
            vals.append(v)
    if vals:
        hour_avgs.append(sum(vals) / len(vals))
        spreads.append(max(vals) - min(vals))
    out = tw_mean(raws["Außen"], h, h + 3600)
    if out is not None:
        hdd += max(0.0, 20 - out) / 24
# add-on evaluates metrics over complete hours of the range incl. the current hour
r_inner = api("POST", "data/series", {"source": M("temp_innen_avg"), "range": {"start": day_start, "end": hours[-1] + 3600}, "interval": "1h"})
check("Ø Innen je Stunde (Mittel über Stunden)", sum(v for v in r_inner["values"] if v is not None) / len([v for v in r_inner["values"] if v is not None]),
      sum(hour_avgs) / len(hour_avgs), 0.02, "nachgerechnet    ")
r_sp = api("POST", "data/series", {"source": M("temp_spreizung_raeume"), "range": {"start": day_start, "end": hours[-1] + 3600}, "interval": "1h"})
check("Spreizung Räume (Ø der Stunden)", sum(v for v in r_sp["values"] if v is not None) / len([v for v in r_sp["values"] if v is not None]),
      sum(spreads) / len(spreads), 0.02, "nachgerechnet    ")
r_h = api("POST", "data/series", {"source": M("heizgradtage"), "range": {"start": day_start, "end": hours[-1] + 3600}, "interval": "1h"})
check("Heizgradtage heute (abgeschlossene Stunden)", sum(v for v in r_h["values"] if v is not None), hdd, 0.02, "nachgerechnet    ")
check("Ø Innen (Add-on) vs. HA-Durchschnittssensor", scalar(M("temp_innen_avg"), "today"), ha_state("sensor.durchschnitts_temperatur"), 1.0, "HA Ø-Sensor      ", "(andere Raumauswahl: grobe Kontrolle)")
for room, (sensor, climate) in {"Wohnraum": ("sensor.erdgeschoss_temperature", "climate.untere_etage_erdgeschoss"),
                                "Poleraum": ("sensor.dachgeschoss_temperatur", "climate.pole_raum"),
                                "Schlafzimmer": ("sensor.schlafzimmer_thermostat", "climate.schlafzimmer")}.items():
    sp = raw(f"{climate}::temperature", day_start, now)
    ist = raw(sensor, day_start, now)
    diffs = []
    for h in hours:
        a, b = tw_mean(ist, h, h + 3600), tw_mean(sp, h, h + 3600)
        if a is not None and b is not None:
            diffs.append(a - b)
    key = {"Wohnraum": "soll_abw_eg", "Poleraum": "soll_abw_dg", "Schlafzimmer": "soll_abw_schlaf"}[room]
    r = api("POST", "data/series", {"source": M(key), "range": {"start": day_start, "end": hours[-1] + 3600}, "interval": "1h"})
    v = [x for x in r["values"] if x is not None]
    check(f"Soll-Abweichung {room} (Ø Stunden)", sum(v) / len(v) if v else None, sum(diffs) / len(diffs) if diffs else None, 0.02, "nachgerechnet    ")
heat = {c: raw(f"{c}::heating", day_start, now) for c in ("climate.untere_etage_erdgeschoss", "climate.pole_raum", "climate.buro", "climate.room_climate_badezimmer", "climate.schlafzimmer")}
for c, s in heat.items():
    check(f"Heizanteil {c.split('.')[1]} heute (%)", scalar(E(f"{c}::heating"), "today"), tw_mean(s, day_start, now), 0.1, "Rohdaten zeitgew.")

print("=" * 100)
print(f"Ergebnis: {sum(results)} von {len(results)} Prüfungen innerhalb der Toleranz")
