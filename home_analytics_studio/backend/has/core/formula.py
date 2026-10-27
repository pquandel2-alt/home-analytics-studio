"""Safe formula language for computed metrics.

No Python ``eval`` is used: formulas are tokenised and parsed by a small
recursive-descent parser into an AST which is evaluated by an interpreter that
only knows the operations defined here.

Language overview
-----------------
* numbers: ``12``, ``0.5``, ``1e3``
* entities: ``sensor.house_energy`` (anything ``domain.object_id``) or
  ``{sensor.house_energy}``. Inside a time bucket an entity yields its
  *natural* value: consumption (delta) for meters/counters, the time weighted
  mean for momentary values.
* constants and other metrics: plain identifiers, e.g. ``strompreis``
* durations (only as function arguments): ``30min``, ``24h``, ``7d``, ``4w``, ``1y``
* operators: ``+ - * / ^ %`` comparisons ``< <= > >= == !=`` logic ``and or not``
* functions: see FUNCTIONS below (case-insensitive)

Evaluation works on aligned series of time buckets. A ``None`` value means
"no data" and propagates through arithmetic; division by zero also yields
``None`` instead of an error.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Sequence

from .timeutil import APPROX_SECONDS, parse_duration

Value = list  # list[float | None]


class FormulaError(Exception):
    def __init__(self, message: str, pos: int | None = None):
        super().__init__(message)
        self.message = message
        self.pos = pos

    def as_dict(self) -> dict:
        return {"message": self.message, "pos": self.pos}


# ============================================================================ tokenizer

@dataclass
class Token:
    kind: str  # num | dur | ent | ident | op | lparen | rparen | comma | eof
    value: Any
    pos: int


_TOKEN_RE = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<dur>\d+(?:\.\d+)?(?:min|mo|[smhdwy])(?![A-Za-z0-9_]))
  | (?P<num>(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)
  | (?P<bent>\{\s*[a-z_][a-z0-9_]*\.[a-z0-9_]+(?:::[a-z_]+)?\s*\})
  | (?P<ent>[a-z_][a-z0-9_]*\.[a-z0-9_]+(?:::[a-z_]+)?)
  | (?P<ident>[A-Za-z_À-ɏ][A-Za-z0-9_À-ɏ]*)
  | (?P<op><=|>=|==|!=|&&|\|\||[-+*/^%<>!])
  | (?P<lparen>\()
  | (?P<rparen>\))
  | (?P<comma>[,;])
    """,
    re.VERBOSE,
)


def tokenize(src: str) -> list[Token]:
    tokens: list[Token] = []
    pos = 0
    while pos < len(src):
        m = _TOKEN_RE.match(src, pos)
        if not m:
            raise FormulaError(f"Unerwartetes Zeichen '{src[pos]}' an Position {pos + 1}", pos)
        kind = m.lastgroup
        text = m.group(kind)
        if kind == "ws":
            pass
        elif kind == "num":
            tokens.append(Token("num", float(text), pos))
        elif kind == "dur":
            tokens.append(Token("dur", parse_duration(text), pos))
        elif kind == "bent":
            tokens.append(Token("ent", text.strip("{} \t"), pos))
        elif kind == "ent":
            tokens.append(Token("ent", text, pos))
        elif kind == "ident":
            low = text.lower()
            if low in ("and", "or", "not"):
                tokens.append(Token("op", low, pos))
            elif low in ("true", "false"):
                tokens.append(Token("num", 1.0 if low == "true" else 0.0, pos))
            else:
                tokens.append(Token("ident", text, pos))
        elif kind == "op":
            tokens.append(Token("op", {"&&": "and", "||": "or", "!": "not"}.get(text, text), pos))
        else:
            tokens.append(Token(kind, text, pos))
        pos = m.end()
    tokens.append(Token("eof", None, len(src)))
    return tokens


# ============================================================================ AST

@dataclass
class Node:
    pos: int


@dataclass
class Num(Node):
    value: float


@dataclass
class Dur(Node):
    seconds: int


@dataclass
class EntityRef(Node):
    entity_id: str


@dataclass
class NameRef(Node):
    name: str


@dataclass
class Unary(Node):
    op: str
    operand: Node


@dataclass
class Binary(Node):
    op: str
    left: Node
    right: Node


@dataclass
class Call(Node):
    name: str
    args: list[Node] = field(default_factory=list)


