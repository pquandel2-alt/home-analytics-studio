from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from ..core.auth import Principal
from .routes_system import _audit as audit
from .deps import SESSION_COOKIE, admin, client_ip, editor, is_ingress, resolve_principal, services, viewer

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str
    password: str


class SetupBody(BaseModel):
    username: str
    password: str
    setup_code: str | None = None


class UserBody(BaseModel):
    username: str
    password: str | None = None
    role: str = "viewer"
    display_name: str | None = None


class UserPatch(BaseModel):
    role: str | None = None
    password: str | None = None
    display_name: str | None = None


class TokenBody(BaseModel):
    name: str
    user_id: int
    role: str | None = None  # defaults to the user's role; may be lower, never higher
    days: float | None = None  # None = never expires


class ShareBody(BaseModel):
    name: str
    dashboard_id: int
    days: int | None = None


def _check_xrw(request: Request) -> None:
    if request.headers.get("x-requested-with") != "has":
        raise HTTPException(403, "Ungültige Anfrage (CSRF-Schutz)")


def _set_cookie(response: Response, request: Request, token: str, hours: int) -> None:
    svc = services(request)
    secure = svc.config.secure_cookies or request.headers.get("x-forwarded-proto") == "https" \
        or request.url.scheme == "https"
    response.set_cookie(SESSION_COOKIE, token, max_age=hours * 3600, httponly=True, samesite="lax", secure=secure, path="/")


@router.get("/status")
async def status(request: Request) -> dict:
    svc = services(request)
    principal = resolve_principal(request, svc)
    return {
        "authenticated": principal is not None,
        "user": principal.as_dict() if principal else None,
        "csrf": principal.csrf if principal else None,
        "setup_required": not svc.auth.has_local_admin(),
        "ingress": is_ingress(request, svc),
        "supervisor": svc.config.in_supervisor,
        "direct_login_allowed": bool(svc.settings.get("security", "allow_direct_login", True)),
        "instance_name": svc.settings.get("general", "instance_name"),
    }


@router.post("/setup")
async def setup(body: SetupBody, request: Request, response: Response) -> dict:
    _check_xrw(request)
    svc = services(request)
    if svc.auth.has_local_admin():
        raise HTTPException(409, "Einrichtung bereits abgeschlossen")
    principal = resolve_principal(request, svc)
    via_ingress = principal is not None and principal.kind == "ingress" and principal.has("admin")
    if not via_ingress:
        if not svc.setup_token or not body.setup_code or not hmac.compare_digest(
                body.setup_code.strip().upper(), svc.setup_token):
            raise HTTPException(403, "Einrichtungscode ungültig – siehe Add-on-Protokoll")
    try:
        user = svc.auth.create_user(body.username, body.password, "admin")
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    svc.setup_token = None
    token, csrf = svc.auth.create_session(user["id"], request.headers.get("user-agent"))
    if not via_ingress:
        _set_cookie(response, request, token, int(svc.settings.get("security", "session_hours", 720)))
    return {"ok": True, "user": user, "csrf": csrf}


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response) -> dict:
    _check_xrw(request)
    svc = services(request)
    if not svc.settings.get("security", "allow_direct_login", True) and not is_ingress(request, svc):
        raise HTTPException(403, "Direktanmeldung ist deaktiviert")
    ip = client_ip(request, svc)
    svc.auth.limiter.limit = int(svc.settings.get("security", "login_rate_limit", 10) or 10)
    if not svc.auth.limiter.allow(ip):
        raise HTTPException(429, "Zu viele Anmeldeversuche – bitte einige Minuten warten")
    user = svc.auth.authenticate(body.username, body.password)
    if not user:
        raise HTTPException(401, "Benutzername oder Passwort falsch")
    svc.auth.limiter.reset(ip)
    token, csrf = svc.auth.create_session(user["id"], request.headers.get("user-agent"))
    _set_cookie(response, request, token, int(svc.settings.get("security", "session_hours", 720)))
    return {"ok": True, "csrf": csrf, "user": {"id": user["id"], "username": user["username"], "role": user["role"]}}


@router.post("/logout")
async def logout(request: Request, response: Response, principal: Principal = Depends(viewer)) -> dict:
    if principal.session_hash:
        services(request).auth.delete_session(principal.session_hash)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
