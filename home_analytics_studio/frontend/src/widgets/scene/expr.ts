/**
 * Tiny, safe expression evaluator for derived scene values (e.g. COP = heat / power).
 * Supports numbers, variable names, + - * / %, comparisons, && || !, parentheses and a few
 * functions. No property access, no calls into JavaScript – it never uses eval().
 *
 * Missing values are null: arithmetic with null gives null, min/max ignore nulls,
 * coalesce() returns its first non-null argument. If none of the referenced variables
 * has a value the whole expression is null (nothing configured → nothing shown).
 */

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string }

const OPS = ['>=', '<=', '==', '!=', '&&', '||', '+', '-', '*', '/', '%', '>', '<', '(', ')', ',', '!']

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const num = /^(\d+(\.\d+)?|\.\d+)/.exec(src.slice(i))
    if (num) {
      out.push({ t: 'num', v: parseFloat(num[0]) })
      i += num[0].length
      continue
    }
    const id = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i))
    if (id) {
      out.push({ t: 'id', v: id[0] })
      i += id[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new Error(`Unerwartetes Zeichen „${c}“`)
    out.push({ t: 'op', v: op })
    i += op.length
  }
  return out
}

type Node =
  | { k: 'num'; v: number | null }
  | { k: 'var'; name: string }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] }

const PREC: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '>': 4, '<': 4, '>=': 4, '<=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 }

const FUNCS: Record<string, (args: (number | null)[]) => number | null> = {
  min: (a) => (a.some((x) => x != null) ? Math.min(...(a.filter((x) => x != null) as number[])) : null),
  max: (a) => (a.some((x) => x != null) ? Math.max(...(a.filter((x) => x != null) as number[])) : null),
  abs: ([a]) => (a == null ? null : Math.abs(a)),
  round: ([a, d]) => (a == null ? null : Math.round(a * 10 ** (d ?? 0)) / 10 ** (d ?? 0)),
  clamp: ([a, lo, hi]) => (a == null || lo == null || hi == null ? null : Math.min(hi, Math.max(lo, a))),
  coalesce: (a) => a.find((x) => x != null) ?? null,
}

export const EXPR_FUNCTIONS = [...Object.keys(FUNCS), 'if']

function parse(tokens: Tok[]): Node {
  let p = 0
  const peek = () => tokens[p]
  const isOp = (v: string) => peek()?.t === 'op' && peek().v === v
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`„${v}“ erwartet`)
    p++
  }
  const primary = (): Node => {
    const tk = peek()
    if (!tk) throw new Error('Ausdruck unvollständig')
    if (tk.t === 'num') {
      p++
      return { k: 'num', v: tk.v }
    }
    if (tk.t === 'id') {
      p++
      if (tk.v === 'null') return { k: 'num', v: null }
      if (isOp('(')) {
        p++
        const fn = tk.v.toLowerCase()
        if (fn !== 'if' && !FUNCS[fn]) throw new Error(`Unbekannte Funktion „${tk.v}“`)
        const args: Node[] = []
        if (!isOp(')')) {
          args.push(expr(0))
          while (isOp(',')) {
            p++
            args.push(expr(0))
          }
        }
        expect(')')
        if (fn === 'if' && args.length !== 3) throw new Error('if(Bedingung, dann, sonst) braucht 3 Werte')
        return { k: 'call', fn, args }
      }
      return { k: 'var', name: tk.v }
    }
    if (tk.v === '(') {
      p++
      const n = expr(0)
      expect(')')
      return n
    }
    if (tk.v === '-' || tk.v === '!' || tk.v === '+') {
      p++
      return { k: 'un', op: tk.v, a: primary() }
    }
    throw new Error(`Unerwartet: „${tk.v}“`)
  }
  const expr = (minPrec: number): Node => {
    let left = primary()
    for (;;) {
      const tk = peek()
      if (!tk || tk.t !== 'op' || !(tk.v in PREC) || PREC[tk.v] < minPrec) break
      p++
      const right = expr(PREC[tk.v] + 1)
      left = { k: 'bin', op: tk.v, a: left, b: right }
    }
    return left
  }
  const n = expr(0)
  if (p < tokens.length) throw new Error(`Unerwartet: „${(tokens[p] as any).v}“`)
  return n
}

const cache = new Map<string, Node>()

export function compile(src: string): Node {
  let n = cache.get(src)
  if (!n) {
    n = parse(tokenize(src))
    if (cache.size > 500) cache.clear()
    cache.set(src, n)
  }
  return n
}

/** Variable names referenced by an expression. */
export function exprVars(src: string): string[] {
  const out = new Set<string>()
  const walk = (n: Node) => {
    if (n.k === 'var') out.add(n.name)
    else if (n.k === 'un') walk(n.a)
    else if (n.k === 'bin') {
      walk(n.a)
      walk(n.b)
    } else if (n.k === 'call') n.args.forEach(walk)
  }
  try {
    walk(compile(src))
  } catch {
    /* invalid → no vars */
  }
  return [...out]
}

function ev(n: Node, scope: Record<string, number | null>): number | null {
  switch (n.k) {
    case 'num':
      return n.v
    case 'var':
      return scope[n.name] ?? null
    case 'un': {
      const a = ev(n.a, scope)
      if (a == null) return null
      return n.op === '-' ? -a : n.op === '!' ? (a ? 0 : 1) : a
    }
    case 'call': {
      if (n.fn === 'if') {
        const c = ev(n.args[0], scope)
        if (c == null) return null
        return ev(c ? n.args[1] : n.args[2], scope)
      }
      return FUNCS[n.fn](n.args.map((a) => ev(a, scope)))
    }
    case 'bin': {
      const a = ev(n.a, scope)
      const b = ev(n.b, scope)
      if (n.op === '&&') return a == null || b == null ? null : a && b ? 1 : 0
      if (n.op === '||') return a == null && b == null ? null : (a ?? 0) || (b ?? 0) ? 1 : 0
      if (a == null || b == null) return null
      switch (n.op) {
        case '+':
          return a + b
        case '-':
          return a - b
        case '*':
          return a * b
        case '/':
          return b === 0 ? null : a / b
        case '%':
          return b === 0 ? null : a % b
        case '>':
          return a > b ? 1 : 0
        case '<':
          return a < b ? 1 : 0
        case '>=':
          return a >= b ? 1 : 0
        case '<=':
          return a <= b ? 1 : 0
        case '==':
          return a === b ? 1 : 0
        case '!=':
          return a !== b ? 1 : 0
      }
      return null
    }
  }
}

/** Evaluates an expression; returns null for missing inputs or invalid expressions. */
export function evaluate(src: string, scope: Record<string, number | null>): number | null {
  let n: Node
  try {
    n = compile(src)
  } catch {
    return null
  }
  const used = exprVars(src)
  if (used.length && used.every((v) => scope[v] == null)) return null
  const r = ev(n, scope)
  return r == null || !Number.isFinite(r) ? null : r
}

/** Syntax check for the editor; returns an error message or null. */
export function exprError(src: string): string | null {
  try {
    compile(src)
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