class Parser:
    """Precedence (low -> high): or, and, not, comparison, + -, * / %, unary -, ^"""

    def __init__(self, src: str):
        self.src = src
        self.tokens = tokenize(src)
        self.i = 0

    def peek(self) -> Token:
        return self.tokens[self.i]

    def next(self) -> Token:
        tok = self.tokens[self.i]
        self.i += 1
        return tok

    def accept_op(self, *ops: str) -> Token | None:
        tok = self.peek()
        if tok.kind == "op" and tok.value in ops:
            self.i += 1
            return tok
        return None

    def parse(self) -> Node:
        if self.peek().kind == "eof":
            raise FormulaError("Die Formel ist leer", 0)
        node = self.parse_or()
        tok = self.peek()
        if tok.kind != "eof":
            raise FormulaError(f"Unerwartetes '{self._show(tok)}' an Position {tok.pos + 1}", tok.pos)
        return node

    def _show(self, tok: Token) -> str:
        if tok.kind == "eof":
            return "Ende der Formel"
        return str(tok.value) if tok.kind != "dur" else self.src[tok.pos:].split()[0]

    def parse_or(self) -> Node:
        node = self.parse_and()
        while (tok := self.accept_op("or")):
            node = Binary(tok.pos, "or", node, self.parse_and())
        return node

    def parse_and(self) -> Node:
        node = self.parse_not()
        while (tok := self.accept_op("and")):
            node = Binary(tok.pos, "and", node, self.parse_not())
        return node

    def parse_not(self) -> Node:
        if (tok := self.accept_op("not")):
            return Unary(tok.pos, "not", self.parse_not())
        return self.parse_cmp()

    def parse_cmp(self) -> Node:
        node = self.parse_add()
        while (tok := self.accept_op("<", "<=", ">", ">=", "==", "!=")):
            node = Binary(tok.pos, tok.value, node, self.parse_add())
        return node

    def parse_add(self) -> Node:
        node = self.parse_mul()
        while (tok := self.accept_op("+", "-")):
            node = Binary(tok.pos, tok.value, node, self.parse_mul())
        return node

    def parse_mul(self) -> Node:
        node = self.parse_unary()
        while (tok := self.accept_op("*", "/", "%")):
            node = Binary(tok.pos, tok.value, node, self.parse_unary())
        return node

    def parse_unary(self) -> Node:
        if (tok := self.accept_op("-")):
            return Unary(tok.pos, "-", self.parse_unary())
        if self.accept_op("+"):
            return self.parse_unary()
        return self.parse_pow()

    def parse_pow(self) -> Node:
        base = self.parse_atom()
        if (tok := self.accept_op("^")):
            return Binary(tok.pos, "^", base, self.parse_unary())  # right assoc
        return base

    def parse_atom(self) -> Node:
        tok = self.next()
        if tok.kind == "num":
            return Num(tok.pos, tok.value)
        if tok.kind == "dur":
            return Dur(tok.pos, tok.value)
        if tok.kind == "ent":
            return EntityRef(tok.pos, tok.value)
        if tok.kind == "ident":
            if self.peek().kind == "lparen":
                self.next()
                args: list[Node] = []
                if self.peek().kind != "rparen":
                    while True:
                        args.append(self.parse_or())
                        if self.peek().kind == "comma":
                            self.next()
                            continue
                        break
                close = self.next()
                if close.kind != "rparen":
                    raise FormulaError(
                        f"')' erwartet für Funktion {tok.value}, gefunden '{self._show(close)}' (Position {close.pos + 1})",
                        close.pos)
                return Call(tok.pos, tok.value.upper(), args)
            return NameRef(tok.pos, tok.value)
        if tok.kind == "lparen":
            node = self.parse_or()
            close = self.next()
            if close.kind != "rparen":
                raise FormulaError(f"Fehlende schließende Klammer (Position {close.pos + 1})", close.pos)
            return node
        if tok.kind == "eof":
            raise FormulaError("Formel endet unerwartet – fehlt ein Wert?", tok.pos)
        raise FormulaError(f"Unerwartetes '{self._show(tok)}' an Position {tok.pos + 1}", tok.pos)


def parse(src: str) -> Node:
    return Parser(src or "").parse()


# ============================================================================ function table

@dataclass(frozen=True)
class FuncSpec:
    min_args: int
    max_args: int | None
    description: str
    signature: str
    category: str


