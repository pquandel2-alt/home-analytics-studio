"""Statistical analysis engine (no AI): comparisons, trends, peaks, anomalies.

Every statement is derived from stored measurements. Periods with incomplete
data are flagged and comparisons are made like-for-like (same elapsed part of
the period) when the current period is still running.
"""
from __future__ import annotations

import math
import time
from datetime import datetime
from typing import Any

from .engine import DataEngine
from .stats import MEASUREMENT
from .timeutil import add_interval, floor_local, iso_local

WEEKDAYS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober",
          "November", "Dezember"]
MIN_COVERAGE = 0.8

PERIODS = {
    "day": ("1d", "heute", "gestern", "Tag"),
    "week": ("1w", "diese Woche", "letzte Woche", "Woche"),
    "month": ("1mo", "diesen Monat", "letzten Monat", "Monat"),
    "year": ("1y", "dieses Jahr", "letztes Jahr", "Jahr"),
}


def fmt_num(v: float | None, decimals: int | None = None) -> str:
    if v is None or (isinstance(v, float) and not math.isfinite(v)):
        return "–"
    if decimals is None:
        a = abs(v)
        decimals = 0 if a >= 1000 else 1 if a >= 100 else 2 if a >= 1 else 3
    s = f"{v:,.{decimals}f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def fmt_val(v: float | None, unit: str | None) -> str:
    s = fmt_num(v)
    return f"{s} {unit}".strip() if unit else s


def pct_change(cur: float | None, prev: float | None) -> float | None:
    if cur is None or prev is None or prev == 0:
        return None
    return (cur - prev) / abs(prev) * 100.0


def linear_trend(values: list[float | None]) -> tuple[float, float, float] | None:
    """Least squares slope/intercept/r² over non-null points (x = index)."""
    pts = [(i, v) for i, v in enumerate(values) if v is not None]
    if len(pts) < 5:
        return None
    n = len(pts)
    sx = sum(p[0] for p in pts)
    sy = sum(p[1] for p in pts)
    sxx = sum(p[0] ** 2 for p in pts)
    sxy = sum(p[0] * p[1] for p in pts)
    den = n * sxx - sx * sx
    if den == 0:
        return None
    slope = (n * sxy - sx * sy) / den
    intercept = (sy - slope * sx) / n
    mean = sy / n
    ss_tot = sum((p[1] - mean) ** 2 for p in pts)
    ss_res = sum((p[1] - (slope * p[0] + intercept)) ** 2 for p in pts)
    r2 = 1 - ss_res / ss_tot if ss_tot else 0.0
    return slope, intercept, r2


