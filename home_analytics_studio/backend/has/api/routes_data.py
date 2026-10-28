from __future__ import annotations

import asyncio
import csv
import io
import json
import re
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import text

from ..ai.export import SYSTEM_PROMPT, build_export, export_filename
from ..ai.providers import PROVIDERS, ProviderError, get_provider
from ..core import formula as fx
from ..core.auth import Principal
from ..core.engine import SourceError
from ..core.timeutil import iso_local
from .deps import editor, services, share_read, viewer

router = APIRouter(prefix="/api", tags=["data"])

KEY_RE = re.compile(r"^[a-z_][a-z0-9_]{0,63}$")


class SeriesBody(BaseModel):
    source: dict
    range: Any = "last_24h"
    interval: str | None = "auto"


class ScalarBody(BaseModel):
    source: dict
    range: Any = "today"


class BatchBody(BaseModel):
    requests: list[dict]


def _err(err: Exception) -> HTTPException:
    if isinstance(err, fx.FormulaError):
        return HTTPException(422, {"message": err.message, "pos": err.pos})
    return HTTPException(400, str(err))


async def _run_one(svc, req: dict) -> dict:
    try:
        if req.get("kind") == "scalar":
            return {"ok": True, "data": await svc.engine.scalar(req["source"], req.get("range", "today"))}
        if req.get("kind") == "analysis":
            return {"ok": True, "data": await svc.analysis.analyze(req["source"], int(req.get("days", 60)))}
        if req.get("kind") == "compare":
            return {"ok": True, "data": await svc.analysis.compare_periods(req["source"], req.get("period", "day"))}
        return {"ok": True, "data": await svc.engine.series(req["source"], req.get("range", "last_24h"),
                                                             req.get("interval", "auto"))}
    except (SourceError, fx.FormulaError, ValueError, KeyError) as err:
        return {"ok": False, "error": getattr(err, "message", None) or str(err)}


@router.post("/data/series")
async def series(body: SeriesBody, request: Request, _: Principal = Depends(share_read)) -> dict:
    try:
        return await services(request).engine.series(body.source, body.range, body.interval)
    except (SourceError, fx.FormulaError, ValueError) as err:
        raise _err(err) from err


@router.post("/data/scalar")
async def scalar(body: ScalarBody, request: Request, _: Principal = Depends(share_read)) -> dict:
    try:
        return await services(request).engine.scalar(body.source, body.range)
    except (SourceError, fx.FormulaError, ValueError) as err:
        raise _err(err) from err


@router.post("/data/batch")
async def batch(body: BatchBody, request: Request, _: Principal = Depends(share_read)) -> dict:
    svc = services(request)
    sem = asyncio.Semaphore(4)

    async def guarded(r: dict) -> dict:
        async with sem:
            return await _run_one(svc, r)

    results = await asyncio.gather(*(guarded(r) for r in body.requests[:200]))
    return {"results": results}


# ---------------------------------------------------------------- metrics


class MetricBody(BaseModel):
    name: str
    key: str
    formula: str
    description: str | None = None
    unit: str | None = None
    aggregation: str = "auto"
    decimals: int = 2
    color: str | None = None
    builder: dict | None = None


def _metric_row(r) -> dict:
    d = dict(r)
    if d.get("builder"):
        try:
            d["builder"] = json.loads(d["builder"])
        except ValueError:
            d["builder"] = None
    return d


@router.get("/metrics")
async def list_metrics(request: Request, _: Principal = Depends(share_read)) -> list[dict]:
    svc = services(request)
    with svc.db.read() as conn:
        rows = [_metric_row(r) for r in conn.execute(text("SELECT * FROM metrics ORDER BY name")).mappings()]
    formulas = {r["key"]: r["formula"] for r in rows}
    constants = svc.engine.constants()
    for r in rows:
        try:  # entities the metric depends on – lets widgets refresh as soon as one of them changes
            r["entities"] = sorted(fx.dependencies(r["formula"], formulas, constants)[0])
        except fx.FormulaError:
            r["entities"] = []
    return rows