FUNCTIONS: dict[str, FuncSpec] = {
    # aggregation (overloaded, see evaluator)
    "SUM": FuncSpec(1, None, "Summe: SUM(x, 7d) gleitende Summe; SUM(a, b, …) Summe mehrerer Werte", "SUM(x[, Zeitraum])", "Aggregation"),
    "AVG": FuncSpec(1, None, "Durchschnitt: AVG(Entität) zeitgewichtet; AVG(x, 7d) gleitend; AVG(a, b, …)", "AVG(x[, Zeitraum])", "Aggregation"),
    "MEAN": FuncSpec(1, None, "Alias für AVG", "MEAN(x[, Zeitraum])", "Aggregation"),
    "MIN": FuncSpec(1, None, "Minimum: MIN(Entität) im Abschnitt; MIN(x, 7d) gleitend; MIN(a, b, …)", "MIN(x[, Zeitraum])", "Aggregation"),
    "MAX": FuncSpec(1, None, "Maximum: MAX(Entität) im Abschnitt; MAX(x, 7d) gleitend; MAX(a, b, …)", "MAX(x[, Zeitraum])", "Aggregation"),
    "COUNT": FuncSpec(1, 2, "Anzahl: COUNT(Entität) Messwerte; COUNT(x, 7d) Abschnitte mit Daten", "COUNT(x[, Zeitraum])", "Aggregation"),
    "FIRST": FuncSpec(1, 1, "Erster Messwert im Abschnitt", "FIRST(Entität)", "Aggregation"),
    "LAST": FuncSpec(1, 1, "Letzter Messwert im Abschnitt (z. B. Zählerstand)", "LAST(Entität)", "Aggregation"),
    "DELTA": FuncSpec(1, 1, "Verbrauch/Änderung im Abschnitt (Zähler: resetsicher)", "DELTA(Entität)", "Aggregation"),
    "COVERAGE": FuncSpec(1, 1, "Datenabdeckung des Abschnitts (0–1)", "COVERAGE(Entität)", "Aggregation"),
    "INTEGRAL": FuncSpec(1, 1, "Zeitintegral (Mittelwert × Stunden), z. B. W → Wh", "INTEGRAL(x)", "Zeit"),
    "DIFFERENCE": FuncSpec(1, 2, "Differenz zum vorherigen Abschnitt bzw. zu x vor Zeitraum", "DIFFERENCE(x[, Zeitraum])", "Vergleich"),
    "CHANGE_PCT": FuncSpec(1, 2, "Prozentuale Änderung zum vorherigen Abschnitt / vor Zeitraum", "CHANGE_PCT(x[, Zeitraum])", "Vergleich"),
    "PERCENT": FuncSpec(2, 2, "Anteil in Prozent: a / b × 100", "PERCENT(a, b)", "Vergleich"),
    "MOVING_AVG": FuncSpec(2, 2, "Gleitender Durchschnitt über Zeitraum oder Anzahl Abschnitte", "MOVING_AVG(x, 7d)", "Zeit"),
    "CUMSUM": FuncSpec(1, 1, "Laufende Summe über den Zeitraum", "CUMSUM(x)", "Zeit"),
    "PREV": FuncSpec(1, 2, "Wert des vorherigen Abschnitts bzw. vor Zeitraum", "PREV(x[, Zeitraum])", "Zeit"),
    "IF": FuncSpec(3, 3, "Bedingung: IF(Bedingung, dann, sonst)", "IF(cond, a, b)", "Logik"),
    "COALESCE": FuncSpec(1, None, "Erster vorhandene Wert (Ersatz für fehlende Daten)", "COALESCE(a, b, …)", "Logik"),
    "ISNULL": FuncSpec(1, 1, "1 wenn kein Wert vorhanden, sonst 0", "ISNULL(x)", "Logik"),
    "ABS": FuncSpec(1, 1, "Betrag", "ABS(x)", "Mathematik"),
    "ROUND": FuncSpec(1, 2, "Runden auf n Stellen", "ROUND(x[, n])", "Mathematik"),
    "FLOOR": FuncSpec(1, 1, "Abrunden", "FLOOR(x)", "Mathematik"),
    "CEIL": FuncSpec(1, 1, "Aufrunden", "CEIL(x)", "Mathematik"),
    "SQRT": FuncSpec(1, 1, "Quadratwurzel", "SQRT(x)", "Mathematik"),
    "POW": FuncSpec(2, 2, "Potenz", "POW(x, y)", "Mathematik"),
    "LOG": FuncSpec(1, 2, "Logarithmus (Basis e oder angegeben)", "LOG(x[, basis])", "Mathematik"),
    "EXP": FuncSpec(1, 1, "e hoch x", "EXP(x)", "Mathematik"),
    "CLAMP": FuncSpec(3, 3, "Begrenzen auf [min, max]", "CLAMP(x, min, max)", "Mathematik"),
    "NONNEG": FuncSpec(1, 1, "Negative Werte auf 0 setzen", "NONNEG(x)", "Mathematik"),
    "HOURS": FuncSpec(0, 0, "Länge des Abschnitts in Stunden", "HOURS()", "Zeit"),
    "HOUR": FuncSpec(0, 0, "Stunde (0–23) des Abschnittsbeginns", "HOUR()", "Zeit"),
    "WEEKDAY": FuncSpec(0, 0, "Wochentag (1 = Montag … 7 = Sonntag)", "WEEKDAY()", "Zeit"),
    "DAY": FuncSpec(0, 0, "Tag des Monats", "DAY()", "Zeit"),
    "MONTH": FuncSpec(0, 0, "Monat (1–12)", "MONTH()", "Zeit"),
}

