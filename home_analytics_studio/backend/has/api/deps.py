"""Request authentication & authorisation."""
from __future__ import annotations

from typing import Callable

from fastapi import Depends, HTTPException, Request, WebSocket

from ..core.auth import Principal
from ..services import Services

SESSION_COOKIE = "has_session"
MUTATING = {"POST", "PUT", "PATCH", "DELETE"}


def services(request: Request) -> Services:
    return request.app.state.services


def client_ip(conn: Request | WebSocket, svc: Services) -> str:
    if svc.config.trust_proxy_headers:
        fwd = conn.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return conn.client.host if conn.client else ""


def is_ingress(conn: Request | WebSocket, svc: Services) -> bool:
    """Request arrived on the ingress listener from the Supervisor gateway."""
    server = conn.scope.get("server") or (None, None)
    if server[1] != svc.config.ingress_port:
        return False
    peer = conn.client.host if conn.client else ""
    return peer in svc.config.ingress_trusted_ips


def resolve_principal(conn: Request | WebSocket, svc: Services) -> Principal | None:
    if is_ingress(conn, svc):
        return svc.auth.ensure_ingress_user(conn.headers.get("x-remote-user-id"),
                                            conn.headers.get("x-remote-user-name"),
                                            conn.headers.get("x-remote-user-display-name"))
    share = conn.headers.get("x-share-token") or conn.query_params.get("share")
    if share:
        return svc.auth.share_principal(share)
    token = conn.cookies.get(SESSION_COOKIE)
    if token:
        return svc.auth.session_principal(token)
    return None


async def current_principal(request: Request) -> Principal:
    svc = services(request)
    principal = getattr(request.state, "principal", None)
    if principal is None:
        principal = resolve_principal(request, svc)
        request.state.principal = principal
    if principal is None:
        raise HTTPException(401, "Anmeldung erforderlich")
    if request.method in MUTATING:
        # custom header forces a CORS preflight -> blocks cross-site form posts
        if request.headers.get("x-requested-with") != "has":
            raise HTTPException(403, "Ungültige Anfrage (CSRF-Schutz)")
        if principal.kind == "login" and request.headers.get("x-csrf-token") != principal.csrf:
            raise HTTPException(403, "CSRF-Token ungültig – bitte Seite neu laden")
        if principal.kind == "share" and "/api/data/" not in request.url.path:
            raise HTTPException(403, "Präsentationszugang ist schreibgeschützt")
    return principal


def require(role: str) -> Callable:
    async def dep(principal: Principal = Depends(current_principal)) -> Principal:
        if principal.kind == "share" and role != "viewer":
            raise HTTPException(403, "Präsentationszugang ist schreibgeschützt")
        if not principal.has(role):
            raise HTTPException(403, "Keine Berechtigung")
        return principal

    return dep


def share_read(principal: Principal = Depends(current_principal)) -> Principal:
    """Allows viewers and share links (data endpoints)."""
    return principal


viewer = require("viewer")
editor = require("editor")
admin = require("admin")
