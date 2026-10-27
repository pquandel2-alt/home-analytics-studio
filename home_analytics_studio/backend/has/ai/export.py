"""Builds a structured data package + analysis prompt for ChatGPT & co."""
from __future__ import annotations

import json
import time
from datetime import datetime
from typing import Any

from ..core.analysis import AnalysisEngine, fmt_val
from ..core.engine import DataEngine
from ..core.timeutil import auto_interval, iso_local, resolve_range

FOCUS_TEXT = {
    "general": "eine allgemeine Auswertung mit den wichtigsten Auffälligkeiten",
    "energy": "Energieverbrauch, Lastspitzen, Eigenverbrauch und Einsparpotenziale",
    "costs": "Kostenentwicklung und konkrete Sparmöglichkeiten",
    "climate": "Raumklima (Temperatur, Luftfeuchtigkeit, CO2) und Komfort/Lüftung",
    "anomalies": "ungewöhnliche Muster, Ausreißer und mögliche Defekte",
}

SYSTEM_PROMPT = ("Du bist ein sorgfältiger Datenanalyst für Smart-Home-Messdaten. Stütze jede Aussage auf die "
                 "gelieferten Zahlen, kennzeichne Unsicherheiten und erfinde keine Werte.")


async def build_export(engine: DataEngine, analysis: AnalysisEngine, sources: list[dict], range_spec: Any,
                       focus: str = "general", question: str | None = None, interval: str | None = None,
                       include_series: bool = True, max_points: int = 400) -> dict:
    tz = engine.tz()
    start, end = resolve_range(range_spec, tz)
    if not interval or interval == "auto":
        interval = auto_interval(start, end, target=min(max_points, 400))
    items = []
    for src in sources:
        item: dict[str, Any] = {"source": src}
        try:
            total = await engine.scalar(src, {"start": start, "end": end})
            item.update({"name": total.get("name"), "unit": total.get("unit"), "range_value": total.get("value"),
                         "coverage": total.get("coverage")})
            meta = engine.entity_meta(src["id"]) if src.get("type") == "entity" else None
            item["semantics"] = ("Verbrauch/Zählerdifferenz im Zeitraum" if meta and meta["kind"] != "measurement"
                                 else "zeitgewichteter Mittelwert" if meta else "berechnete Kennzahl")
            if include_series:
                s = await engine.series(src, {"start": start, "end": end}, interval)
                pts = [[iso_local(t, tz), None if v is None else round(v, 4)] for t, v in zip(s["ts"], s["values"])]
                item["series"] = {"interval": interval, "points": pts[-max_points:]}
            res = await analysis.analyze(src, days=min(365, max(7, int((end - start) / 86400) + 1)))
            item["insights"] = [i["text"] for i in res["insights"]]
            item["statistics"] = {k: v for k, v in res["stats"].items() if k not in ("hour_profile", "weekday_profile")}
            item["hour_profile"] = [None if v is None else round(v, 4) for v in res["stats"].get("hour_profile", [])]
            item["weekday_profile"] = [None if v is None else round(v, 4) for v in res["stats"].get("weekday_profile", [])]
        except Exception as err:  # noqa: BLE001
            item["error"] = str(err)
        items.append(item)

    package = {
        "generator": "Home Analytics Studio",
        "created_at": datetime.now(tz).isoformat(timespec="seconds"),
        "timezone": engine.tz_name(),
        "range": {"start": iso_local(start, tz), "end": iso_local(end, tz)},
        "focus": focus,
        "notes": [
            "Zähler/Energiemengen: Werte sind Verbrauch je Zeitabschnitt (resetbereinigt), keine Zählerstände.",
            "Momentanwerte: zeitgewichtete Mittelwerte je Zeitabschnitt.",
            "coverage = Anteil des Zeitraums mit gültigen Messwerten (1 = vollständig).",
        ],
        "items": items,
    }
    markdown = to_markdown(package)
    prompt = build_prompt(package, focus, question)
    return {"package": package, "markdown": markdown, "prompt": prompt, "system": SYSTEM_PROMPT,
            "size_bytes": len(prompt.encode())}


def to_markdown(package: dict) -> str:
    lines = [f"# Smart-Home-Datenauswertung", "",
             f"Zeitraum: {package['range']['start']} bis {package['range']['end']} ({package['timezone']})", ""]
    for it in package["items"]:
        if it.get("error"):
            lines += [f"## {it['source'].get('id')}", f"Fehler: {it['error']}", ""]
            continue
        lines.append(f"## {it.get('name')} ({it['source'].get('id')})")
        lines.append(f"- Wert im Zeitraum ({it.get('semantics')}): {fmt_val(it.get('range_value'), it.get('unit'))}")
        if it.get("coverage") is not None:
            lines.append(f"- Datenabdeckung: {round(it['coverage'] * 100)} %")
        for text in it.get("insights") or []:
            lines.append(f"- {text}")
        if it.get("series"):
            lines.append("")
            lines.append(f"Zeitreihe ({it['series']['interval']}), Format Zeitpunkt;Wert:")
            lines.append("```csv")
            lines.append("zeit;wert")
            for t, v in it["series"]["points"]:
                lines.append(f"{t};{'' if v is None else v}")
            lines.append("```")
        lines.append("")
    return "\n".join(lines)


def build_prompt(package: dict, focus: str, question: str | None) -> str:
    focus_text = FOCUS_TEXT.get(focus, FOCUS_TEXT["general"])
    task = [
        "Bitte analysiere die folgenden Messdaten aus meinem Smart Home.",
        f"Schwerpunkt: {focus_text}.",
    ]
    if question:
        task.append(f"Konkrete Frage: {question.strip()}")
    task += [
        "",
        "Vorgehen:",
        "1. Fasse die wichtigsten Kennzahlen und Entwicklungen zusammen.",
        "2. Nenne Auffälligkeiten (Spitzen, Trends, Ausreißer) mit Datum/Uhrzeit und Zahlenwert.",
        "3. Leite konkrete, umsetzbare Empfehlungen ab und schätze deren Wirkung, wo möglich.",
        "4. Weise auf Datenlücken (coverage < 1) und daraus folgende Unsicherheiten hin.",
        "Antworte auf Deutsch, strukturiert mit Überschriften und Aufzählungen.",
        "",
        "Die Daten (JSON):",
        "```json",
        json.dumps(package, ensure_ascii=False, separators=(",", ":")),
        "```",
    ]
    return "\n".join(task)


def export_filename(prefix: str, ext: str) -> str:
    return f"{prefix}-{time.strftime('%Y%m%d-%H%M')}.{ext}"