ENTITY_SELECTORS = {"FIRST": "first", "LAST": "last", "DELTA": "delta", "COVERAGE": "coverage"}
WINDOW_FUNCS = {"SUM", "AVG", "MEAN", "MIN", "MAX", "COUNT", "MOVING_AVG"}
LAG_FUNCS = {"DIFFERENCE", "CHANGE_PCT", "PREV"}


# ============================================================================ analysis

@dataclass
class Analysis:
    entities: set[str] = field(default_factory=set)
    names: set[str] = field(default_factory=set)
    lookback_seconds: int = 0
    lookback_buckets: int = 0
    time_dependent: bool = False  # uses windows/lags/cumsum -> per-bucket evaluation needed


def analyze(node: Node) -> Analysis:
    a = Analysis()

    def visit(n: Node) -> None:
        if isinstance(n, EntityRef):
            a.entities.add(n.entity_id)
        elif isinstance(n, NameRef):
            a.names.add(n.name)
        elif isinstance(n, Unary):
            visit(n.operand)
        elif isinstance(n, Binary):
            visit(n.left)
            visit(n.right)
        elif isinstance(n, Call):
            if n.name not in FUNCTIONS:
                raise FormulaError(f"Unbekannte Funktion '{n.name}'", n.pos)
            spec = FUNCTIONS[n.name]
            if len(n.args) < spec.min_args or (spec.max_args is not None and len(n.args) > spec.max_args):
                expected = (f"{spec.min_args}" if spec.max_args == spec.min_args
                            else f"{spec.min_args}–{spec.max_args}" if spec.max_args else f"mindestens {spec.min_args}")
                raise FormulaError(f"{n.name} erwartet {expected} Argument(e), erhalten {len(n.args)}. Syntax: {spec.signature}", n.pos)
            durs = [x for x in n.args if isinstance(x, Dur)]
            if durs:
                if n.name not in WINDOW_FUNCS | LAG_FUNCS:
                    raise FormulaError(f"{n.name} akzeptiert keinen Zeitraum", durs[0].pos)
                if not isinstance(n.args[-1], Dur) or len(durs) > 1 or len(n.args) != 2:
                    raise FormulaError(f"Zeitraum muss das zweite und letzte Argument von {n.name} sein", durs[0].pos)
                a.lookback_seconds = max(a.lookback_seconds, durs[0].seconds)
                a.time_dependent = True
            if n.name == "MOVING_AVG" and len(n.args) == 2 and not isinstance(n.args[1], (Dur, Num)):
                raise FormulaError("MOVING_AVG erwartet als zweites Argument einen Zeitraum (z. B. 7d) oder eine Anzahl", n.pos)
            if n.name == "MOVING_AVG" and isinstance(n.args[1], Num):
                a.lookback_buckets = max(a.lookback_buckets, int(n.args[1].value))
                a.time_dependent = True
            if n.name in LAG_FUNCS:
                a.time_dependent = True
                a.lookback_buckets = max(a.lookback_buckets, 1)
            if n.name == "CUMSUM":
                a.time_dependent = True
            if n.name in ENTITY_SELECTORS and not isinstance(n.args[0], EntityRef):
                raise FormulaError(f"{n.name} erwartet eine Entität als Argument", n.pos)
            for arg in n.args:
                visit(arg)
        elif isinstance(n, Dur):
            pass  # validated at call level

    visit(node)

    def check_dur(n: Node, allowed: bool) -> None:
        if isinstance(n, Dur) and not allowed:
            raise FormulaError("Ein Zeitraum (z. B. 7d) ist nur als Funktionsargument erlaubt", n.pos)
        if isinstance(n, Unary):
            check_dur(n.operand, False)
        elif isinstance(n, Binary):
            check_dur(n.left, False)
            check_dur(n.right, False)
        elif isinstance(n, Call):
            for arg in n.args:
                check_dur(arg, True)

    check_dur(node, False)
    return a


# ============================================================================ units

def parse_unit(unit: str | None) -> dict[str, int]:
    if not unit:
        return {}
    out: dict[str, int] = {}
    parts = re.split(r"(/|\*|·)", unit.replace(" ", ""))
    sign = 1
    for p in parts:
        if p == "/":
            sign = -1
            continue
        if p in ("*", "·") or not p:
            continue
        m = re.match(r"^(.+?)(\^?(-?\d+)|²|³)?$", p)
        base, exp = p, 1
        if m:
            base = m.group(1)
            if m.group(2) == "²":
                exp = 2
            elif m.group(2) == "³" and base != "m":
                exp = 3
            elif m.group(3):
                exp = int(m.group(3))
            if m.group(2) == "³" and base == "m":
                base, exp = "m³", 1
        out[base] = out.get(base, 0) + sign * exp
        if out[base] == 0:
            del out[base]
    return out


