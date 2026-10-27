"""Virtual entities derived from attributes of Home Assistant entities.

Thermostats (``climate.*``) expose their set point and whether they are heating
only as attributes. They are offered as separate recordable series:

* ``climate.xyz::temperature`` – set point in °C
* ``climate.xyz::heating``     – 100 while heating, 0 otherwise (mean = share of time heating in %)
"""
from __future__ import annotations

from typing import Any

SEP = "::"

VIRTUALS: dict[str, dict[str, dict[str, Any]]] = {
    "climate": {
        "temperature": {"label": "Sollwert", "unit": "°C", "device_class": "temperature"},
        "heating": {"label": "Heizanteil", "unit": "%", "device_class": None},
    },
}


def is_virtual(entity_id: str) -> bool:
    return SEP in (entity_id or "")


def split(entity_id: str) -> tuple[str, str]:
    base, _, attr = entity_id.partition(SEP)
    return base, attr


def virtual_ids(base_id: str) -> list[str]:
    domain = base_id.split(".", 1)[0]
    return [f"{base_id}{SEP}{a}" for a in VIRTUALS.get(domain, {})]


def definition(entity_id: str) -> dict | None:
    base, attr = split(entity_id)
    return VIRTUALS.get(base.split(".", 1)[0], {}).get(attr)


def value_from(attr: str, state: Any, attributes: dict | None) -> float | None:
    attributes = attributes or {}
    if state in (None, "unavailable", "unknown"):
        return None
    if attr == "heating":
        action = attributes.get("hvac_action")
        if action is None:
            return None
        return 100.0 if action == "heating" else 0.0
    raw = attributes.get(attr)
    try:
        return float(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def synthetic_state(entity_id: str, base_state: dict | None) -> dict | None:
    """State dict for a virtual entity, built from the state of its base entity."""
    if base_state is None:
        return None
    d = definition(entity_id)
    if d is None:
        return None
    base, attr = split(entity_id)
    attrs = base_state.get("attributes") or {}
    v = value_from(attr, base_state.get("state"), attrs)
    name = attrs.get("friendly_name") or base
    return {
        "entity_id": entity_id,
        "state": "unavailable" if v is None else str(round(v, 3)),
        "attributes": {"unit_of_measurement": d["unit"], "friendly_name": f"{name} {d['label']}",
                       "state_class": "measurement", "device_class": d["device_class"]},
        "last_changed": base_state.get("last_changed"),
        "last_updated": base_state.get("last_updated"),
    }
