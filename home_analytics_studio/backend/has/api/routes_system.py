from __future__ import annotations

import asyncio
import json
import os
import platform
import re
import secrets
import sys
import time

import aiohttp
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import text

from ..core.auth import Principal
from ..core.backup import BackupError, export_config
from ..core.timeutil import resolve_range
from ..ha.client import build_ws_url
from ..ha.importer import import_history, import_statistics
from ..services import LOG_BUFFER
from .deps import admin, editor, services, share_read, viewer

router = APIRouter(prefix="/api", tags=["system"])

UPLOAD_RE = re.compile(r"^[a-f0-9]{16}\.(png|jpe?g|webp|gif|svg)$")
MAX_UPLOAD = 10 * 1024 * 1024
MAX_BACKUP_UPLOAD = 2 * 1024 * 1024 * 1024


# ---------------------------------------------------------------- settings


@router.get("/settings")
async def get_settings(request: Request, _: Principal = Depends(admin)) -> dict:
    return services(request).settings.all(mask_secrets=True)


@router.put("/settings/{section}")
async def put_settings(section: str, body: dict, request: Request, principal: Principal = Depends(admin)) -> dict:
    svc = services(request)
    try:
        svc.settings.update(section, body)
    except KeyError as err:
        raise HTTPException(400, str(err)) from err
    except (TypeError, ValueError) as err:
        raise HTTPException(400, f"Ungültiger Wert: {err}") from err
    if section == "homeassistant":
        await svc.ha.reconnect()
    _audit(svc, principal, f"settings.{section}")
    return svc.settings.all(mask_secrets=True)[section]


@router.get("/appearance")
async def appearance(request: Request, _: Principal = Depends(share_read)) -> dict:
    svc = services(request)
    return {"appearance": svc.settings.get("appearance"), "general": {
        k: svc.settings.get("general", k) for k in ("instance_name", "currency", "language", "default_dashboard")},
        "timezone": svc.engine.tz_name(), "presentation": svc.settings.get("presentation"),
        "base_url": svc.config.base_url}


def _audit(svc, principal: Principal, action: str, detail: str | None = None) -> None:
    with svc.db.write() as conn:
        conn.execute(text("INSERT INTO audit_log(ts, user, action, detail) VALUES (:t, :u, :a, :d)"),
                     {"t": time.time(), "u": principal.username, "a": action, "d": detail})


# ---------------------------------------------------------------- Home Assistant


@router.get("/ha/status")
async def ha_status(request: Request, _: Principal = Depends(viewer)) -> dict:
    svc = services(request)
    return {**svc.ha.status.as_dict(), "entity_count": len(svc.ha.states),
            "location_name": svc.ha.config.get("location_name"), "time_zone": svc.ha.config.get("time_zone"),
            "unit_system": svc.ha.config.get("unit_system"), "supervisor": svc.config.in_supervisor}


@router.post("/ha/reconnect")
async def ha_reconnect(request: Request, _: Principal = Depends(admin)) -> dict:
    await services(request).ha.reconnect()
    return {"ok": True}


@router.post("/ha/test")
async def ha_test(body: dict, request: Request, _: Principal = Depends(admin)) -> dict:
    """Test URL + token without changing the active connection."""
    svc = services(request)
    url = body.get("url") or ""
    token = body.get("token") or ""
    if token == "********":
        token = svc.settings.get("homeassistant", "token") or ""
    if not url or not token:
        raise HTTPException(400, "URL und Token erforderlich")
    try:
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(build_ws_url(url), timeout=aiohttp.ClientWSTimeout(ws_close=10),
                                          ssl=None if body.get("verify_ssl", True) else False) as ws:
                hello = await asyncio.wait_for(ws.receive_json(), 10)
                await ws.send_json({"type": "auth", "access_token": token})
                res = await asyncio.wait_for(ws.receive_json(), 10)
        if res.get("type") == "auth_ok":
            return {"ok": True, "ha_version": res.get("ha_version") or hello.get("ha_version")}
        return {"ok": False, "error": res.get("message") or "Authentifizierung fehlgeschlagen"}
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "error": f"{type(err).__name__}: {err}"}