def format_unit(u: dict[str, int] | None) -> str | None:
    if u is None:
        return None
    if not u:
        return ""
    num = [k if e == 1 else f"{k}^{e}" for k, e in u.items() if e > 0]
    den = [k if e == -1 else f"{k}^{-e}" for k, e in u.items() if e < 0]
    s = "·".join(num) or "1"
    if den:
        s += "/" + "/".join(den)
    return s


def _unit_mul(a: dict | None, b: dict | None, sign: int = 1) -> dict | None:
    if a is None or b is None:
        return None
    out = dict(a)
    for k, e in b.items():
        out[k] = out.get(k, 0) + sign * e
        if out[k] == 0:
            del out[k]
    return out


# ============================================================================ evaluation

@dataclass
class Bucket:
    ts: int
    end: int


@dataclass
class EvalContext:
    edges: list[int]
    tz: Any
    interval: str | None
    entity_loader: Callable[[str, list[int]], list[Any]]  # -> list[BucketStats]
    entity_kind: Callable[[str], str | None]
    entity_unit: Callable[[str], str | None]
    constants: dict[str, tuple[float, str | None]]
    metrics: dict[str, str]  # key -> formula
    metric_units: dict[str, str | None] = field(default_factory=dict)
    _entity_cache: dict[str, list[Any]] = field(default_factory=dict)
    _metric_cache: dict[str, Value] = field(default_factory=dict)
    _stack: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def n(self) -> int:
        return len(self.edges) - 1

    def buckets_for(self, entity_id: str) -> list[Any]:
        if entity_id not in self._entity_cache:
            self._entity_cache[entity_id] = self.entity_loader(entity_id, self.edges)
        return self._entity_cache[entity_id]

    def bucket_seconds(self) -> float:
        if self.interval and self.interval in APPROX_SECONDS:
            return APPROX_SECONDS[self.interval]
        if self.n:
            return (self.edges[-1] - self.edges[0]) / self.n
        return 3600


def _const(v: float | None, n: int) -> Value:
    return [v] * n


def _bin(op: Callable[[float, float], float | None], a: Value, b: Value) -> Value:
    out = []
    for x, y in zip(a, b):
        if x is None or y is None:
            out.append(None)
        else:
            try:
                r = op(x, y)
            except (ZeroDivisionError, OverflowError, ValueError):
                r = None
            out.append(None if r is None or (isinstance(r, float) and not math.isfinite(r)) else r)
    return out


def _map(fn: Callable[[float], float | None], a: Value) -> Value:
    out = []
    for x in a:
        if x is None:
            out.append(None)
            continue
        try:
            r = fn(x)
        except (ZeroDivisionError, OverflowError, ValueError):
            r = None
        out.append(None if r is None or (isinstance(r, float) and not math.isfinite(r)) else r)
    return out


def _div(x: float, y: float) -> float | None:
    return None if y == 0 else x / y


_BINOPS: dict[str, Callable[[float, float], Any]] = {
    "+": lambda x, y: x + y,
    "-": lambda x, y: x - y,
    "*": lambda x, y: x * y,
    "/": _div,
    "%": lambda x, y: None if y == 0 else math.fmod(x, y),
    "^": lambda x, y: math.pow(x, y),
    "<": lambda x, y: 1.0 if x < y else 0.0,
    "<=": lambda x, y: 1.0 if x <= y else 0.0,
    ">": lambda x, y: 1.0 if x > y else 0.0,
    ">=": lambda x, y: 1.0 if x >= y else 0.0,
    "==": lambda x, y: 1.0 if abs(x - y) < 1e-12 else 0.0,
    "!=": lambda x, y: 0.0 if abs(x - y) < 1e-12 else 1.0,
}


