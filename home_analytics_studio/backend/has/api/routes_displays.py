"""Remote displays: register (TV), pair, push dashboards."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..core.auth import Principal, RateLimiter
import asyncio

from ..core import tv_launch
from .deps import admin, client_ip, current_principal, editor, services, viewer

router = APIRouter(prefix="/api/displays", tags=["displays"])
_register_limit = RateLimiter(limit=10, window=600)


class PairBody(BaseModel):
    code: str
    name: str
    dashboard_id: int | None = None


class ShowBody(BaseModel):
    dashboard_id: int | None = None
    page_id: int | None = None
    present: bool = True


class PatchBody(BaseModel):
    name: str | None = None


class TvBody(BaseModel):
    name: str
    tv_entity: str


class LinkBody(BaseModel):
    tv_entity: str | None = None


def _start_launch(svc, display_id: int) -> bool:
    """Start the TV launch in the background (one at a time per display)."""
    tasks = svc.__dict__.setdefault("_tv_tasks", {})
    t = tasks.get(display_id)
    if t is not None and not t.done():
        return True
    tasks[display_id] = asyncio.create_task(tv_launch.launch(svc, display_id))
    return True


def _tv_ready(svc, display_id: int) -> bool:
    tv_entity, _ = svc.displays.launch_info(display_id)
    return bool(tv_entity) and bool(svc.settings.get("displays", "tv_control_enabled", False))


def _user(principal: Principal) -> Principal:
    if principal.kind not in ("login", "ingress"):
        raise HTTPException(403, "Nur für angemeldete Benutzer")
    return principal


@router.post("/register")
async def register(request: Request, body: dict | None = None) -> dict:
    """Anonymous: a TV/tablet asks for a pairing code. It gets no data access until paired."""
    if request.headers.get("x-requested-with") != "has":
        raise HTTPException(403, "Ungültige Anfrage")
    svc = services(request)
    if not _register_limit.allow(client_ip(request, svc)):
        raise HTTPException(429, "Zu viele Anfragen")
    try:
        return svc.displays.register(request.headers.get("user-agent"), (body or {}).get("screen"))
    except RuntimeError as err:
        raise HTTPException(429, str(err)) from err


@router.get("/me")
async def me(request: Request, principal: Principal = Depends(current_principal)) -> dict:
    if principal.kind != "display":
        raise HTTPException(400, "Kein Bildschirm")
    svc = services(request)
    d = svc.displays.get(principal.display_id)
    if not d:
        raise HTTPException(404, "Bildschirm nicht gefunden")
    return {**d, "code": None if d["paired"] else svc.displays.pair_code(principal.display_id)}


@router.get("")
async def list_displays(request: Request, principal: Principal = Depends(viewer)) -> list[dict]:
    _user(principal)
    svc = services(request)
    online = svc.live.online_displays()
    return [{**d, "online": d["id"] in online} for d in svc.displays.list()]


@router.post("/pair")
async def pair(body: PairBody, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    try:
        d = svc.displays.pair(body.code, body.name, body.dashboard_id)
    except KeyError as err:
        raise HTTPException(404, str(err)) from err
    svc.live.send_display(d["id"], {"type": "display_paired", "display": d})
    return d


@router.post("/{display_id}/show")
async def show(display_id: int, body: ShowBody, request: Request, principal: Principal = Depends(viewer)) -> dict:
    _user(principal)
    svc = services(request)
    try:
        cur = svc.displays.show(display_id, body.dashboard_id, body.page_id, body.present)
    except KeyError as err:
        raise HTTPException(404, str(err)) from err
    receivers = svc.live.send_display(display_id, {"type": "display_show", "current": cur})
    launching = False
    if receivers == 0 and _tv_ready(svc, display_id):
        # linked TV is off / browser closed: turn it on and open the dashboard (opt-in feature)
        launching = _start_launch(svc, display_id)
    return {"current": cur, "delivered": receivers > 0, "launching": launching}


@router.post("/{display_id}/launch")
async def launch(display_id: int, request: Request, principal: Principal = Depends(viewer)) -> dict:
    _user(principal)
    svc = services(request)
    if not _tv_ready(svc, display_id):
        raise HTTPException(400, "Fernseher-Steuerung nicht aktiviert oder Bildschirm mit keinem Fernseher verknüpft")
    return {"launching": _start_launch(svc, display_id)}


@router.get("/tv/candidates")
async def tv_candidates(request: Request, _: Principal = Depends(admin)) -> dict:
    """media_player entities that can open apps/URLs (TVs), plus the URL the TV would open."""
    svc = services(request)
    linked = {d.get("tv_entity") for d in svc.displays.list()}
    out = []
    for eid, st in svc.ha.states.items():
        if not eid.startswith("media_player."):
            continue
        a = st.get("attributes") or {}
        if a.get("device_class") == "tv" or "can_launch_apps" in a:
            out.append({"entity_id": eid, "name": a.get("friendly_name") or eid, "state": st.get("state"),
                        "can_launch_apps": bool(a.get("can_launch_apps")), "can_power_on": bool(a.get("can_power_on")),
                        "linked": eid in linked})
    out.sort(key=lambda x: (not x["can_launch_apps"], x["name"]))
    return {"candidates": out, "tv_url": tv_launch.tv_base_url(svc),
            "enabled": bool(svc.settings.get("displays", "tv_control_enabled", False))}


@router.post("/tv")
async def add_tv(body: TvBody, request: Request, _: Principal = Depends(admin)) -> dict:
    svc = services(request)
    if not body.tv_entity.startswith("media_player.") or body.tv_entity not in svc.ha.states:
        raise HTTPException(400, "Unbekannter Fernseher")
    try:
        return svc.displays.add_tv(body.name, body.tv_entity)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err


@router.put("/{display_id}/tv")
async def link_tv(display_id: int, body: LinkBody, request: Request, _: Principal = Depends(admin)) -> dict:
    svc = services(request)
    if body.tv_entity and (not body.tv_entity.startswith("media_player.") or body.tv_entity not in svc.ha.states):
        raise HTTPException(400, "Unbekannter Fernseher")
    svc.displays.link_tv(display_id, body.tv_entity)
    svc.live.send_display(display_id, {"type": "display_unpaired"}) if body.tv_entity else None
    return {"ok": True}


@router.post("/{display_id}/identify")
async def identify(display_id: int, request: Request, principal: Principal = Depends(viewer)) -> dict:
    _user(principal)
    svc = services(request)
    d = svc.displays.get(display_id)
    if not d:
        raise HTTPException(404, "Bildschirm nicht gefunden")
    return {"delivered": svc.live.send_display(display_id, {"type": "display_identify", "name": d["name"]}) > 0}


@router.post("/{display_id}/reload")
async def reload(display_id: int, request: Request, _: Principal = Depends(editor)) -> dict:
    return {"delivered": services(request).live.send_display(display_id, {"type": "display_reload"}) > 0}


@router.patch("/{display_id}")
async def patch(display_id: int, body: PatchBody, request: Request, _: Principal = Depends(editor)) -> dict:
    services(request).displays.update(display_id, body.name)
    return {"ok": True}


@router.delete("/{display_id}")
async def delete(display_id: int, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    svc.live.send_display(display_id, {"type": "display_unpaired"})
    svc.displays.delete(display_id)
    return {"ok": True}