# ---------------------------------------------------------------- system


@router.get("/system/info")
async def system_info(request: Request, _: Principal = Depends(viewer)) -> dict:
    svc = services(request)
    disk = await asyncio.to_thread(svc.store.check_disk)
    with svc.db.read() as conn:
        counts = {t: conn.execute(text(f"SELECT COUNT(*) FROM {t}")).scalar() for t in
                  ("entities", "dashboards", "pages", "metrics", "constants", "users")}
        counts["recorded_entities"] = conn.execute(text("SELECT COUNT(*) FROM entities WHERE recorded=1")).scalar()
        counts["samples"] = conn.execute(text("SELECT COALESCE(SUM(sample_count),0) FROM entities")).scalar()
    return {**svc.info(), "python": sys.version.split()[0], "platform": platform.platform(),
            "arch": platform.machine(), "disk": disk, "counts": counts, "uptime": time.time() - svc.started_at,
            "recorder": {**svc.store.stats, "pending": svc.store.pending(), "paused": svc.store.paused_reason},
            "maintenance": svc.recorder.maintenance, "ha": svc.ha.status.as_dict()}


@router.get("/system/diagnostics")
async def diagnostics(request: Request, _: Principal = Depends(admin)) -> dict:
    svc = services(request)
    checks = []
    checks.append({"name": "Home Assistant", "ok": svc.ha.connected, "detail": svc.ha.status.error or svc.ha.status.state})
    integrity = await asyncio.to_thread(svc.db.integrity_check, True)
    checks.append({"name": "Datenbank-Integrität (quick_check)", "ok": integrity == ["ok"], "detail": "; ".join(integrity[:3])})
    disk = await asyncio.to_thread(svc.store.check_disk)
    checks.append({"name": "Speicherplatz", "ok": disk["paused"] is None,
                   "detail": f"{disk['free'] / 1024 / 1024:.0f} MB frei, DB {disk['db_mb']:.1f} MB"})
    with svc.db.read() as conn:
        jm = conn.execute(text("PRAGMA journal_mode")).scalar()
    checks.append({"name": "WAL-Modus", "ok": str(jm).lower() == "wal", "detail": jm})
    checks.append({"name": "Aufzeichnungspuffer", "ok": svc.store.pending() < 10000, "detail": f"{svc.store.pending()} ausstehend"})
    lag = []
    now = time.time()
    for e in svc.store.recorded_entities():
        if e.rolled_5m and now - e.rolled_5m > 3600:
            lag.append(e.entity_id)
    checks.append({"name": "Verdichtung aktuell", "ok": not lag, "detail": ", ".join(lag[:5]) or "ok"})
    jobs = [j for j in svc.jobs.list(20) if j["status"] == "failed"]
    checks.append({"name": "Hintergrundaufgaben", "ok": not jobs, "detail": f"{len(jobs)} fehlgeschlagen" if jobs else "ok"})
    return {"checks": checks, "logs": list(LOG_BUFFER.records)[-300:]}


@router.post("/system/maintenance")
async def maintenance(request: Request, _: Principal = Depends(admin)) -> dict:
    svc = services(request)
    await asyncio.to_thread(svc.store.flush)
    await asyncio.to_thread(svc.store.rollup)
    return await svc.recorder.run_maintenance(daily=True)


@router.post("/system/vacuum")
async def vacuum(request: Request, _: Principal = Depends(admin)) -> dict:
    svc = services(request)
    before = svc.db.size_info()
    await asyncio.to_thread(svc.db.vacuum)
    return {"before": before, "after": svc.db.size_info()}