class Evaluator:
    def __init__(self, ctx: EvalContext):
        self.ctx = ctx

    def eval(self, node: Node) -> Value:
        n = self.ctx.n
        if isinstance(node, Num):
            return _const(node.value, n)
        if isinstance(node, EntityRef):
            return self._entity_natural(node)
        if isinstance(node, NameRef):
            return self._name(node)
        if isinstance(node, Unary):
            v = self.eval(node.operand)
            if node.op == "-":
                return _map(lambda x: -x, v)
            return _map(lambda x: 0.0 if x else 1.0, v)
        if isinstance(node, Binary):
            left = self.eval(node.left)
            right = self.eval(node.right)
            if node.op == "and":
                return [None if a is None or b is None else (1.0 if a and b else 0.0) for a, b in zip(left, right)]
            if node.op == "or":
                return [None if a is None and b is None else (1.0 if (a or 0) or (b or 0) else 0.0) for a, b in zip(left, right)]
            return _bin(_BINOPS[node.op], left, right)
        if isinstance(node, Call):
            return self._call(node)
        if isinstance(node, Dur):
            raise FormulaError("Zeitraum an dieser Stelle nicht erlaubt", node.pos)
        raise FormulaError("Unbekannter Ausdruck", node.pos)

    # -------------------------------------------------------------- references

    def _entity_field(self, node: EntityRef, fld: str) -> Value:
        try:
            buckets = self.ctx.buckets_for(node.entity_id)
        except KeyError as err:
            raise FormulaError(f"Unbekannte Entität '{node.entity_id}'", node.pos) from err
        if fld == "coverage":
            return [b.coverage if (b.covered or b.count) else 0.0 for b in buckets]
        if fld == "count":
            return [float(b.count) for b in buckets]
        return [getattr(b, fld) for b in buckets]

    def _entity_natural(self, node: EntityRef) -> Value:
        kind = self.ctx.entity_kind(node.entity_id)
        if kind is None:
            raise FormulaError(f"Unbekannte Entität '{node.entity_id}'", node.pos)
        return self._entity_field(node, "mean" if kind == "measurement" else "delta")

    def _name(self, node: NameRef) -> Value:
        name = node.name
        if name in self.ctx.constants:
            return _const(self.ctx.constants[name][0], self.ctx.n)
        if name in self.ctx.metrics:
            if name in self.ctx._metric_cache:
                return self.ctx._metric_cache[name]
            if name in self.ctx._stack:
                chain = " → ".join(self.ctx._stack + [name])
                raise FormulaError(f"Zirkelbezug zwischen Kennzahlen: {chain}", node.pos)
            self.ctx._stack.append(name)
            try:
                sub = parse(self.ctx.metrics[name])
                analyze(sub)
                value = self.eval(sub)
            except FormulaError as err:
                if "Zirkelbezug" in err.message:
                    raise
                raise FormulaError(f"Fehler in Kennzahl '{name}': {err.message}", node.pos) from err
            finally:
                self.ctx._stack.pop()
            self.ctx._metric_cache[name] = value
            return value
        raise FormulaError(f"Unbekannter Name '{name}' (keine Konstante oder Kennzahl)", node.pos)

    # -------------------------------------------------------------- functions

    def _window(self, seconds_or_count: Node) -> int:
        if isinstance(seconds_or_count, Dur):
            return max(1, int(round(seconds_or_count.seconds / self.ctx.bucket_seconds())))
        if isinstance(seconds_or_count, Num):
            return max(1, int(seconds_or_count.value))
        raise FormulaError("Zeitraum erwartet", seconds_or_count.pos)

    def _rolling(self, values: Value, window: int, agg: Callable[[list[float]], float | None]) -> Value:
        out: Value = []
        for i in range(len(values)):
            win = [v for v in values[max(0, i - window + 1): i + 1] if v is not None]
            out.append(agg(win) if win else None)
        return out

    def _call(self, node: Call) -> Value:
        name = node.name
        args = node.args
        n = self.ctx.n
        has_dur = len(args) == 2 and isinstance(args[1], Dur)
        # --- overloaded aggregations
        if name in ("SUM", "AVG", "MEAN", "MIN", "MAX"):
            agg: dict[str, Callable[[list[float]], float]] = {
                "SUM": sum, "AVG": lambda w: sum(w) / len(w), "MEAN": lambda w: sum(w) / len(w), "MIN": min, "MAX": max,
            }
            fn = agg[name]
            if has_dur:
                return self._rolling(self.eval(args[0]), self._window(args[1]), fn)
            if len(args) == 1:
                if isinstance(args[0], EntityRef) and name in ("MIN", "MAX", "AVG", "MEAN"):
                    return self._entity_field(args[0], {"MIN": "min", "MAX": "max"}.get(name, "mean"))
                return self.eval(args[0])
            series = [self.eval(a) for a in args]
            out: Value = []
            for i in range(n):
                vals = [s[i] for s in series if s[i] is not None]
                out.append(fn(vals) if vals else None)
            return out
        if name == "COUNT":
            if has_dur:
                vals = self.eval(args[0])
                return self._rolling([1.0 if v is not None else None for v in vals], self._window(args[1]), lambda w: float(len(w)))
            if isinstance(args[0], EntityRef):
                return self._entity_field(args[0], "count")
            return [0.0 if v is None else 1.0 for v in self.eval(args[0])]
        if name in ENTITY_SELECTORS:
            return self._entity_field(args[0], ENTITY_SELECTORS[name])
        if name == "MOVING_AVG":
            return self._rolling(self.eval(args[0]), self._window(args[1]), lambda w: sum(w) / len(w))
        if name in LAG_FUNCS:
            vals = self.eval(args[0])
            lag = self._window(args[1]) if len(args) == 2 else 1
            prev = [None] * min(lag, n) + vals[: max(0, n - lag)]
            if name == "PREV":
                return prev
            if name == "DIFFERENCE":
                return _bin(lambda x, y: x - y, vals, prev)
            return _bin(lambda x, y: None if y == 0 else (x - y) / abs(y) * 100.0, vals, prev)
        if name == "PERCENT":
            return _bin(lambda x, y: None if y == 0 else x / y * 100.0, self.eval(args[0]), self.eval(args[1]))
        if name == "CUMSUM":
            total = 0.0
            out = []
            for v in self.eval(args[0]):
                if v is not None:
                    total += v
                out.append(total)
            return out
        if name == "INTEGRAL":
            vals = self.eval(args[0])
            if isinstance(args[0], EntityRef):
                cov = self._entity_field(args[0], "covered")
                return [None if v is None else v * (c or 0) / 3600.0 for v, c in zip(vals, cov)]
            return [None if v is None else v * (self.ctx.edges[i + 1] - self.ctx.edges[i]) / 3600.0 for i, v in enumerate(vals)]
        if name == "IF":
            cond, a, b = (self.eval(x) for x in args)
            return [None if c is None else (x if c else y) for c, x, y in zip(cond, a, b)]
        if name == "COALESCE":
            series = [self.eval(a) for a in args]
            return [next((s[i] for s in series if s[i] is not None), None) for i in range(n)]
        if name == "ISNULL":
            return [1.0 if v is None else 0.0 for v in self.eval(args[0])]
        if name == "ABS":
            return _map(abs, self.eval(args[0]))
        if name == "ROUND":
            digits = int(args[1].value) if len(args) == 2 and isinstance(args[1], Num) else 0
            return _map(lambda x: round(x, digits), self.eval(args[0]))
        if name == "FLOOR":
            return _map(lambda x: float(math.floor(x)), self.eval(args[0]))
        if name == "CEIL":
            return _map(lambda x: float(math.ceil(x)), self.eval(args[0]))
        if name == "SQRT":
            return _map(lambda x: math.sqrt(x) if x >= 0 else None, self.eval(args[0]))
        if name == "POW":
            return _bin(lambda x, y: math.pow(x, y), self.eval(args[0]), self.eval(args[1]))
        if name == "LOG":
            if len(args) == 2:
                return _bin(lambda x, b: math.log(x, b) if x > 0 and b > 0 and b != 1 else None,
                            self.eval(args[0]), self.eval(args[1]))
            return _map(lambda x: math.log(x) if x > 0 else None, self.eval(args[0]))
        if name == "EXP":
            return _map(math.exp, self.eval(args[0]))
        if name == "CLAMP":
            x, lo, hi = (self.eval(a) for a in args)
            return [None if v is None or l is None or h is None else max(l, min(h, v)) for v, l, h in zip(x, lo, hi)]
        if name == "NONNEG":
            return _map(lambda x: max(0.0, x), self.eval(args[0]))
        if name == "HOURS":
            return [(self.ctx.edges[i + 1] - self.ctx.edges[i]) / 3600.0 for i in range(n)]
        if name in ("HOUR", "WEEKDAY", "DAY", "MONTH"):
            out = []
            for i in range(n):
                dt = datetime.fromtimestamp(self.ctx.edges[i], self.ctx.tz)
                out.append(float({"HOUR": dt.hour, "WEEKDAY": dt.isoweekday(), "DAY": dt.day, "MONTH": dt.month}[name]))
            return out
        raise FormulaError(f"Unbekannte Funktion '{name}'", node.pos)


