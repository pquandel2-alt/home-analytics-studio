from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..core.auth import Principal
from ..core.store import detect_kind, parse_state_value
from ..core import units
from ..ha import virtual
from ..ha.importer import import_history, import_statistics
from ..live import slim_state
from .deps import admin, editor, services, share_read, viewer

router = APIRouter(prefix="/api", tags=["entities"])


class RecordBody(BaseModel):
    entity_ids: list[str]
    recorded: bool


class EntityPatch(BaseModel):
    kind: str | None = None
    retention_days: int | None = -1
    unit: str | None = None
    notes: str | None = None
    max_rate: float | None = -1


def _entity_rows(svc) -> list[dict]:
    states = svc.ha.states
    storage = svc.store.storage_by_entity()
    reg = svc.ha.registry
    rows: dict[str, dict] = {}
    for eid, st in states.items():
        attrs = st.get("attributes") or {}
        area, device = svc.ha.area_of(eid)
        unit = attrs.get("unit_of_measurement")
        value = parse_state_value(st.get("state"))
        rows[eid] = {
            "entity_id": eid,
            "domain": eid.split(".", 1)[0],
            "name": attrs.get("friendly_name") or eid,
            "state": st.get("state"),
            "numeric": value is not None and st.get("state") not in ("on", "off"),
            "available": st.get("state") not in ("unavailable", "unknown", None),
            "unit": unit,
            "device_class": attrs.get("device_class"),
            "state_class": attrs.get("state_class"),
            "icon": attrs.get("icon"),
            "area": area,
            "device": device,
            "last_changed": st.get("last_changed"),
            "kind_auto": detect_kind(attrs.get("state_class"), attrs.get("device_class"), unit),
            "in_ha": True,
            "hidden": bool((reg.entities.get(eid) or {}).get("hidden_by")),
            "recorded": False, "kind": "auto", "samples": 0, "bytes": 0, "last_ts": None, "last_value": None,
            "stored_unit": units.canonical_unit(unit), "retention_days": None,
        }
    # virtual attribute series (thermostat set point / heating share)
    for base in [e for e in list(rows) if virtual.virtual_ids(e)]:
        for vid in virtual.virtual_ids(base):
            st = svc.ha.state_of(vid)
            if st is None:
                continue
            a = st["attributes"]
            row = dict(rows[base])
            row.update({
                "entity_id": vid, "name": a["friendly_name"], "state": st["state"],
                "numeric": st["state"] not in ("unavailable", "unknown"), "available": st["state"] != "unavailable",
                "unit": a["unit_of_measurement"], "device_class": a.get("device_class"), "state_class": "measurement",
                "kind_auto": "measurement", "stored_unit": a["unit_of_measurement"], "virtual": True,
            })
            rows[vid] = row
    for info in svc.store.known_entities():
        row = rows.get(info.entity_id)
        if row is None:
            row = rows[info.entity_id] = {
                "entity_id": info.entity_id, "domain": info.entity_id.split(".", 1)[0], "name": info.name or info.entity_id,
                "state": None, "numeric": True, "available": False, "unit": info.source_unit, "device_class": None,
                "state_class": None, "icon": None, "area": None, "device": None, "last_changed": None,
                "kind_auto": info.kind, "in_ha": False, "hidden": False,
            }
        st = storage.get(info.id, {})
        row.update({
            "recorded": info.recorded, "kind": info.kind, "samples": st.get("samples", 0), "bytes": st.get("bytes", 0),
            "rows_1h": st.get("rows_1h", 0), "last_ts": info.last_ts, "last_value": info.last_value,
            "stored_unit": info.unit, "retention_days": info.retention_days, "max_rate": info.max_rate,
        })
    return sorted(rows.values(), key=lambda r: (not r["recorded"], r["entity_id"]))


@router.get("/entities")
async def list_entities(request: Request, search: str | None = None, domain: str | None = None,
                        area: str | None = None, recorded: bool | None = None, numeric: bool | None = None,
                        device_class: str | None = None, _: Principal = Depends(viewer)) -> dict:
    svc = services(request)
    rows = await asyncio.to_thread(_entity_rows, svc)
    if search:
        terms = search.lower().split()
        rows = [r for r in rows if all(t in f"{r['entity_id']} {r['name']} {r['area'] or ''} {r['device'] or ''}".lower()
                                       for t in terms)]
    if domain:
        rows = [r for r in rows if r["domain"] == domain]
    if area:
        rows = [r for r in rows if (r["area"] or "") == area]
    if recorded is not None:
        rows = [r for r in rows if r["recorded"] == recorded]
    if numeric is not None:
        rows = [r for r in rows if r["numeric"] == numeric]
    if device_class:
        rows = [r for r in rows if (r["device_class"] or "") == device_class]
    return {"entities": rows, "ha_connected": svc.ha.connected,
            "areas": sorted({a["name"] for a in svc.ha.registry.areas.values() if a.get("name")})}


