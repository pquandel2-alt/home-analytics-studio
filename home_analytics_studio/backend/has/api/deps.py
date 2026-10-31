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


def bearer_token(conn: Request | WebSocket) -> str | None:
    """Token from `Authorization: Bearer <token>`; None if the header is absent or not a bearer one."""
    header = conn.headers.get("authorization") or ""
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return value.strip()


def resolve_principal(conn: Request | WebSocket, svc: Services) -> Principal | None:
    # an explicit bearer token is authoritative: it never falls back to ingress/cookie rights
    # (no implicit admin), and an invalid/expired/revoked one is simply unauthenticated -> 401
    bearer = bearer_token(conn)
    if bearer is not None:
        return svc.auth.api_token_principal(bearer)
    # explicit device tokens take precedence: a TV/presentation link always gets its
    # restricted read-only rights, even when it happens to come in via the ingress port
    display = conn.headers.get("x-display-token") or conn.query_params.get("display")
    if display:
        return svc.displays.principal(display)
    share = conn.headers.get("x-share-token") or conn.query_params.get("share")
    if share:
        return svc.auth.share_principal(share)
    if is_ingress(conn, svc):
        return svc.auth.ensure_ingress_user(conn.headers.get("x-remote-user-id"),
                                            conn.headers.get("x-remote-user-name"),
                                            conn.headers.get("x-remote-user-display-name"))
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
        raise HTTPException(401, "Anmeldung erforderlich", headers={"WWW-Authenticate": "Bearer"})
    if principal.kind == "display" and not getattr(principal, "display_paired", False) \
            and not request.url.path.endswith(("/api/displays/me", "/api/auth/status", "/api/appearance")):
        raise HTTPException(403, "Bildschirm ist noch nicht gekoppelt")
    if request.method in MUTATING and principal.kind != "api":
        # bearer tokens are not sent by browsers on their own -> no CSRF surface, no cookie/CSRF header needed
        # custom header forces a CORS preflight -> blocks cross-site form posts
        if request.headers.get("x-requested-with") != "has":
            raise HTTPException(403, "Ungültige Anfrage (CSRF-Schutz)")
        if principal.kind == "login" and request.headers.get("x-csrf-token") != principal.csrf:
            raise HTTPException(403, "CSRF-Token ungültig – bitte Seite neu laden")
        if principal.kind in ("share", "display") and "/api/data/" not in request.url.path:
            raise HTTPException(403, "Präsentationszugang ist schreibgeschützt")
    return principal


def require(role: str) -> Callable:
    async def dep(principal: Principal = Depends(current_principal)) -> Principal:
        if principal.kind in ("share", "display") and role != "viewer":
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
