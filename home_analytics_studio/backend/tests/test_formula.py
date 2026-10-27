"""Formula parser, validation, evaluation, dependencies, units."""
import pytest

from has.core import formula as fx
from has.core.stats import BucketStats

H = 3600


def bucket(ts, mean=None, delta=None, mn=None, mx=None, count=1, covered=3600.0, last=None, first=None):
    b = BucketStats(ts=ts, end=ts + H, mean=mean, delta=delta, min=mn, max=mx, count=count, covered=covered, last=last, first=first)
    return b


def ctx(n=4, entities=None, constants=None, metrics=None, kinds=None, units=None, interval="1h"):
    edges = [i * H for i in range(n + 1)]
    entities = entities or {}
    kinds = kinds or {}
    units = units or {}
    return fx.EvalContext(
        edges=edges, tz=__import__("zoneinfo").ZoneInfo("UTC"), interval=interval,
        entity_loader=lambda e, _edges: entities[e],
        entity_kind=lambda e: kinds.get(e),
        entity_unit=lambda e: units.get(e),
        constants=constants or {}, metrics=metrics or {},
    )


def test_precedence_and_unary():
    c = ctx(1)
    assert fx.evaluate("1 + 2 * 3", c) == [7]
    assert fx.evaluate("(1 + 2) * 3", c) == [9]
    assert fx.evaluate("-2 ^ 2", c) == [-4]
    assert fx.evaluate("2 ^ 3 ^ 2", c) == [512]
    assert fx.evaluate("10 % 4", c) == [2]
    assert fx.evaluate("1 < 2 and not 0", c) == [1.0]


def test_division_by_zero_is_none_not_error():
    assert fx.evaluate("5 / 0", ctx(1)) == [None]


def test_entity_natural_value_counter_vs_measurement():
    ents = {
        "sensor.energy": [bucket(i * H, delta=d) for i, d in enumerate([1, 2, 3, 4])],
        "sensor.temp": [bucket(i * H, mean=m) for i, m in enumerate([20, 21, 22, 23])],
    }
    c = ctx(4, ents, constants={"preis": (0.3, "€/kWh")}, kinds={"sensor.energy": "counter", "sensor.temp": "measurement"})
    assert fx.evaluate("sensor.energy * preis", c) == pytest.approx([0.3, 0.6, 0.9, 1.2])
    assert fx.evaluate("sensor.temp", c) == [20, 21, 22, 23]


def test_rolling_average_and_lag():
    ents = {"sensor.t": [bucket(i * H, mean=v) for i, v in enumerate([10, 20, 30, 40])]}
    c = ctx(4, ents, kinds={"sensor.t": "measurement"})
    assert fx.evaluate("AVG(sensor.t, 2h)", c) == [10, 15, 25, 35]
    assert fx.evaluate("MOVING_AVG(sensor.t, 3)", c) == [10, 15, 20, 30]
    assert fx.evaluate("DIFFERENCE(sensor.t)", c) == [None, 10, 10, 10]
    assert fx.evaluate("CHANGE_PCT(sensor.t)", c) == [None, 100.0, 50.0, pytest.approx(33.333, rel=1e-3)]
    assert fx.evaluate("CUMSUM(sensor.t)", c) == [10, 30, 60, 100]


def test_elementwise_and_conditional():
    c = ctx(2, {"sensor.a": [bucket(0, mean=1), bucket(H, mean=5)], "sensor.b": [bucket(0, mean=3), bucket(H, mean=2)]},
            kinds={"sensor.a": "measurement", "sensor.b": "measurement"})
    assert fx.evaluate("MAX(sensor.a, sensor.b)", c) == [3, 5]
    assert fx.evaluate("IF(sensor.a > sensor.b, 1, 0)", c) == [0, 1]
    assert fx.evaluate("PERCENT(sensor.a, sensor.b)", c) == [pytest.approx(33.333, rel=1e-3), 250]


def test_missing_values_propagate_and_coalesce():
    c = ctx(2, {"sensor.a": [bucket(0, mean=None, count=0, covered=0), bucket(H, mean=5)]}, kinds={"sensor.a": "measurement"})
    assert fx.evaluate("sensor.a * 2", c) == [None, 10]
    assert fx.evaluate("COALESCE(sensor.a, 0) * 2", c) == [0, 10]