class AnalysisEngine:
    def __init__(self, engine: DataEngine):
        self.engine = engine

    def _source_meta(self, source: dict) -> dict:
        if source.get("type") == "metric":
            defs = self.engine.metric_defs()
            d = defs.get(source.get("id"))
            if not d:
                raise ValueError(f"Unbekannte Kennzahl '{source.get('id')}'")
            agg = d["aggregation"]
            mean_like = agg in ("mean", "last", "min", "max")
            return {"name": d["name"], "unit": d["unit"], "mean_like": mean_like, "kind": "metric"}
        meta = self.engine.entity_meta(source.get("id"))
        if meta is None:
            raise ValueError(f"Unbekannte Entität '{source.get('id')}'")
        return {"name": meta["name"], "unit": meta["unit"], "mean_like": meta["kind"] == MEASUREMENT, "kind": meta["kind"]}

    async def _value(self, source: dict, start: int, end: int, now: float) -> dict:
        res = await self.engine.scalar(source, {"start": start, "end": end}, now=now)
        return res

    # ------------------------------------------------------------------ comparisons

    async def compare_periods(self, source: dict, period: str, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        tz = self.engine.tz()
        interval, cur_label, prev_label, noun = PERIODS[period]
        cur_start = floor_local(now, interval, tz)
        prev_start = add_interval(cur_start, interval, tz, -1)
        elapsed = now - cur_start
        prev_same = min(cur_start, int(prev_start + elapsed))
        cur = await self._value(source, cur_start, int(now), now)
        prev_full = await self._value(source, prev_start, cur_start, now)
        prev_part = await self._value(source, prev_start, prev_same, now)
        return {
            "period": period,
            "label": cur_label,
            "previous_label": prev_label,
            "current": cur.get("value"),
            "current_coverage": cur.get("coverage"),
            "previous": prev_full.get("value"),
            "previous_coverage": prev_full.get("coverage"),
            "previous_same_elapsed": prev_part.get("value"),
            "change_pct": pct_change(cur.get("value"), prev_part.get("value")),
            "change_abs": None if cur.get("value") is None or prev_part.get("value") is None
            else cur["value"] - prev_part["value"],
            "current_range": [cur_start, int(now)],
            "previous_range": [prev_start, cur_start],
            "elapsed_fraction": elapsed / max(1, cur_start - prev_start),
        }

    async def compare_ranges(self, source: dict, range_a: Any, range_b: Any, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        tz = self.engine.tz()
        from .timeutil import resolve_range

        a0, a1 = resolve_range(range_a, tz, now)
        b0, b1 = resolve_range(range_b, tz, now)
        va = await self._value(source, a0, a1, now)
        vb = await self._value(source, b0, b1, now)
        meta = self._source_meta(source)
        change = pct_change(va.get("value"), vb.get("value"))
        text = None
        if change is not None:
            direction = "höher" if change > 0 else "niedriger"
            text = (f"{meta['name']}: {fmt_val(va['value'], meta['unit'])} im Zeitraum A gegenüber "
                    f"{fmt_val(vb['value'], meta['unit'])} im Zeitraum B ({fmt_num(abs(change), 1)} % {direction}).")
        return {"a": {**va, "range": [a0, a1]}, "b": {**vb, "range": [b0, b1]}, "change_pct": change,
                "change_abs": None if va.get("value") is None or vb.get("value") is None else va["value"] - vb["value"],
                "text": text}

    # ------------------------------------------------------------------ full analysis

    async def analyze(self, source: dict, days: int = 90, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        tz = self.engine.tz()
        meta = self._source_meta(source)
        unit = meta["unit"]
        name = meta["name"]
        mean_like = meta["mean_like"]
        insights: list[dict] = []

        # --- period comparisons
        comparisons = {}
        for period in ("day", "week", "month", "year"):
            comparisons[period] = await self.compare_periods(source, period, now)
        for period in ("day", "week", "month", "year"):
            c = comparisons[period]
            if c["current"] is None or c["previous_same_elapsed"] is None:
                continue
            incomplete = any(cv is not None and cv < MIN_COVERAGE for cv in (c["current_coverage"], c["previous_coverage"]))
            if mean_like and (unit or "") in ("°C", "°F", "K"):
                diff = c["change_abs"]
                if abs(diff) < 0.05:
                    continue
                word = "höher" if diff > 0 else "niedriger"
                text = (f"{name} liegt {c['label']} im Mittel {fmt_num(abs(diff), 1)} {unit} {word} als "
                        f"{c['previous_label']} (gleicher Zeitabschnitt).")
                insights.append(_insight(f"cmp_{period}", "up" if diff > 0 else "down", text, c, incomplete))
                continue
            ch = c["change_pct"]
            if ch is None or abs(ch) < 1:
                continue
            word = "gestiegen" if ch > 0 else "gesunken"
            subject = f"Der Durchschnitt von {name}" if mean_like else name
            partial = "" if c["elapsed_fraction"] >= 0.999 else " (Vergleich mit dem gleichen Zeitabschnitt)"
            text = f"{subject} ist {c['label']} um {fmt_num(abs(ch), 0)} Prozent {word}{partial}."
            insights.append(_insight(f"cmp_{period}", "up" if ch > 0 else "down", text, c, incomplete))

        # --- daily series: average, extremes, trend, anomalies
        start = add_interval(floor_local(now, "1d", tz), "1d", tz, -days)
        daily = await self.engine.series(source, {"start": start, "end": now}, "1d", now=now)
        values = daily["values"]
        cov = daily.get("coverage") or [None] * len(values)
        complete_days = [(t, v) for t, v, c, in zip(daily["ts"][:-1], values[:-1], cov[:-1])
                         if v is not None and (c is None or c >= MIN_COVERAGE)]
        stats: dict[str, Any] = {"days_with_data": len([v for v in values if v is not None]), "days": len(values),
                                 "complete_days": len(complete_days)}
        if complete_days:
            vals = [v for _, v in complete_days]
            avg = sum(vals) / len(vals)
            stats["daily_avg"] = avg
            hi = max(complete_days, key=lambda x: x[1])
            lo = min(complete_days, key=lambda x: x[1])
            stats["max_day"] = {"ts": hi[0], "value": hi[1], "date": iso_local(hi[0], tz)[:10]}
            stats["min_day"] = {"ts": lo[0], "value": lo[1], "date": iso_local(lo[0], tz)[:10]}
            label = "Tagesdurchschnitt" if mean_like else "Durchschnittlicher Tagesverbrauch"
            insights.append(_insight("daily_avg", "info",
                                     f"{label} von {name} in den letzten {len(vals)} vollständigen Tagen: {fmt_val(avg, unit)}.",
                                     {"value": avg}, False))
            insights.append(_insight("max_day", "info",
                                     f"Höchster Tageswert: {fmt_val(hi[1], unit)} am {_date_de(hi[0], tz)}.", {"value": hi[1]}, False))
            insights.append(_insight("min_day", "info",
                                     f"Niedrigster Tageswert: {fmt_val(lo[1], unit)} am {_date_de(lo[0], tz)}.", {"value": lo[1]}, False))
            trend = linear_trend([v if (c is None or c >= MIN_COVERAGE) else None for v, c in zip(values[:-1], cov[:-1])])
            if trend and avg:
                slope, _, r2 = trend
                per_month = slope * 30 / abs(avg) * 100
                stats["trend"] = {"slope_per_day": slope, "r2": r2, "pct_per_month": per_month}
                if r2 >= 0.3 and abs(per_month) >= 3:
                    word = "steigenden" if slope > 0 else "fallenden"
                    insights.append(_insight("trend", "up" if slope > 0 else "down",
                                             f"Langfristiger {word} Trend: etwa {fmt_num(abs(per_month), 0)} % pro Monat "
                                             f"(Bestimmtheitsmaß R² = {fmt_num(r2, 2)}).", stats["trend"], False))
            # normalise sum-like daily values to 24 h so DST days (23/25 h) are not flagged
            day_len = {t: (daily["ts"][i + 1] - t) if i + 1 < len(daily["ts"]) else 86400 for i, t in enumerate(daily["ts"])}
            norm_days = complete_days if mean_like else [(t, v * 86400 / max(1, day_len.get(t, 86400))) for t, v in complete_days]
            anomalies = [(t, dict(complete_days)[t], z) for t, _, z in _anomalies(norm_days)]
            stats["anomalies"] = [{"ts": t, "value": v, "z": z, "date": iso_local(t, tz)[:10]} for t, v, z in anomalies]
            for t, v, z in anomalies[-3:]:
                word = "ungewöhnlich hoch" if z > 0 else "ungewöhnlich niedrig"
                insights.append(_insight(f"anomaly_{t}", "warning",
                                         f"Auffälliger Tag: {_date_de(t, tz)} war mit {fmt_val(v, unit)} {word} "
                                         f"(Abweichung {fmt_num(abs(z), 1)} σ vom gleitenden Mittel).", {"value": v, "z": z}, False))

        # --- hourly profile and peak window (last 7 days)
        h_start = int(now - 7 * 86400)
        hourly = await self.engine.series(source, {"start": h_start, "end": now}, "1h", now=now)
        peak = _peak_window(hourly["ts"], hourly["values"], 2, mean_like)
        if peak:
            ts, val = peak
            dt = datetime.fromtimestamp(ts, tz)
            end_h = (dt.hour + 2) % 24
            what = "Der höchste Durchschnittswert" if mean_like else "Der höchste Verbrauch"
            insights.append(_insight("peak_window", "info",
                                     f"{what} der letzten 7 Tage wurde am {WEEKDAYS[dt.weekday()]} ({dt.day}.{dt.month}.) "
                                     f"zwischen {dt.hour} und {end_h} Uhr gemessen ({fmt_val(val, unit)}).",
                                     {"ts": ts, "value": val}, False))
            stats["peak_window"] = {"ts": ts, "value": val, "hours": 2}
        profile = _hour_profile(hourly["ts"], hourly["values"], tz)
        stats["hour_profile"] = profile
        weekday = _weekday_profile(daily["ts"], values, cov, tz)
        stats["weekday_profile"] = weekday
        valid = [(i, v) for i, v in enumerate(weekday) if v is not None]
        if len(valid) == 7:
            hi = max(valid, key=lambda x: x[1])
            lo = min(valid, key=lambda x: x[1])
            if hi[1] > 0 and lo[1] >= 0 and hi[1] != lo[1]:
                insights.append(_insight("weekday", "info",
                                         f"Im Wochenverlauf ist {WEEKDAYS[hi[0]]} der stärkste Tag (Ø {fmt_val(hi[1], unit)}), "
                                         f"{WEEKDAYS[lo[0]]} der schwächste (Ø {fmt_val(lo[1], unit)}).",
                                         {"weekday": weekday}, False))

        # --- completeness warning
        incomplete_days = len([c for c in cov[:-1] if c is not None and 0 < c < MIN_COVERAGE])
        missing_days = len([v for v in values[:-1] if v is None])
        if incomplete_days or missing_days:
            insights.append(_insight("completeness", "warning",
                                     f"Datenlage: {missing_days} Tag(e) ohne Daten und {incomplete_days} unvollständige Tag(e) "
                                     f"im Analysezeitraum – diese wurden bei Extremwerten und Trends nicht berücksichtigt.",
                                     {"missing": missing_days, "incomplete": incomplete_days}, False))
        return {
            "source": source, "name": name, "unit": unit, "generated_at": now, "timezone": self.engine.tz_name(),
            "comparisons": comparisons, "stats": stats, "insights": insights,
            "daily": {"ts": daily["ts"], "values": values, "coverage": cov},
        }

    async def overview(self, sources: list[dict], now: float | None = None) -> list[dict]:
        out = []
        for src in sources:
            try:
                res = await self.analyze(src, days=60, now=now)
                out.append({"source": src, "name": res["name"], "unit": res["unit"], "insights": res["insights"]})
            except Exception as err:  # noqa: BLE001
                out.append({"source": src, "error": str(err), "insights": []})
        return out


def _insight(iid: str, severity: str, text: str, data: Any, incomplete: bool) -> dict:
    if incomplete:
        text += " Hinweis: Datenbasis unvollständig."
    return {"id": iid, "severity": severity, "text": text, "data": data, "incomplete": incomplete}


def _date_de(ts: float, tz) -> str:
    dt = datetime.fromtimestamp(ts, tz)
    return f"{WEEKDAYS[dt.weekday()]}, {dt.day}. {MONTHS[dt.month - 1]} {dt.year}"


def _anomalies(days: list[tuple[int, float]], window: int = 28, threshold: float = 2.5,
               min_rel: float = 0.15) -> list[tuple[int, float, float]]:
    out = []
    for i in range(7, len(days)):
        hist = [v for _, v in days[max(0, i - window): i]]
        if len(hist) < 7:
            continue
        mean = sum(hist) / len(hist)
        var = sum((v - mean) ** 2 for v in hist) / (len(hist) - 1)
        sd = math.sqrt(var)
        if sd <= 1e-9:
            continue
        z = (days[i][1] - mean) / sd
        rel = abs(days[i][1] - mean) / abs(mean) if mean else 1.0
        if abs(z) >= threshold and rel >= min_rel:
            out.append((days[i][0], days[i][1], z))
    return out


def _peak_window(ts: list[int], values: list[float | None], width: int, mean_like: bool) -> tuple[int, float] | None:
    best: tuple[int, float] | None = None
    for i in range(0, len(values) - width + 1):
        win = values[i: i + width]
        if any(v is None for v in win):
            continue
        val = sum(win) / width if mean_like else sum(win)
        if best is None or val > best[1]:
            best = (ts[i], val)
    if best is not None and best[1] <= 0 and not mean_like:
        return None
    return best


def _hour_profile(ts: list[int], values: list[float | None], tz) -> list[float | None]:
    sums = [0.0] * 24
    counts = [0] * 24
    for t, v in zip(ts, values):
        if v is None:
            continue
        h = datetime.fromtimestamp(t, tz).hour
        sums[h] += v
        counts[h] += 1
    return [sums[h] / counts[h] if counts[h] else None for h in range(24)]


def _weekday_profile(ts: list[int], values: list[float | None], cov: list, tz) -> list[float | None]:
    sums = [0.0] * 7
    counts = [0] * 7
    for t, v, c in zip(ts[:-1], values[:-1], cov[:-1]):
        if v is None or (c is not None and c < MIN_COVERAGE):
            continue
        d = datetime.fromtimestamp(t, tz).weekday()
        sums[d] += v
        counts[d] += 1
    return [sums[d] / counts[d] if counts[d] else None for d in range(7)]
