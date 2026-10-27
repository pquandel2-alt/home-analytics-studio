"""Unit normalisation.

Every recorded entity stores its values in a canonical unit of its physical
dimension (energy -> kWh, power -> W, volume -> m³, temperature -> °C ...).
If Home Assistant reports a different (compatible) unit later, values are
converted so that the time series stays continuous.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class UnitDef:
    dimension: str
    canonical: str
    to_canonical: Callable[[float], float]


def _f(factor: float) -> Callable[[float], float]:
    return lambda v: v * factor


_UNITS: dict[str, UnitDef] = {}


def _reg(dimension: str, canonical: str, mapping: dict[str, Callable[[float], float]]) -> None:
    for unit, fn in mapping.items():
        _UNITS[unit] = UnitDef(dimension, canonical, fn)


_reg("energy", "kWh", {
    "Wh": _f(0.001), "kWh": _f(1), "MWh": _f(1000), "GWh": _f(1_000_000),
    "mWh": _f(1e-6), "J": _f(1 / 3_600_000), "kJ": _f(1 / 3600), "MJ": _f(1 / 3.6), "GJ": _f(1000 / 3.6),
    "cal": _f(4.184 / 3_600_000), "kcal": _f(4.184 / 3600), "Mcal": _f(4.184 / 3.6), "Gcal": _f(4184 / 3.6),
})
_reg("power", "W", {
    "mW": _f(0.001), "W": _f(1), "kW": _f(1000), "MW": _f(1_000_000), "GW": _f(1e9), "BTU/h": _f(0.29307107),
})
_reg("volume", "m³", {
    "m³": _f(1), "m3": _f(1), "L": _f(0.001), "l": _f(0.001), "mL": _f(1e-6), "ml": _f(1e-6),
    "ft³": _f(0.0283168466), "CCF": _f(2.83168466), "gal": _f(0.00378541178), "fl. oz.": _f(2.95735296e-5),
})
_reg("flow", "L/min", {
    "L/min": _f(1), "L/h": _f(1 / 60), "m³/h": _f(1000 / 60), "L/s": _f(60), "gal/min": _f(3.78541178),
})
_reg("temperature", "°C", {
    "°C": _f(1), "°F": lambda v: (v - 32) * 5 / 9, "K": lambda v: v - 273.15,
})
_reg("pressure", "hPa", {
    "Pa": _f(0.01), "hPa": _f(1), "kPa": _f(10), "bar": _f(1000), "mbar": _f(1), "psi": _f(68.9475729),
    "inHg": _f(33.8638866), "mmHg": _f(1.33322387),
})
_reg("current", "A", {"mA": _f(0.001), "A": _f(1)})
_reg("voltage", "V", {"mV": _f(0.001), "V": _f(1), "kV": _f(1000)})
_reg("apparent_power", "VA", {"VA": _f(1), "kVA": _f(1000)})
_reg("duration", "h", {"s": _f(1 / 3600), "min": _f(1 / 60), "h": _f(1), "d": _f(24)})
_reg("distance", "km", {"m": _f(0.001), "km": _f(1), "mi": _f(1.609344)})
_reg("mass", "kg", {"g": _f(0.001), "kg": _f(1), "t": _f(1000), "lb": _f(0.45359237)})
_reg("speed", "km/h", {"m/s": _f(3.6), "km/h": _f(1), "mph": _f(1.609344)})


def unit_def(unit: str | None) -> UnitDef | None:
    if not unit:
        return None
    return _UNITS.get(unit.strip())


def canonical_unit(unit: str | None) -> str | None:
    d = unit_def(unit)
    if d is None:
        return unit or None
    return d.canonical


def convert(value: float, from_unit: str | None, to_unit: str | None) -> float:
    """Convert value between two units of the same dimension.

    Unknown or identical units are passed through unchanged.
    """
    if from_unit == to_unit or not from_unit or not to_unit:
        return value
    src = unit_def(from_unit)
    dst = unit_def(to_unit)
    if src is None or dst is None or src.dimension != dst.dimension:
        return value
    canonical_value = src.to_canonical(value)
    if dst.canonical == to_unit:
        return canonical_value
    # find inverse numerically for linear units (affine only defined into canonical)
    one = dst.to_canonical(1.0)
    zero = dst.to_canonical(0.0)
    scale = one - zero
    return (canonical_value - zero) / scale if scale else canonical_value


def compatible(a: str | None, b: str | None) -> bool:
    if a == b:
        return True
    da, db = unit_def(a), unit_def(b)
    return bool(da and db and da.dimension == db.dimension)


def dimension(unit: str | None) -> str | None:
    d = unit_def(unit)
    return d.dimension if d else None