def test_metric_references_and_cycles():
    ents = {"sensor.e": [bucket(0, delta=10)]}
    c = ctx(1, ents, constants={"p": (0.5, None)}, metrics={"kosten": "sensor.e * p", "kosten2": "kosten * 2"}, kinds={"sensor.e": "counter"})
    assert fx.evaluate("kosten2 + 1", c) == [11]
    c2 = ctx(1, ents, metrics={"a": "b + 1", "b": "a + 1"}, kinds={"sensor.e": "counter"})
    with pytest.raises(fx.FormulaError, match="Zirkelbezug"):
        fx.evaluate("a", c2)


@pytest.mark.parametrize("src,msg", [
    ("", "leer"),
    ("1 +", "endet unerwartet"),
    ("(1 + 2", "Klammer"),
    ("FOO(1)", "Unbekannte Funktion"),
    ("ROUND()", "erwartet"),
    ("7d + 1", "Zeitraum"),
    ("AVG(7d, sensor.x)", "Zeitraum"),
    ("1 $ 2", "Unerwartetes Zeichen"),
    ("LAST(5)", "Entität"),
])
def test_invalid_formulas_have_clear_messages(src, msg):
    with pytest.raises(fx.FormulaError) as ei:
        fx.analyze(fx.parse(src))
    assert msg in ei.value.message


def test_validate_unknown_names_and_units():
    res = fx.validate("sensor.e * preis", known_entities=lambda e: e == "sensor.e", constants={"preis": (0.3, "€/kWh")},
                      metrics={}, entity_unit=lambda e: "kWh")
    assert res.ok and res.unit == "€"
    bad = fx.validate("sensor.x * preis", known_entities=lambda e: False, constants={}, metrics={}, entity_unit=lambda e: None)
    assert not bad.ok and "Unbekannte Entität" in bad.error["message"]
    warn = fx.validate("sensor.e + sensor.t", known_entities=lambda e: True, constants={}, metrics={},
                       entity_unit=lambda e: {"sensor.e": "kWh", "sensor.t": "°C"}[e])
    assert warn.ok and warn.warnings


def test_validate_detects_cycle_with_self_key():
    res = fx.validate("b * 2", known_entities=lambda e: True, constants={}, metrics={"b": "a + 1"},
                      entity_unit=lambda e: None, self_key="a")
    assert not res.ok and "Zirkelbezug" in res.error["message"]


def test_dependencies_transitive():
    ents, lb_s, lb_b, td = fx.dependencies("x + 1", {"x": "AVG(sensor.t, 7d)", "y": "sensor.z"}, {})
    assert ents == {"sensor.t"} and lb_s == 7 * 86400 and td


def test_no_code_execution_possible():
    for evil in ["__import__('os')", "().__class__", "open('x')", "lambda: 1", "sensor.a.__dict__"]:
        with pytest.raises(fx.FormulaError):
            fx.analyze(fx.parse(evil))


def test_integral_power_to_energy():
    ents = {"sensor.p": [bucket(0, mean=1000, covered=1800)]}
    c = ctx(1, ents, kinds={"sensor.p": "measurement"})
    assert fx.evaluate("INTEGRAL(sensor.p) / 1000", c) == [0.5]


def test_time_functions():
    c = ctx(2)
    assert fx.evaluate("HOURS()", c) == [1.0, 1.0]
    assert fx.evaluate("HOUR()", c) == [0.0, 1.0]


def test_virtual_attribute_entities_in_formulas():
    ents = {"climate.buro::temperature": [bucket(0, mean=21.0)], "sensor.buro": [bucket(0, mean=20.2)]}
    c = ctx(1, ents, kinds={"climate.buro::temperature": "measurement", "sensor.buro": "measurement"})
    assert fx.evaluate("sensor.buro - climate.buro::temperature", c) == [pytest.approx(-0.8)]
    assert fx.evaluate("{climate.buro::temperature} + 1", c) == [22.0]