@router.get("/metrics/functions")
async def functions(_: Principal = Depends(viewer)) -> list[dict]:
    return [{"name": k, "signature": v.signature, "description": v.description, "category": v.category}
            for k, v in fx.FUNCTIONS.items()]


@router.post("/metrics/validate")
async def validate(body: dict, request: Request, _: Principal = Depends(viewer)) -> dict:
    return services(request).engine.validate(body.get("formula", ""), body.get("key"))


@router.post("/metrics/preview")
async def preview(body: dict, request: Request, _: Principal = Depends(viewer)) -> dict:
    svc = services(request)
    v = svc.engine.validate(body.get("formula", ""), body.get("key"))
    if not v["ok"]:
        return {"validation": v}
    src = {"type": "formula", "formula": body["formula"], "unit": body.get("unit") or v.get("unit"),
           "aggregation": body.get("aggregation", "auto")}
    try:
        series = await svc.engine.series(src, body.get("range", "last_7d"), body.get("interval", "auto"))
        total = await svc.engine.scalar(src, body.get("range", "last_7d"))
    except (SourceError, fx.FormulaError, ValueError) as err:
        return {"validation": {"ok": False, "error": {"message": getattr(err, "message", str(err)), "pos": getattr(err, "pos", None)}}}
    return {"validation": v, "series": series, "total": total}


def _check_metric(svc, body: MetricBody, existing_key: str | None) -> None:
    if not KEY_RE.match(body.key):
        raise HTTPException(400, "Schlüssel: nur Kleinbuchstaben, Ziffern und _, beginnend mit Buchstabe")
    if not body.name.strip():
        raise HTTPException(400, "Name fehlt")
    if body.aggregation not in ("auto", "sum", "mean", "last", "min", "max"):
        raise HTTPException(400, "Ungültige Aggregation")
    with svc.db.read() as conn:
        if conn.execute(text("SELECT 1 FROM constants WHERE key=:k"), {"k": body.key}).first():
            raise HTTPException(400, "Schlüssel wird bereits von einer Konstante verwendet")
    v = svc.engine.validate(body.formula, body.key)
    if not v["ok"]:
        raise HTTPException(422, v["error"])


