import { describe, expect, it } from 'vitest'
import { widgetEntities } from '../widgets/liveRefresh'
import { WIDGETS, widgetDef } from '../widgets/registry'
import { buildSrcdoc, computeScene, isLiveVar, sceneRequests, sceneVars, stateNumber } from '../widgets/scene/engine'
import { evaluate, exprError, exprVars } from '../widgets/scene/expr'
import { SCENE_TEMPLATES } from '../widgets/scene/templates'

const ent = (id: string, stat?: any) => ({ type: 'entity' as const, id, stat })

describe('scene expressions', () => {
  it('evaluates arithmetic, precedence, functions and comparisons', () => {
    expect(evaluate('1 + 2 * 3', {})).toBe(7)
    expect(evaluate('(1 + 2) * 3', {})).toBe(9)
    expect(evaluate('10 - 4 - 3', {})).toBe(3)
    expect(evaluate('heat / power', { heat: 6000, power: 1500 })).toBe(4)
    expect(evaluate('if(power > 50, heat / power, null)', { heat: 100, power: 10 })).toBeNull()
    expect(evaluate('max(0, a - b)', { a: 1, b: 5 })).toBe(0)
    expect(evaluate('clamp(a, 0, 100)', { a: 140 })).toBe(100)
    expect(evaluate('round(a, 1)', { a: 3.14159 })).toBe(3.1)
    expect(evaluate('-a + abs(-2)', { a: 1 })).toBe(1)
    expect(evaluate('a >= 2 && b < 1', { a: 2, b: 0 })).toBe(1)
  })

  it('handles missing values instead of inventing numbers', () => {
    expect(evaluate('a / b', { a: 1, b: 0 })).toBeNull()
    expect(evaluate('a + b', { a: 1, b: null })).toBeNull()
    expect(evaluate('coalesce(a, 0) - coalesce(b, 0)', { a: 500, b: null })).toBe(500)
    // nothing configured → no value at all (not 0)
    expect(evaluate('coalesce(a, 0) - coalesce(b, 0)', { a: null, b: null })).toBeNull()
  })

  it('rejects anything that is not a plain formula', () => {
    expect(exprError('alert(1)')).toMatch(/Unbekannte Funktion/)
    expect(exprError('a.constructor')).toBeTruthy()
    expect(exprError('a[0]')).toBeTruthy()
    expect(exprError('1 +')).toBeTruthy()
    expect(evaluate('constructor', {})).toBeNull()
    expect(exprVars('heat / power + coalesce(x, 1)').sort()).toEqual(['heat', 'power', 'x'])
  })
})