# ============================================================================ unit inference

def infer_unit(node: Node, entity_unit: Callable[[str], str | None], constants: dict[str, tuple[float, str | None]],
               metric_units: dict[str, str | None], warnings: list[str]) -> dict | None:
    """Best-effort dimensional analysis. Returns parsed unit dict or None (unknown)."""

    def u(n: Node) -> dict | None:
        if isinstance(n, Num):
            return {}
        if isinstance(n, EntityRef):
            return parse_unit(entity_unit(n.entity_id))
        if isinstance(n, NameRef):
            if n.name in constants:
                return parse_unit(constants[n.name][1])
            if n.name in metric_units:
                return parse_unit(metric_units[n.name])
            return None
        if isinstance(n, Unary):
            return u(n.operand) if n.op == "-" else {}
        if isinstance(n, Binary):
            a, b = u(n.left), u(n.right)
            if n.op in ("+", "-"):
                if a is not None and b is not None and a != b and a and b:
                    warnings.append(f"Einheiten passen nicht zusammen: {format_unit(a)} {n.op} {format_unit(b)}")
                return a if a else b
            if n.op == "*":
                return _unit_mul(a, b)
            if n.op == "/":
                return _unit_mul(a, b, -1)
            if n.op in ("%",):
                return a
            if n.op == "^":
                return {} if not a else None
            return {}
        if isinstance(n, Call):
            if n.name in ("PERCENT", "CHANGE_PCT"):
                return {"%": 1}
            if n.name in ("COUNT", "HOUR", "WEEKDAY", "DAY", "MONTH", "ISNULL", "COVERAGE"):
                return {}
            if n.name == "HOURS":
                return {"h": 1}
            if n.name == "INTEGRAL":
                return _unit_mul(u(n.args[0]), {"h": 1})
            if n.name == "IF":
                return u(n.args[1]) or u(n.args[2])
            if n.name in ("POW", "SQRT", "LOG", "EXP"):
                return None
            if n.args:
                return u(n.args[0])
            return {}
        return None

    return u(node)