@router.post("/system/rebuild-rollups")
async def rebuild_rollups(request: Request, _: Principal = Depends(admin)) -> dict:
    svc = services(request)

    async def job(handle):
        ents = svc.store.recorded_entities()
        for i, e in enumerate(ents):
            def reset(ent=e):
                with svc.db.write() as conn:
                    conn.execute(text("UPDATE entities SET rolled_5m=NULL, rolled_1h=NULL WHERE id=:e"), {"e": ent.id})
                    svc.store._reset_rollups(conn, ent.id)
                svc.store.rollup(None, [ent.entity_id])
            await asyncio.to_thread(reset)
            handle.progress((i + 1) / max(1, len(ents)), e.entity_id)
        return {"entities": len(ents)}

    return {"job_id": svc.jobs.start("rebuild", {}, job)}


@router.get("/system/audit")
async def audit(request: Request, _: Principal = Depends(admin)) -> list[dict]:
    with services(request).db.read() as conn:
        return [dict(r) for r in conn.execute(text("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200")).mappings()]


# ---------------------------------------------------------------- jobs & import


@router.get("/jobs")
async def list_jobs(request: Request, _: Principal = Depends(viewer)) -> list[dict]:
    return services(request).jobs.list()


@router.get("/jobs/{job_id}")
async def get_job(job_id: int, request: Request, _: Principal = Depends(viewer)) -> dict:
    job = services(request).jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Job nicht gefunden")
    return job


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: int, request: Request, _: Principal = Depends(editor)) -> dict:
    return {"ok": services(request).jobs.cancel(job_id)}