async def me(principal: Principal = Depends(viewer)) -> dict:
    return principal.as_dict()


@router.post("/password")
async def change_password(body: dict, request: Request, principal: Principal = Depends(viewer)) -> dict:
    svc = services(request)
    if principal.kind != "login" or principal.user_id is None:
        raise HTTPException(400, "Nur für lokale Benutzer")
    user = svc.auth.authenticate(principal.username, body.get("current", ""))
    if not user:
        raise HTTPException(401, "Aktuelles Passwort falsch")
    try:
        svc.auth.update_user(principal.user_id, password=body.get("new"))
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    return {"ok": True}


# ---------------------------------------------------------------- users


@router.get("/users")
async def list_users(request: Request, _: Principal = Depends(admin)) -> list[dict]:
    return services(request).auth.list_users()


@router.post("/users")
async def create_user(body: UserBody, request: Request, _: Principal = Depends(admin)) -> dict:
    try:
        return services(request).auth.create_user(body.username, body.password, body.role, body.display_name)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err


@router.patch("/users/{user_id}")
async def update_user(user_id: int, body: UserPatch, request: Request, _: Principal = Depends(admin)) -> dict:
    try:
        services(request).auth.update_user(user_id, body.role, body.password, body.display_name)
    except KeyError as err:
        raise HTTPException(404, str(err)) from err
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    return {"ok": True}


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, request: Request, principal: Principal = Depends(admin)) -> dict:
    if principal.user_id == user_id:
        raise HTTPException(400, "Sie können sich nicht selbst löschen")
    try:
        services(request).auth.delete_user(user_id)
    except KeyError as err:
        raise HTTPException(404, str(err)) from err
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    return {"ok": True}


# ---------------------------------------------------------------- share links


@router.get("/shares")
async def list_shares(request: Request, _: Principal = Depends(editor)) -> list[dict]:
    return services(request).auth.list_shares()


@router.post("/shares")
async def create_share(body: ShareBody, request: Request, principal: Principal = Depends(editor)) -> dict:
    try:
        return services(request).auth.create_share(body.name, body.dashboard_id, principal.user_id, body.days)
    except KeyError as err:
        raise HTTPException(404, str(err)) from err


@router.delete("/shares/{share_id}")
async def delete_share(share_id: int, request: Request, _: Principal = Depends(editor)) -> dict:
    services(request).auth.delete_share(share_id)
    return {"ok": True}


# ---------------------------------------------------------------- API tokens (admin only, never via a token itself)


def _admin_session(principal: Principal = Depends(admin)) -> Principal:
    if principal.kind == "api":
        raise HTTPException(403, "API-Tokens können nur mit einer Anmeldung verwaltet werden")
    return principal


@router.get("/tokens")
async def list_tokens(request: Request, _: Principal = Depends(_admin_session)) -> list[dict]:
    return services(request).auth.list_api_tokens()


@router.post("/tokens")
async def create_token(body: TokenBody, request: Request, principal: Principal = Depends(_admin_session)) -> dict:
    svc = services(request)
    try:
        res = svc.auth.create_api_token(body.name, body.user_id, body.role, principal.user_id, body.days)
    except KeyError as err:
        raise HTTPException(404, str(err)) from err
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    audit(svc, principal, "token.create", f"#{res['id']} {res['name']} ({res['username']}, {res['role']})")
    return res  # the only time the full token is returned


@router.delete("/tokens/{token_id}")
async def revoke_token(token_id: int, request: Request, principal: Principal = Depends(_admin_session)) -> dict:
    svc = services(request)
    try:
        svc.auth.revoke_api_token(token_id)
    except KeyError as err:
        raise HTTPException(404, str(err)) from err
    audit(svc, principal, "token.revoke", f"#{token_id}")
    return {"ok": True}


@router.delete("/tokens/{token_id}/entry")
async def delete_token(token_id: int, request: Request, principal: Principal = Depends(_admin_session)) -> dict:
    """Remove a (revoked/expired) token from the list."""
    svc = services(request)
    svc.auth.delete_api_token(token_id)
    audit(svc, principal, "token.delete", f"#{token_id}")
    return {"ok": True}