@router.post("/metrics")
async def create_metric(body: MetricBody, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    with svc.db.read() as conn:
        if conn.execute(text("SELECT 1 FROM metrics WHERE key=:k"), {"k": body.key}).first():
            raise HTTPException(400, "Schlüssel existiert bereits")
    _check_metric(svc, body, None)
    now = time.time()
    with svc.db.write() as conn:
        res = conn.execute(text(
            "INSERT INTO metrics(name, key, description, formula, unit, aggregation, decimals, color, builder, created_at, updated_at)"
            " VALUES (:name, :key, :description, :formula, :unit, :aggregation, :decimals, :color, :builder, :t, :t)"),
            {**body.model_dump(), "builder": json.dumps(body.builder) if body.builder else None, "t": now})
    return {"id": res.lastrowid, **body.model_dump()}


@router.put("/metrics/{metric_id}")
async def update_metric(metric_id: int, body: MetricBody, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    with svc.db.read() as conn:
        row = conn.execute(text("SELECT key FROM metrics WHERE id=:i"), {"i": metric_id}).first()
    if not row:
        raise HTTPException(404, "Kennzahl nicht gefunden")
    if body.key != row[0]:
        with svc.db.read() as conn:
            if conn.execute(text("SELECT 1 FROM metrics WHERE key=:k"), {"k": body.key}).first():
                raise HTTPException(400, "Schlüssel existiert bereits")
            users = [r[0] for r in conn.execute(text("SELECT key, formula FROM metrics WHERE id!=:i"), {"i": metric_id})
                     if row[0] in fx.analyze(fx.parse(r[1])).names]
        if users:
            raise HTTPException(400, f"Schlüssel wird von anderen Kennzahlen verwendet: {', '.join(users)}")
    _check_metric(svc, body, row[0])
    with svc.db.write() as conn:
        conn.execute(text(
            "UPDATE metrics SET name=:name, key=:key, description=:description, formula=:formula, unit=:unit,"
            " aggregation=:aggregation, decimals=:decimals, color=:color, builder=:builder, updated_at=:t WHERE id=:id"),
            {**body.model_dump(), "builder": json.dumps(body.builder) if body.builder else None, "t": time.time(), "id": metric_id})
    return {"id": metric_id, **body.model_dump()}


@router.delete("/metrics/{metric_id}")
async def delete_metric(metric_id: int, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    with svc.db.read() as conn:
        row = conn.execute(text("SELECT key FROM metrics WHERE id=:i"), {"i": metric_id}).first()
        if not row:
            raise HTTPException(404, "Kennzahl nicht gefunden")
        users = []
        for k, f in conn.execute(text("SELECT key, formula FROM metrics WHERE id!=:i"), {"i": metric_id}):
            try:
                if row[0] in fx.analyze(fx.parse(f)).names:
                    users.append(k)
            except fx.FormulaError:
                pass
    if users:
        raise HTTPException(400, f"Kennzahl wird noch verwendet von: {', '.join(users)}")
    with svc.db.write() as conn:
        conn.execute(text("DELETE FROM metrics WHERE id=:i"), {"i": metric_id})
    return {"ok": True}


# ---------------------------------------------------------------- constants


class ConstantBody(BaseModel):
    key: str
    name: str | None = None
    value: float
    unit: str | None = None
    description: str | None = None


@router.get("/constants")
async def list_constants(request: Request, _: Principal = Depends(viewer)) -> list[dict]:
    with services(request).db.read() as conn:
        return [dict(r) for r in conn.execute(text("SELECT * FROM constants ORDER BY key")).mappings()]


@router.post("/constants")
async def upsert_constant(body: ConstantBody, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    if not KEY_RE.match(body.key):
        raise HTTPException(400, "Schlüssel: nur Kleinbuchstaben, Ziffern und _, beginnend mit Buchstabe")
    with svc.db.write() as conn:
        if conn.execute(text("SELECT 1 FROM metrics WHERE key=:k"), {"k": body.key}).first():
            raise HTTPException(400, "Schlüssel wird bereits von einer Kennzahl verwendet")
        conn.execute(text("INSERT INTO constants(key, name, value, unit, description, updated_at) VALUES (:key, :name, :value, :unit, :description, :t)"
                          " ON CONFLICT(key) DO UPDATE SET name=excluded.name, value=excluded.value, unit=excluded.unit,"
                          " description=excluded.description, updated_at=excluded.updated_at"),
                     {**body.model_dump(), "t": time.time()})
    return body.model_dump()


@router.delete("/constants/{key}")
async def delete_constant(key: str, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    with svc.db.read() as conn:
        users = []
        for k, f in conn.execute(text("SELECT key, formula FROM metrics")):
            try:
                if key in fx.analyze(fx.parse(f)).names:
                    users.append(k)
            except fx.FormulaError:
                pass
    if users:
        raise HTTPException(400, f"Konstante wird verwendet von: {', '.join(users)}")
    with svc.db.write() as conn:
        conn.execute(text("DELETE FROM constants WHERE key=:k"), {"k": key})
    return {"ok": True}


# ---------------------------------------------------------------- analysis


@router.post("/analysis/run")
async def analysis_run(body: dict, request: Request, _: Principal = Depends(viewer)) -> dict:
    try:
        return await services(request).analysis.analyze(body["source"], int(body.get("days", 90)))
    except (SourceError, fx.FormulaError, ValueError, KeyError) as err:
        raise _err(err) from err


@router.post("/analysis/compare")
async def analysis_compare(body: dict, request: Request, _: Principal = Depends(viewer)) -> dict:
    try:
        return await services(request).analysis.compare_ranges(body["source"], body["a"], body["b"])
    except (SourceError, fx.FormulaError, ValueError, KeyError) as err:
        raise _err(err) from err


@router.post("/analysis/overview")
async def analysis_overview(body: dict, request: Request, _: Principal = Depends(viewer)) -> list[dict]:
    svc = services(request)
    sources = body.get("sources")
    if not sources:
        sources = [{"type": "entity", "id": e.entity_id} for e in svc.store.recorded_entities()][:20]
        sources += [{"type": "metric", "id": k} for k in list(svc.engine.metric_defs())[:20]]
    return await svc.analysis.overview(sources)


# ---------------------------------------------------------------- AI export


@router.get("/ai/providers")
async def ai_providers(request: Request, _: Principal = Depends(viewer)) -> dict:
    conf = services(request).settings.get("ai")
    active = get_provider(conf)
    return {"active": active.info().__dict__, "available": [{"id": k, "name": v.name, "direct": v.direct}
                                                            for k, v in PROVIDERS.items()],
            "chatgpt_url": conf.get("chatgpt_url")}


@router.post("/ai/export")
async def ai_export(body: dict, request: Request, _: Principal = Depends(viewer)) -> dict:
    svc = services(request)
    sources = body.get("sources") or []
    if not sources:
        raise HTTPException(400, "Bitte mindestens eine Datenquelle wählen")
    try:
        return await build_export(svc.engine, svc.analysis, sources[:30], body.get("range", "last_30d"),
                                  body.get("focus", "general"), body.get("question"), body.get("interval"),
                                  bool(body.get("include_series", True)))
    except (SourceError, ValueError) as err:
        raise _err(err) from err


@router.post("/ai/analyze")
async def ai_analyze(body: dict, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    provider = get_provider(svc.settings.get("ai"))
    if not provider.direct:
        raise HTTPException(400, "Kein direkter KI-Anbieter aktiviert (Einstellungen → KI)")
    try:
        answer = await provider.complete(SYSTEM_PROMPT, body.get("prompt", ""))
    except ProviderError as err:
        raise HTTPException(502, str(err)) from err
    return {"answer": answer, "provider": provider.id}


# ---------------------------------------------------------------- data export


@router.post("/export/series")
async def export_series(body: dict, request: Request, _: Principal = Depends(viewer)) -> Response:
    svc = services(request)
    fmt = body.get("format", "csv")
    sources = body.get("sources") or ([body["source"]] if body.get("source") else [])
    if not sources:
        raise HTTPException(400, "Keine Datenquelle")
    results = []
    for src in sources[:50]:
        try:
            results.append(await svc.engine.series(src, body.get("range", "last_30d"), body.get("interval", "1h")))
        except (SourceError, fx.FormulaError, ValueError) as err:
            raise _err(err) from err
    tz = svc.engine.tz()
    if fmt == "json":
        payload = [{"name": r["name"], "unit": r["unit"], "interval": r["interval"], "source": r["source"],
                    "points": [{"time": iso_local(t, tz), "value": v} for t, v in zip(r["ts"], r["values"])]} for r in results]
        return Response(json.dumps(payload, ensure_ascii=False, indent=1), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{export_filename("export", "json")}"'})
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=body.get("delimiter", ";"))
    writer.writerow(["time"] + [f"{r['name']} [{r['unit'] or ''}]" for r in results])
    for i, t in enumerate(results[0]["ts"]):
        row = [iso_local(t, tz)]
        for r in results:
            v = r["values"][i] if i < len(r["values"]) else None
            row.append("" if v is None else (f"{v:.6g}".replace(".", ",") if body.get("decimal_comma", True) else f"{v:.6g}"))
        writer.writerow(row)
    return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{export_filename("export", "csv")}"'})