@router.post("/import/{kind}")
async def start_import(kind: str, body: dict, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    if kind not in ("history", "statistics"):
        raise HTTPException(404, "Unbekannter Import")
    if not svc.ha.connected:
        raise HTTPException(409, "Keine Verbindung zu Home Assistant")
    ids = [e for e in body.get("entity_ids") or [] if isinstance(e, str)]
    if not ids:
        raise HTTPException(400, "Keine Entitäten gewählt")
    start, end = resolve_range(body.get("range") or {"last": "10d"}, svc.engine.tz())
    if body.get("record", True):
        attrs = {e: (svc.ha.states.get(e) or {}).get("attributes") or {} for e in ids}
        await asyncio.to_thread(svc.store.set_recording, ids, True, attrs)

    async def job(handle):
        if kind == "history":
            return await import_history(svc.ha, svc.store, ids, start, end, handle)
        return await import_statistics(svc.ha, svc.store, ids, start, end, handle)

    return {"job_id": svc.jobs.start(f"import_{kind}", {"entity_ids": ids, "start": start, "end": end}, job)}


# ---------------------------------------------------------------- backups


@router.get("/backups")
async def list_backups(request: Request, _: Principal = Depends(admin)) -> list[dict]:
    return await asyncio.to_thread(services(request).backups.list)


@router.post("/backups")
async def create_backup(body: dict, request: Request, principal: Principal = Depends(admin)) -> dict:
    svc = services(request)
    await asyncio.to_thread(svc.store.flush)
    res = await asyncio.to_thread(svc.backups.create, bool(body.get("include_data", True)), "manual", body.get("label"))
    _audit(svc, principal, "backup.create", res["name"])
    return res


@router.get("/backups/{name}/download")
async def download_backup(name: str, request: Request, _: Principal = Depends(admin)) -> FileResponse:
    try:
        path = services(request).backups.path_for(name)
    except (BackupError, FileNotFoundError) as err:
        raise HTTPException(404, str(err)) from err
    return FileResponse(path, filename=name, media_type="application/zip")


@router.post("/backups/upload")
async def upload_backup(request: Request, file: UploadFile = File(...), _: Principal = Depends(admin)) -> dict:
    svc = services(request)
    data = await file.read(MAX_BACKUP_UPLOAD + 1)
    if len(data) > MAX_BACKUP_UPLOAD:
        raise HTTPException(413, "Datei zu groß")
    name = svc.backups.save_upload(file.filename or "upload.zip", data)
    check = await asyncio.to_thread(svc.backups.verify, svc.backups.path_for(name))
    if not check["ok"]:
        svc.backups.delete(name)
        raise HTTPException(400, "Ungültige Sicherung: " + "; ".join(check["errors"]))
    return {"name": name, "verify": check}


@router.post("/backups/{name}/verify")
async def verify_backup(name: str, request: Request, _: Principal = Depends(admin)) -> dict:
    svc = services(request)
    try:
        return await asyncio.to_thread(svc.backups.verify, svc.backups.path_for(name))
    except (BackupError, FileNotFoundError) as err:
        raise HTTPException(404, str(err)) from err


@router.post("/backups/{name}/restore")
async def restore_backup(name: str, body: dict, request: Request, principal: Principal = Depends(admin)) -> dict:
    svc = services(request)
    try:
        res = await asyncio.to_thread(svc.backups.restore, name, body.get("mode", "full"))
    except FileNotFoundError as err:
        raise HTTPException(404, "Sicherung nicht gefunden") from err
    except BackupError as err:
        raise HTTPException(400, str(err)) from err
    _audit(svc, principal, "backup.restore", f"{name} ({res['mode']})")
    return res


@router.delete("/backups/{name}")
async def delete_backup(name: str, request: Request, _: Principal = Depends(admin)) -> dict:
    try:
        services(request).backups.delete(name)
    except (BackupError, FileNotFoundError) as err:
        raise HTTPException(404, str(err)) from err
    return {"ok": True}


@router.get("/export/config")
async def export_config_json(request: Request, _: Principal = Depends(admin)) -> Response:
    data = await asyncio.to_thread(export_config, services(request).db)
    for item in data.get("settings", {}).values():
        if isinstance(item, dict):
            for k in ("token", "openai_api_key"):
                if item.get(k):
                    item[k] = "********"
    return Response(json.dumps(data, ensure_ascii=False, indent=1, default=str), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="has-config-{time.strftime("%Y%m%d")}.json"'})


# ---------------------------------------------------------------- uploads (background images ...)


@router.post("/uploads")
async def upload_image(request: Request, file: UploadFile = File(...), _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    ext = (os.path.splitext(file.filename or "")[1] or "").lower().lstrip(".")
    if ext not in ("png", "jpg", "jpeg", "webp", "gif", "svg"):
        raise HTTPException(400, "Nur Bilder (png, jpg, webp, gif, svg)")
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "Bild zu groß (max. 10 MB)")
    if ext == "svg" and (b"<script" in data.lower() or b"javascript:" in data.lower()):
        raise HTTPException(400, "SVG mit Skripten ist nicht erlaubt")
    name = f"{secrets.token_hex(8)}.{ext}"
    (svc.config.upload_dir / name).write_bytes(data)
    return {"name": name, "url": f"api/uploads/{name}"}


@router.get("/uploads")
async def list_uploads(request: Request, _: Principal = Depends(editor)) -> list[dict]:
    d = services(request).config.upload_dir
    return [{"name": p.name, "url": f"api/uploads/{p.name}", "size": p.stat().st_size}
            for p in sorted(d.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True) if UPLOAD_RE.match(p.name)]


@router.get("/uploads/{name}")
async def get_upload(name: str, request: Request) -> FileResponse:
    # images are referenced from dashboards incl. read-only presentations; names are random
    if not UPLOAD_RE.match(name):
        raise HTTPException(404, "Nicht gefunden")
    path = services(request).config.upload_dir / name
    if not path.exists():
        raise HTTPException(404, "Nicht gefunden")
    headers = {"Cache-Control": "public, max-age=86400", "Content-Security-Policy": "script-src 'none'"}
    return FileResponse(path, headers=headers)


@router.delete("/uploads/{name}")
async def delete_upload(name: str, request: Request, _: Principal = Depends(editor)) -> dict:
    if not UPLOAD_RE.match(name):
        raise HTTPException(404, "Nicht gefunden")
    p = services(request).config.upload_dir / name
    if p.exists():
        p.unlink()
    return {"ok": True}
