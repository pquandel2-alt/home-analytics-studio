"""Remote displays: register (TV), pair, push dashboards."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..core.auth import Principal, RateLimiter
from .deps import client_ip, current_principal, editor, services, viewer

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
    return {"current": cur, "delivered": receivers > 0}


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
