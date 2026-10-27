from __future__ import annotations

import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import text

from ..config import VERSION
from ..core import formula as fx
from ..core.auth import Principal
from .deps import editor, services, viewer

router = APIRouter(prefix="/api", tags=["dashboards"])

JSON_FIELDS_D = ("theme", "settings")
JSON_FIELDS_P = ("settings", "widgets", "layouts")
MAX_PAGE_BYTES = 4 * 1024 * 1024


def _load(row, fields) -> dict:
    d = dict(row)
    for f in fields:
        try:
            d[f] = json.loads(d.get(f) or ("[]" if f == "widgets" else "{}"))
        except ValueError:
            d[f] = [] if f == "widgets" else {}
    return d


def _pages(conn, dashboard_id: int) -> list[dict]:
    rows = conn.execute(text("SELECT * FROM pages WHERE dashboard_id=:d ORDER BY sort, id"), {"d": dashboard_id}).mappings()
    return [_load(r, JSON_FIELDS_P) for r in rows]


def _dashboard(conn, dashboard_id: int, with_pages: bool = True) -> dict | None:
    row = conn.execute(text("SELECT * FROM dashboards WHERE id=:d"), {"d": dashboard_id}).mappings().first()
    if not row:
        return None
    d = _load(row, JSON_FIELDS_D)
    if with_pages:
        d["pages"] = _pages(conn, dashboard_id)
    return d


def _check_access(principal: Principal, dashboard_id: int) -> None:
    if principal.kind == "share" and principal.share_dashboard_id != dashboard_id:
        raise HTTPException(403, "Kein Zugriff auf dieses Dashboard")


class DashboardBody(BaseModel):
    name: str
    description: str | None = None
    icon: str | None = None
    theme: dict | None = None
    settings: dict | None = None


class DashboardPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    icon: str | None = None
    theme: dict | None = None
    settings: dict | None = None


class PageBody(BaseModel):
    title: str = "Neue Seite"
    icon: str | None = None
    settings: dict | None = None
    widgets: list | None = None
    layouts: dict | None = None


class PagePatch(BaseModel):
    title: str | None = None
    icon: str | None = None
    hidden: bool | None = None
    settings: dict | None = None
    widgets: list | None = None
    layouts: dict | None = None
    version: int | None = None


DEFAULT_SETTINGS = {
    "grid": {"cols": {"xxl": 32, "xl": 24, "lg": 24, "md": 16, "sm": 8, "xs": 4}, "rowHeight": 40,
             "margin": 12, "compact": "none", "allowOverlap": False, "snap": True},
    "navigation": {"position": "top", "style": "tabs", "showTitle": True},
    "presentation": {"interval": 30, "refresh": 60, "transition": "fade", "pages": "all", "showClock": True},
}


