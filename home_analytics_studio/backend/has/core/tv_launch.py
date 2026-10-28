"""Opt-in: turn on a linked TV and open the dashboard in its browser via Home Assistant."""
from __future__ import annotations

import asyncio
import logging
import time
from urllib.parse import urlparse

log = logging.getLogger(__name__)

# Samsung Tizen browser ("Internet"): classic id and the id used on newer models
from ..ha.client import BROWSER_APP_IDS  # noqa: E402

BROWSER_APPS = ("org.tizen.browser", "3201907018807")
assert set(BROWSER_APPS) == BROWSER_APP_IDS
PLAY_MEDIA = 512  # MediaPlayerEntityFeature.PLAY_MEDIA
TURN_ON = 128


def supports_play_media(state: dict | None) -> bool:
    try:
        return bool(int((state or {}).get("attributes", {}).get("supported_features") or 0) & PLAY_MEDIA)
    except (TypeError, ValueError):
        return False


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
        online = lambda: display_id in svc.live.online_displays()  # noqa: E731
        mode, app = svc.displays.launch_mode(display_id)
        attempts: list[tuple[str, str]] = []
        if mode == "app" and app:
            attempts.append(("app", app))
        elif mode != "app":
            attempts.append(("url", url))
        attempts += [("app", a) for a in BROWSER_APPS if ("app", a) not in attempts]
        last_error: Exception | None = None
        for kind, target in attempts:
            try:
                if kind == "url":
                    await svc.ha.control_tv("play_media", tv_entity, {"media_content_type": "browser", "media_content_id": target})
                else:
                    # app mode: the browser opens its last page – the paired dashboard (one-time /tv setup)
                    await svc.ha.control_tv("play_media", tv_entity, {"media_content_type": "app", "media_content_id": target})
            except Exception as err:  # noqa: BLE001 – e.g. "can only play media of type app"
                last_error = err
                log.info("TV-Start (%s %s) abgelehnt: %s", kind, target, err)
                continue
            if await _wait_for(online, 30):
                svc.displays.set_launch_mode(display_id, kind, target if kind == "app" else None)
                last_error = None
                break
            last_error = TimeoutError(f"{'Adresse' if kind == 'url' else 'Internet-App ' + target} geöffnet, aber das Dashboard hat sich nicht gemeldet")
        else:
            if last_error is not None:
                d = svc.displays.get(display_id) or {}
                hint = ("" if d.get("screen") else
                        f" Einmalig nötig: am Fernseher im Browser {base}/tv öffnen und den Code unter Teilen → "
                        f"„Code einem Gerät zuordnen“ bei „{d.get('name')}“ eingeben.")
                raise RuntimeError(f"{last_error}.{hint}")
    except Exception as err:  # noqa: BLE001
        error = str(err) if isinstance(err, (PermissionError, ValueError, TimeoutError, RuntimeError)) else f"{type(err).__name__}: {err}"
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
