"""Opt-in: turn on a linked TV and open the dashboard in its browser via Home Assistant."""
from __future__ import annotations

import asyncio
import logging
import time
from urllib.parse import urlparse

log = logging.getLogger(__name__)


def tv_base_url(svc) -> str | None:
    """URL the TV opens. Configured value, else host of HA's internal URL + direct port of the add-on."""
    conf = (svc.settings.get("displays", "tv_url") or "").strip().rstrip("/")
    if conf:
        return conf
    internal = (svc.ha.config or {}).get("internal_url") or ""
    host = urlparse(internal).hostname if internal else None
    if not host or not svc.config.direct_port:
        return None
    return f"http://{host}:{svc.config.direct_port}"


async def launch(svc, display_id: int) -> None:
    """Turn the TV on (if needed) and open <base>/tv?display=<token>. Result is stored on the display."""
    tv_entity, token = svc.displays.launch_info(display_id)
    error = None
    try:
        if not svc.settings.get("displays", "tv_control_enabled", False):
            raise PermissionError("Fernseher-Steuerung ist in den Einstellungen nicht aktiviert")
        if not tv_entity or not token:
            raise ValueError("Bildschirm ist mit keinem Fernseher verknüpft")
        base = tv_base_url(svc)
        if not base:
            raise ValueError("Adresse für den Fernseher unbekannt – bitte unter Einstellungen → Bildschirme eintragen")
        url = f"{base}/tv?display={token}"
        state = (svc.ha.states.get(tv_entity) or {}).get("state")
        if state in (None, "off", "unavailable", "standby"):
            await svc.ha.control_tv("turn_on", tv_entity)
            await _wait_for(lambda: (svc.ha.states.get(tv_entity) or {}).get("state") not in ("off", "unavailable", None), 25)
            await asyncio.sleep(float(svc.settings.get("displays", "boot_wait_seconds", 12) or 0))
        await svc.ha.control_tv("play_media", tv_entity, {"media_content_type": "browser", "media_content_id": url})
        # success = the display connects; otherwise retry once (browser start after boot can be slow)
        if not await _wait_for(lambda: display_id in svc.live.online_displays(), 25):
            await svc.ha.control_tv("play_media", tv_entity, {"media_content_type": "browser", "media_content_id": url})
            if not await _wait_for(lambda: display_id in svc.live.online_displays(), 30):
                raise TimeoutError("Fernseher hat die Seite nicht geöffnet (Browser-Start über die Integration nicht unterstützt?)")
    except Exception as err:  # noqa: BLE001
        error = f"{type(err).__name__}: {err}" if not isinstance(err, (PermissionError, ValueError, TimeoutError)) else str(err)
        log.warning("TV-Start für Bildschirm %s fehlgeschlagen: %s", display_id, error)
    svc.displays.set_launch_result(display_id, error)
    d = svc.displays.get(display_id) or {}
    svc.live.broadcast({"type": "display_launch", "display_id": display_id, "name": d.get("name"), "ok": error is None, "error": error})


async def _wait_for(cond, timeout: float, step: float = 0.5) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout:
        if cond():
            return True
        await asyncio.sleep(step)
    return cond()