def _merge(base: dict, extra: dict | None) -> dict:
    out = json.loads(json.dumps(base))
    for k, v in (extra or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


@router.get("/dashboards")
async def list_dashboards(request: Request, principal: Principal = Depends(viewer)) -> list[dict]:
    svc = services(request)
    with svc.db.read() as conn:
        rows = conn.execute(text("SELECT d.id, d.name, d.description, d.icon, d.sort, d.theme, d.updated_at,"
                                 " (SELECT COUNT(*) FROM pages p WHERE p.dashboard_id=d.id) AS page_count"
                                 " FROM dashboards d ORDER BY d.sort, d.id")).mappings().all()
    return [_load(r, ("theme",)) for r in rows]


@router.post("/dashboards")
async def create_dashboard(body: DashboardBody, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    now = time.time()
    with svc.db.write() as conn:
        sort = (conn.execute(text("SELECT MAX(sort) FROM dashboards")).scalar() or 0) + 1
        res = conn.execute(text("INSERT INTO dashboards(name, description, icon, sort, theme, settings, created_at, updated_at)"
                                " VALUES (:n, :d, :i, :s, :th, :st, :t, :t)"),
                           {"n": body.name.strip() or "Dashboard", "d": body.description, "i": body.icon, "s": sort,
                            "th": json.dumps(body.theme or {}), "st": json.dumps(_merge(DEFAULT_SETTINGS, body.settings)), "t": now})
        did = res.lastrowid
        conn.execute(text("INSERT INTO pages(dashboard_id, title, sort, settings, widgets, layouts, version, updated_at)"
                          " VALUES (:d, 'Übersicht', 0, '{}', '[]', '{}', 1, :t)"), {"d": did, "t": now})
        return _dashboard(conn, did)


@router.get("/dashboards/{dashboard_id}")
async def get_dashboard(dashboard_id: int, request: Request, principal: Principal = Depends(viewer)) -> dict:
    _check_access(principal, dashboard_id)
    with services(request).db.read() as conn:
        d = _dashboard(conn, dashboard_id)
    if not d:
        raise HTTPException(404, "Dashboard nicht gefunden")
    d["settings"] = _merge(DEFAULT_SETTINGS, d.get("settings"))
    return d


@router.put("/dashboards/{dashboard_id}")
async def update_dashboard(dashboard_id: int, body: DashboardPatch, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    fields: dict[str, Any] = {}
    if body.name is not None:
        if not body.name.strip():
            raise HTTPException(400, "Name darf nicht leer sein")
        fields["name"] = body.name.strip()
    if body.description is not None:
        fields["description"] = body.description
    if body.icon is not None:
        fields["icon"] = body.icon
    if body.theme is not None:
        fields["theme"] = json.dumps(body.theme)
    if body.settings is not None:
        fields["settings"] = json.dumps(body.settings)
    with svc.db.write() as conn:
        if not conn.execute(text("SELECT 1 FROM dashboards WHERE id=:d"), {"d": dashboard_id}).first():
            raise HTTPException(404, "Dashboard nicht gefunden")
        if fields:
            fields["updated_at"] = time.time()
            sets = ", ".join(f"{k}=:{k}" for k in fields)
            conn.execute(text(f"UPDATE dashboards SET {sets} WHERE id=:id"), {**fields, "id": dashboard_id})
        return _dashboard(conn, dashboard_id)


@router.delete("/dashboards/{dashboard_id}")
async def delete_dashboard(dashboard_id: int, request: Request, _: Principal = Depends(editor)) -> dict:
    with services(request).db.write() as conn:
        conn.execute(text("DELETE FROM pages WHERE dashboard_id=:d"), {"d": dashboard_id})
        conn.execute(text("DELETE FROM share_links WHERE dashboard_id=:d"), {"d": dashboard_id})
        res = conn.execute(text("DELETE FROM dashboards WHERE id=:d"), {"d": dashboard_id})
    if not res.rowcount:
        raise HTTPException(404, "Dashboard nicht gefunden")
    return {"ok": True}


def _insert_dashboard(conn, data: dict, name: str) -> int:
    now = time.time()
    sort = (conn.execute(text("SELECT MAX(sort) FROM dashboards")).scalar() or 0) + 1
    res = conn.execute(text("INSERT INTO dashboards(name, description, icon, sort, theme, settings, created_at, updated_at)"
                            " VALUES (:n, :d, :i, :s, :th, :st, :t, :t)"),
                       {"n": name, "d": data.get("description"), "i": data.get("icon"), "s": sort,
                        "th": json.dumps(data.get("theme") or {}),
                        "st": json.dumps(_merge(DEFAULT_SETTINGS, data.get("settings"))), "t": now})
    did = res.lastrowid
    for i, p in enumerate(data.get("pages") or []):
        conn.execute(text("INSERT INTO pages(dashboard_id, title, icon, sort, hidden, settings, widgets, layouts, version, updated_at)"
                          " VALUES (:d, :ti, :ic, :s, :h, :st, :w, :l, 1, :t)"),
                     {"d": did, "ti": p.get("title") or f"Seite {i + 1}", "ic": p.get("icon"), "s": i,
                      "h": 1 if p.get("hidden") else 0, "st": json.dumps(p.get("settings") or {}),
                      "w": json.dumps(p.get("widgets") or []), "l": json.dumps(p.get("layouts") or {}), "t": now})
    return did


@router.post("/dashboards/{dashboard_id}/duplicate")
async def duplicate_dashboard(dashboard_id: int, request: Request, _: Principal = Depends(editor)) -> dict:
    with services(request).db.write() as conn:
        d = _dashboard(conn, dashboard_id)
        if not d:
            raise HTTPException(404, "Dashboard nicht gefunden")
        did = _insert_dashboard(conn, d, f"{d['name']} (Kopie)")
        return _dashboard(conn, did)


@router.post("/dashboards/reorder")
async def reorder_dashboards(body: dict, request: Request, _: Principal = Depends(editor)) -> dict:
    with services(request).db.write() as conn:
        for i, did in enumerate(body.get("order") or []):
            conn.execute(text("UPDATE dashboards SET sort=:s WHERE id=:d"), {"s": i, "d": int(did)})
    return {"ok": True}


@router.get("/dashboards/{dashboard_id}/export")
async def export_dashboard(dashboard_id: int, request: Request, _: Principal = Depends(viewer)) -> Response:
    svc = services(request)
    with svc.db.read() as conn:
        d = _dashboard(conn, dashboard_id)
        if not d:
            raise HTTPException(404, "Dashboard nicht gefunden")
        metrics = {r["key"]: dict(r) for r in conn.execute(text("SELECT * FROM metrics")).mappings()}
        constants = {r["key"]: dict(r) for r in conn.execute(text("SELECT * FROM constants")).mappings()}
    used = _collect_metric_keys(d)
    # include transitive metric/constant dependencies
    needed_m: set[str] = set()
    needed_c: set[str] = set()
    stack = list(used)
    while stack:
        k = stack.pop()
        if k in needed_m or k not in metrics:
            continue
        needed_m.add(k)
        try:
            names = fx.analyze(fx.parse(metrics[k]["formula"])).names
        except fx.FormulaError:
            names = set()
        for n in names:
            if n in constants:
                needed_c.add(n)
            elif n in metrics:
                stack.append(n)
    payload = {
        "format": "has-dashboard", "version": 1, "app_version": VERSION, "exported_at": time.time(),
        "dashboard": {k: d[k] for k in ("name", "description", "icon", "theme", "settings")},
        "pages": [{k: p[k] for k in ("title", "icon", "hidden", "settings", "widgets", "layouts")} for p in d["pages"]],
        "metrics": [{k: v for k, v in metrics[k].items() if k not in ("id",)} for k in sorted(needed_m)],
        "constants": [{k: v for k, v in constants[c].items() if k not in ("id",)} for c in sorted(needed_c)],
    }
    fname = "".join(ch if ch.isalnum() else "_" for ch in d["name"])[:40] or "dashboard"
    return Response(json.dumps(payload, ensure_ascii=False, indent=1), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{fname}.dashboard.json"'})


def _collect_metric_keys(d: dict) -> set[str]:
    keys: set[str] = set()

    def walk(obj: Any) -> None:
        if isinstance(obj, dict):
            if obj.get("type") == "metric" and isinstance(obj.get("id"), str):
                keys.add(obj["id"])
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for v in obj:
                walk(v)

    walk(d.get("pages"))
    return keys


@router.post("/dashboards/import")
async def import_dashboard(body: dict, request: Request, _: Principal = Depends(editor)) -> dict:
    if body.get("format") != "has-dashboard":
        raise HTTPException(400, "Keine gültige Dashboard-Datei")
    svc = services(request)
    created = {"metrics": [], "constants": [], "skipped": []}
    now = time.time()
    with svc.db.write() as conn:
        for c in body.get("constants") or []:
            if conn.execute(text("SELECT 1 FROM constants WHERE key=:k"), {"k": c["key"]}).first():
                created["skipped"].append(c["key"])
                continue
            conn.execute(text("INSERT INTO constants(key, name, value, unit, description, updated_at) VALUES (:k, :n, :v, :u, :d, :t)"),
                         {"k": c["key"], "n": c.get("name"), "v": float(c["value"]), "u": c.get("unit"),
                          "d": c.get("description"), "t": now})
            created["constants"].append(c["key"])
        for m in body.get("metrics") or []:
            if conn.execute(text("SELECT 1 FROM metrics WHERE key=:k"), {"k": m["key"]}).first():
                created["skipped"].append(m["key"])
                continue
            fx.parse(m["formula"])  # syntax check
            conn.execute(text("INSERT INTO metrics(name, key, description, formula, unit, aggregation, decimals, color, builder, created_at, updated_at)"
                              " VALUES (:n, :k, :d, :f, :u, :a, :dec, :c, :b, :t, :t)"),
                         {"n": m.get("name") or m["key"], "k": m["key"], "d": m.get("description"), "f": m["formula"],
                          "u": m.get("unit"), "a": m.get("aggregation") or "auto", "dec": int(m.get("decimals") or 2),
                          "c": m.get("color"), "b": m.get("builder") if isinstance(m.get("builder"), str) or m.get("builder") is None
                          else json.dumps(m.get("builder")), "t": now})
            created["metrics"].append(m["key"])
        dash = body.get("dashboard") or {}
        did = _insert_dashboard(conn, {**dash, "pages": body.get("pages") or []}, dash.get("name") or "Importiertes Dashboard")
        result = _dashboard(conn, did)
    return {"dashboard": result, "created": created}


# ---------------------------------------------------------------- pages


@router.post("/dashboards/{dashboard_id}/pages")
async def add_page(dashboard_id: int, body: PageBody, request: Request, _: Principal = Depends(editor)) -> dict:
    now = time.time()
    with services(request).db.write() as conn:
        if not conn.execute(text("SELECT 1 FROM dashboards WHERE id=:d"), {"d": dashboard_id}).first():
            raise HTTPException(404, "Dashboard nicht gefunden")
        sort = (conn.execute(text("SELECT MAX(sort) FROM pages WHERE dashboard_id=:d"), {"d": dashboard_id}).scalar() or 0) + 1
        res = conn.execute(text("INSERT INTO pages(dashboard_id, title, icon, sort, settings, widgets, layouts, version, updated_at)"
                                " VALUES (:d, :t, :i, :s, :st, :w, :l, 1, :n)"),
                           {"d": dashboard_id, "t": body.title, "i": body.icon, "s": sort, "st": json.dumps(body.settings or {}),
                            "w": json.dumps(body.widgets or []), "l": json.dumps(body.layouts or {}), "n": now})
        row = conn.execute(text("SELECT * FROM pages WHERE id=:i"), {"i": res.lastrowid}).mappings().one()
    return _load(row, JSON_FIELDS_P)


@router.put("/pages/{page_id}")
async def update_page(page_id: int, body: PagePatch, request: Request, _: Principal = Depends(editor)) -> dict:
    svc = services(request)
    with svc.db.write() as conn:
        row = conn.execute(text("SELECT * FROM pages WHERE id=:i"), {"i": page_id}).mappings().first()
        if not row:
            raise HTTPException(404, "Seite nicht gefunden")
        if body.version is not None and body.version != row["version"]:
            raise HTTPException(409, {"message": "Die Seite wurde zwischenzeitlich geändert", "current": _load(row, JSON_FIELDS_P)})
        fields: dict[str, Any] = {}
        if body.title is not None:
            fields["title"] = body.title.strip() or "Seite"
        if body.icon is not None:
            fields["icon"] = body.icon
        if body.hidden is not None:
            fields["hidden"] = 1 if body.hidden else 0
        for f in ("settings", "widgets", "layouts"):
            v = getattr(body, f)
            if v is not None:
                fields[f] = json.dumps(v)
        if sum(len(v) for v in fields.values() if isinstance(v, str)) > MAX_PAGE_BYTES:
            raise HTTPException(413, "Seite zu groß")
        if fields:
            fields["version"] = row["version"] + 1
            fields["updated_at"] = time.time()
            sets = ", ".join(f"{k}=:{k}" for k in fields)
            conn.execute(text(f"UPDATE pages SET {sets} WHERE id=:id"), {**fields, "id": page_id})
            conn.execute(text("UPDATE dashboards SET updated_at=:t WHERE id=:d"), {"t": time.time(), "d": row["dashboard_id"]})
        row = conn.execute(text("SELECT * FROM pages WHERE id=:i"), {"i": page_id}).mappings().one()
    return _load(row, JSON_FIELDS_P)


@router.delete("/pages/{page_id}")
async def delete_page(page_id: int, request: Request, _: Principal = Depends(editor)) -> dict:
    with services(request).db.write() as conn:
        row = conn.execute(text("SELECT dashboard_id FROM pages WHERE id=:i"), {"i": page_id}).first()
        if not row:
            raise HTTPException(404, "Seite nicht gefunden")
        count = conn.execute(text("SELECT COUNT(*) FROM pages WHERE dashboard_id=:d"), {"d": row[0]}).scalar()
        if count <= 1:
            raise HTTPException(400, "Ein Dashboard benötigt mindestens eine Seite")
        conn.execute(text("DELETE FROM pages WHERE id=:i"), {"i": page_id})
    return {"ok": True}


@router.post("/pages/{page_id}/duplicate")
async def duplicate_page(page_id: int, request: Request, _: Principal = Depends(editor)) -> dict:
    with services(request).db.write() as conn:
        row = conn.execute(text("SELECT * FROM pages WHERE id=:i"), {"i": page_id}).mappings().first()
        if not row:
            raise HTTPException(404, "Seite nicht gefunden")
        sort = (conn.execute(text("SELECT MAX(sort) FROM pages WHERE dashboard_id=:d"), {"d": row["dashboard_id"]}).scalar() or 0) + 1
        res = conn.execute(text("INSERT INTO pages(dashboard_id, title, icon, sort, hidden, settings, widgets, layouts, version, updated_at)"
                                " VALUES (:d, :t, :i, :s, :h, :st, :w, :l, 1, :n)"),
                           {"d": row["dashboard_id"], "t": f"{row['title']} (Kopie)", "i": row["icon"], "s": sort,
                            "h": row["hidden"], "st": row["settings"], "w": row["widgets"], "l": row["layouts"], "n": time.time()})
        new = conn.execute(text("SELECT * FROM pages WHERE id=:i"), {"i": res.lastrowid}).mappings().one()
    return _load(new, JSON_FIELDS_P)


@router.post("/dashboards/{dashboard_id}/pages/reorder")
async def reorder_pages(dashboard_id: int, body: dict, request: Request, _: Principal = Depends(editor)) -> dict:
    with services(request).db.write() as conn:
        for i, pid in enumerate(body.get("order") or []):
            conn.execute(text("UPDATE pages SET sort=:s WHERE id=:p AND dashboard_id=:d"), {"s": i, "p": int(pid), "d": dashboard_id})
    return {"ok": True}