# ============================================================================ public helpers

@dataclass
class ValidationResult:
    ok: bool
    error: dict | None = None
    entities: list[str] = field(default_factory=list)
    names: list[str] = field(default_factory=list)
    unit: str | None = None
    warnings: list[str] = field(default_factory=list)
    time_dependent: bool = False

    def as_dict(self) -> dict:
        return dict(self.__dict__)


def validate(src: str, *, known_entities: Callable[[str], bool], constants: dict[str, tuple[float, str | None]],
             metrics: dict[str, str], entity_unit: Callable[[str], str | None],
             metric_units: dict[str, str | None] | None = None, self_key: str | None = None) -> ValidationResult:
    try:
        node = parse(src)
        info = analyze(node)
        for e in sorted(info.entities):
            if not known_entities(e):
                raise FormulaError(f"Unbekannte Entität '{e}'", src.find(e))
        for name in sorted(info.names):
            if name not in constants and name not in metrics and name != self_key:
                raise FormulaError(f"Unbekannter Name '{name}' (keine Konstante oder Kennzahl)", src.find(name))
        # cycle detection through metric graph
        graph = dict(metrics)
        if self_key:
            graph[self_key] = src
        _check_cycles(self_key, graph, constants)
        warnings: list[str] = []
        unit = infer_unit(node, entity_unit, constants, metric_units or {}, warnings)
        return ValidationResult(True, None, sorted(info.entities), sorted(info.names), format_unit(unit), warnings,
                                info.time_dependent)
    except FormulaError as err:
        return ValidationResult(False, err.as_dict())


def _check_cycles(start: str | None, graph: dict[str, str], constants: dict) -> None:
    if not start:
        return
    path: list[str] = []

    def deps(key: str) -> set[str]:
        try:
            info = analyze(parse(graph[key]))
        except FormulaError:
            return set()
        return {n for n in info.names if n in graph and n not in constants}

    def dfs(key: str) -> None:
        if key in path:
            chain = " → ".join(path[path.index(key):] + [key])
            raise FormulaError(f"Zirkelbezug zwischen Kennzahlen: {chain}")
        path.append(key)
        for d in deps(key):
            dfs(d)
        path.pop()

    dfs(start)


def dependencies(src: str, metrics: dict[str, str], constants: dict) -> tuple[set[str], int, int, bool]:
    """Transitive entities, max lookback seconds/buckets and time dependency of a formula."""
    entities: set[str] = set()
    lookback_s = 0
    lookback_b = 0
    time_dep = False
    seen: set[str] = set()

    def walk(formula: str) -> None:
        nonlocal lookback_s, lookback_b, time_dep
        info = analyze(parse(formula))
        entities.update(info.entities)
        lookback_s = max(lookback_s, info.lookback_seconds)
        lookback_b = max(lookback_b, info.lookback_buckets)
        time_dep = time_dep or info.time_dependent
        for name in info.names:
            if name in metrics and name not in constants and name not in seen:
                seen.add(name)
                walk(metrics[name])

    walk(src)
    return entities, lookback_s, lookback_b, time_dep


def evaluate(src: str, ctx: EvalContext) -> Value:
    node = parse(src)
    analyze(node)
    return Evaluator(ctx).eval(node)


def aggregate(values: Sequence[float | None], how: str) -> float | None:
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    if how == "sum":
        return float(sum(vals))
    if how == "mean":
        return float(sum(vals) / len(vals))
    if how == "min":
        return float(min(vals))
    if how == "max":
        return float(max(vals))
    if how == "first":
        return float(vals[0])
    return float(vals[-1])  # last
