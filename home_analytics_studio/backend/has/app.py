"""FastAPI application factory."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.middleware.gzip import GZipMiddleware

from .api import routes_auth, routes_dashboards, routes_data, routes_entities, routes_system
from .api.deps import resolve_principal
from .config import VERSION, Config, load_config
from .services import Services

log = logging.getLogger(__name__)

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "SAMEORIGIN",
}


def create_app(config: Config | None = None, start_background: bool = True) -> FastAPI:
    config = config or load_config()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        svc = Services(config)
        app.state.services = svc
        if start_background:
            await svc.start()
        try:
            yield
        finally:
            if start_background:
                await svc.stop()
            svc.db.dispose()

    app = FastAPI(title="Home Analytics Studio", version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None,
                  openapi_url="/api/openapi.json")
    app.add_middleware(GZipMiddleware, minimum_size=2048)

    @app.middleware("http")
    async def headers(request: Request, call_next):
        response = await call_next(request)
        for k, v in SECURITY_HEADERS.items():
            response.headers.setdefault(k, v)
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError):
        errors = [f"{'.'.join(str(x) for x in e.get('loc', [])[1:])}: {e.get('msg')}" for e in exc.errors()]
        return JSONResponse({"detail": "Ungültige Eingabe: " + "; ".join(errors)}, status_code=422)

    for r in (routes_auth, routes_entities, routes_data, routes_dashboards, routes_system):
        app.include_router(r.router)

    @app.get("/api/health")
    async def health(request: Request) -> dict:
        svc: Services = request.app.state.services
        return {"status": "ok", "version": VERSION, "ha": svc.ha.status.state}

    @app.websocket("/api/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        svc: Services = ws.app.state.services
        origin = ws.headers.get("origin")
        host = ws.headers.get("host")
        if origin and host and origin.split("://", 1)[-1] != host and not svc.config.trust_proxy_headers:
            # cross-site websocket hijacking protection (ingress keeps same origin)
            fwd_host = ws.headers.get("x-forwarded-host")
            if origin.split("://", 1)[-1] != fwd_host:
                await ws.close(code=4403)
                return
        principal = resolve_principal(ws, svc)
        if principal is None:
            await ws.close(code=4401)
            return
        await svc.live.serve(ws, principal)

    static_dir: Path | None = config.static_dir
    if static_dir and static_dir.exists():
        index = static_dir / "index.html"

        @app.get("/{path:path}", include_in_schema=False)
        async def spa(path: str):
            if path.startswith("api/"):
                raise HTTPException(404, "Nicht gefunden")
            target = (static_dir / path).resolve()
            if path and target.is_file() and static_dir.resolve() in target.parents:
                cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
                return FileResponse(target, headers={"Cache-Control": cache})
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
    else:
        @app.get("/", include_in_schema=False)
        async def no_ui() -> Response:
            return Response("Home Analytics Studio API läuft. Frontend nicht gebaut.", media_type="text/plain")

    return app