@router.post("/entities/record")
async def set_recording(body: RecordBody, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    attrs = {e: (svc.ha.state_of(e) or {}).get("attributes") or {} for e in body.entity_ids}
    # entities without any stored data get their history imported from Home Assistant
    fresh = [e for e in body.entity_ids if (svc.store.get(e) is None or svc.store.get(e).last_ts is None)]
    n = await asyncio.to_thread(svc.store.set_recording, body.entity_ids, body.recorded, attrs)
    job_id = None
    if body.recorded and fresh and svc.ha.connected and svc.settings.get("storage", "auto_import_on_record", True):
        job_id = start_initial_import(svc, fresh)
    if body.recorded:
        now = time.time()
        for eid in body.entity_ids:
            area, device = svc.ha.area_of(eid)
            await asyncio.to_thread(svc.store.update_metadata, eid, attrs.get(eid) or {}, area, device)
            st = svc.ha.state_of(eid)
            if st:
                svc.store.add_state(eid, st.get("state"), st.get("attributes") or {}, now)
    else:
        # mark the end of recording so values are not carried forward
        for eid in body.entity_ids:
            info = svc.store.get(eid)
            if info is not None:
                await asyncio.to_thread(svc.store.insert_samples, info.id, [(int(time.time() * 1000), None)])
    return {"updated": n, "import_job": job_id}


def start_initial_import(svc, entity_ids: list[str]) -> int:
    """Background job: HA long-term statistics (hourly, long) + raw history (recent, exact)."""
    st = svc.settings.get("storage")
    now = time.time()
    stats_days = int(st.get("auto_import_statistics_days") or 0)
    hist_days = int(st.get("auto_import_history_days") or 0)

    async def job(handle):
        result = {}
        if stats_days > 0:
            result["statistics"] = await import_statistics(svc.ha, svc.store, entity_ids, now - stats_days * 86400, now)
        handle.progress(0.5, "Langzeitstatistiken importiert")
        if hist_days > 0:
            result["history"] = await import_history(svc.ha, svc.store, entity_ids, now - hist_days * 86400, now)
        return result

    return svc.jobs.start("initial_import", {"entity_ids": entity_ids, "statistics_days": stats_days,
                                             "history_days": hist_days}, job)


@router.get("/entities/{entity_id}")
async def get_entity(entity_id: str, request: Request, _: Principal = Depends(viewer)) -> dict:
    svc = services(request)
    rows = [r for r in await asyncio.to_thread(_entity_rows, svc) if r["entity_id"] == entity_id]
    if not rows:
        raise HTTPException(404, "Entität nicht gefunden")
    row = rows[0]
    info = svc.store.get(entity_id)
    if info:
        first, last = await asyncio.to_thread(svc.store.time_bounds, info)
        row["first_ts"], row["last_data_ts"] = first, last
    row["attributes"] = (svc.ha.state_of(entity_id) or {}).get("attributes")
    return row


@router.patch("/entities/{entity_id}")
async def patch_entity(entity_id: str, body: EntityPatch, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    try:
        info = await asyncio.to_thread(svc.store.configure, entity_id, body.kind, body.retention_days, body.unit, body.notes, body.max_rate)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    if body.kind is not None:
        await asyncio.to_thread(svc.store.rollup, None, [entity_id])
    return {"entity_id": info.entity_id, "kind": info.kind}


class SplitBody(BaseModel):
    at: float  # epoch seconds
    archive_name: str | None = None


@router.post("/entities/{entity_id}/split")
async def split_history(entity_id: str, body: SplitBody, request: Request, _: Principal = Depends(admin)) -> dict:
    """Device moved / replaced: move data before ``at`` into an archive series."""
    svc = services(request)
    await asyncio.to_thread(svc.store.flush)
    archive_id = f"{entity_id}::archiv_{time.strftime('%Y%m%d', time.localtime(body.at))}"
    try:
        return await asyncio.to_thread(svc.store.split_history, entity_id, body.at, archive_id, body.archive_name)
    except KeyError as err:
        raise HTTPException(404, str(err)) from err
    except ValueError as err:
        raise HTTPException(400, str(err)) from err


@router.delete("/entities/{entity_id}/data")
async def delete_data(entity_id: str, request: Request, forget: bool = False, _: Principal = Depends(admin)) -> dict:
    svc = services(request)
    await asyncio.to_thread(svc.store.delete_entity_data, entity_id, forget)
    return {"ok": True}


@router.get("/entities/{entity_id}/raw")
async def raw(entity_id: str, request: Request, start: float, end: float, limit: int = 5000,
              _: Principal = Depends(viewer)) -> dict:
    svc = services(request)
    info = svc.store.get(entity_id)
    if info is None:
        raise HTTPException(404, "Keine gespeicherten Daten")
    rows = await asyncio.to_thread(svc.store.raw_samples, info.id, int(start), int(end), min(limit, 100000))
    return {"entity_id": entity_id, "unit": info.unit, "samples": rows}


@router.post("/data/states")
async def states(body: dict, request: Request, _: Principal = Depends(share_read)) -> dict:
    svc = services(request)
    ids = body.get("entity_ids") or []
    return {"states": {e: slim_state(svc.ha.state_of(e)) for e in ids[:2000]}}