describe('scene values', () => {
  it('converts units, formats and normalizes for animations', () => {
    const vars = [
      { key: 'pv', label: 'PV', format: 'power' as const, source: ent('sensor.pv', 'current'), max: 10000 },
      { key: 'grid', label: 'Netz', format: 'power' as const, source: ent('sensor.grid', 'current'), abs: true, max: 8000 },
      { key: 't', label: 'T', format: 'temp' as const, source: ent('sensor.t', 'current'), min: 20, max: 60 },
      { key: 'e', label: 'E', format: 'energy' as const, source: ent('sensor.e') },
      { key: 'mode', label: 'Modus', format: 'text' as const, source: ent('sensor.mode', 'current') },
    ]
    const out = computeScene(vars, {
      pv: { v: 3.2, unit: 'kW' },
      grid: { v: -1200, unit: 'W' },
      t: { v: 40, unit: '°C' },
      e: { v: 12345, unit: 'Wh' },
      mode: { v: null, s: 'Heizen' },
    })
    expect(out.pv.v).toBe(3200)
    expect(out.pv.t).toBe('3,20 kW')
    expect(out.pv.n).toBe(0.32)
    expect(out.pv.on).toBe(true)
    expect(out.grid.t).toBe('1,20 kW') // direction shown by animation, not by sign
    expect(out.grid.neg).toBe(true)
    expect(out.grid.n).toBe(0.15)
    expect(out.t.t).toBe('40,0 °C')
    expect(out.t.n).toBe(0.5)
    expect(out.e.t).toBe('12,3 kWh')
    expect(out.mode.t).toBe('Heizen')
    expect(out.mode.has).toBe(true)
  })

  it('derives values in order and leaves unconfigured parts empty', () => {
    const tpl = SCENE_TEMPLATES.find((t) => t.id === 'house_solar')!
    const cfg = { template: 'house_solar', bind: { pv: { source: ent('sensor.pv', 'current') }, grid_import: { source: ent('sensor.imp', 'current') } } }
    const vars = sceneVars(cfg)
    expect(vars.map((v) => v.key)).toEqual(tpl.vars.map((v) => v.key))
    const out = computeScene(vars, { pv: { v: 2000, unit: 'W' }, grid_import: { v: 500, unit: 'W' } })
    expect(out.grid.v).toBe(500) // from separate import sensor
    expect(out.home.v).toBe(2500) // pv + grid − battery
    expect(out.autarky.v).toBe(80)
    expect(out.battery.has).toBe(false)
    expect(out.battery.t).toBe('–')

    const hp = sceneVars({ template: 'heat_pump', bind: { hp_power: { source: ent('sensor.p', 'current') }, heat_power: { source: ent('sensor.q', 'current') } } })
    const o2 = computeScene(hp, { hp_power: { v: 1.5, unit: 'kW' }, heat_power: { v: 6000, unit: 'W' } })
    expect(o2.cop.t).toBe('4,0')
    expect(computeScene(hp, { hp_power: { v: 20, unit: 'W' }, heat_power: { v: 0, unit: 'W' } }).cop.has).toBe(false)
  })

  it('on/off states become numbers', () => {
    expect(stateNumber('on')).toBe(1)
    expect(stateNumber('off')).toBe(0)
    expect(stateNumber('21.5')).toBe(21.5)
    expect(stateNumber('unavailable')).toBeNull()
  })

  it('requests only non-live values and refreshes on all used entities', () => {
    const cfg = {
      template: 'heat_pump',
      range: 'today',
      bind: { hp_power: { source: ent('sensor.p', 'current') }, energy_today: { source: ent('sensor.kwh', 'auto') } },
      labels: [{ id: 'l_1', x: 0.5, y: 0.5, source: ent('sensor.extra', 'mean') }],
    }
    const reqs = sceneRequests(cfg)
    expect(reqs.map((r) => r.source.id).sort()).toEqual(['sensor.extra', 'sensor.kwh'])
    expect(reqs.every((r) => r.kind === 'scalar' && r.range === 'today')).toBe(true)
    expect(sceneVars(cfg).filter(isLiveVar).map((v) => v.source!.id)).toEqual(['sensor.p'])
    expect(widgetEntities(cfg, {})).toEqual(['sensor.extra', 'sensor.kwh', 'sensor.p'])
  })
})

describe('scene sandbox', () => {
  it('blocks network and foreign scripts by CSP', () => {
    const doc = buildSrcdoc({ html: '<script>alert(1)</script><b>{{x}}</b>', css: 'b{color:red}', w: 800, h: 400 })
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<style>'))
    expect(doc).toMatch(/default-src 'none'/)
    expect(doc).toMatch(/script-src 'nonce-[0-9a-f]{32}'/)
    expect(doc).not.toMatch(/connect-src/) // falls back to default-src 'none'
    expect(doc).toContain('<script nonce=')
    const js = buildSrcdoc({ html: '', css: '', w: 800, h: 400, allowJs: true })
    expect(js).toMatch(/script-src 'unsafe-inline'/)
  })

  it('user css cannot close the style element', () => {
    const doc = buildSrcdoc({ html: '', css: '</style><script>x()</script>', w: 1, h: 1 })
    expect(doc).not.toContain('</style><script>x()')
  })

  it('scene widgets are registered and build requests from defaults', () => {
    for (const t of ['scene', 'scene_solar', 'scene_heatpump']) expect(widgetDef(t)?.DataEditor, t).toBeDefined()
    for (const w of WIDGETS.filter((w) => w.type.startsWith('scene'))) expect(w.requests({ ...w.defaults })).toEqual([])
  })
})
