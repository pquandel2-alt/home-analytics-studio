import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { builderToFormula } from '../pages/Metrics'
import { formatNumber, formatPct, formatValue } from '../utils/format'
import { WIDGETS, widgetDef } from '../widgets/registry'
import { renderMarkdown } from '../widgets/other'
import { HeadingWidget } from '../widgets/other'

describe('widget registry', () => {
  it('contains all required widget types', () => {
    const required = [
      'value', 'multi_value', 'kpi', 'comparison', 'percent', 'trend',
      'line', 'area', 'bar', 'stacked_bar', 'pie', 'donut', 'gauge', 'radial_gauge', 'heatmap', 'calendar_heatmap', 'sparkline', 'compare_chart',
      'energy_flow', 'power', 'costs', 'distribution', 'solar', 'self_consumption', 'grid_import', 'grid_export',
      'table', 'history', 'stats', 'text', 'heading', 'image', 'clock', 'info', 'analysis',
    ]
    for (const t of required) expect(widgetDef(t), t).toBeDefined()
    expect(new Set(WIDGETS.map((w) => w.type)).size).toBe(WIDGETS.length)
  })

  it('every widget builds requests from its defaults without throwing and has an editor schema', () => {
    for (const w of WIDGETS) {
      expect(() => w.requests({ ...w.defaults })).not.toThrow()
      expect(Array.isArray(w.fields)).toBe(true)
      expect(w.defaultSize.w).toBeGreaterThan(0)
    }
  })

  it('builds batch requests for configured sources', () => {
    const src = { type: 'entity' as const, id: 'sensor.a' }
    expect(widgetDef('line')!.requests({ sources: [src, { type: 'metric', id: 'k' }], range: 'last_7d', interval: '1d' })).toEqual([
      { kind: 'series', source: src, range: 'last_7d', interval: '1d', key: 's0' },
      { kind: 'series', source: { type: 'metric', id: 'k' }, range: 'last_7d', interval: '1d', key: 's1' },
    ])
    const kpi = widgetDef('kpi')!.requests({ sources: [src], period: 'week', sparkline: true })
    expect(kpi.map((r) => r.kind)).toEqual(['compare', 'series'])
    const costs = widgetDef('costs')!.requests({ sources: [src], periods: ['today', 'this_month'] })
    expect(costs.map((r) => r.key)).toEqual(['s0_today', 's0_this_month'])
    const flow = widgetDef('energy_flow')!.requests({ slots: { solar: src } })
    expect(flow[0]).toMatchObject({ key: 'slot_solar', source: { stat: 'current' } })
  })
})

describe('formatting', () => {
  it('uses German number format', () => {
    expect(formatNumber(1234.5, { decimals: 1 })).toBe('1.234,5')
    expect(formatValue(3.14159, 'kWh', { decimals: 2 })).toBe('3,14 kWh')
    expect(formatValue(null, 'kWh')).toBe('–')
    expect(formatPct(-12.34)).toBe('−12,3 %')
  })
})

describe('markdown widget', () => {
  it('escapes HTML and supports formatting + live placeholders', () => {
    const html = renderMarkdown('# Titel\n**fett** <script>x</script>\n- a\n{{sensor.t}}', { 'sensor.t': '21 °C' })
    expect(html).toContain('<h1>Titel</h1>')
    expect(html).toContain('<strong>fett</strong>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<li>a</li>')
    expect(html).toContain('21 °C')
  })

  it('only allows http(s) links', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href')
    expect(renderMarkdown('[x](https://example.org)')).toContain('href="https://example.org"')
  })
})

describe('visual formula builder', () => {
  it('generates formulas with correct precedence', () => {
    expect(builderToFormula({ first: { kind: 'entity', id: 'sensor.e' }, steps: [{ op: '*', operand: { kind: 'constant', id: 'preis' } }], wrap: '' })).toBe('sensor.e * preis')
    expect(
      builderToFormula({
        first: { kind: 'entity', id: 'sensor.pv' },
        steps: [
          { op: '-', operand: { kind: 'entity', id: 'sensor.export' } },
          { op: '/', operand: { kind: 'entity', id: 'sensor.pv' } },
        ],
        wrap: 'PERCENT',
      }),
    ).toBe('((sensor.pv - sensor.export) / sensor.pv) * 100')
    expect(builderToFormula({ first: { kind: 'entity', id: 'sensor.t', fn: 'AVG_W', window: '7d' }, steps: [], wrap: '' })).toBe('AVG(sensor.t, 7d)')
    expect(builderToFormula({ first: { kind: 'number', value: 5 }, steps: [], wrap: 'MOVING_AVG', wrapArg: '24h' })).toBe('MOVING_AVG(5, 24h)')
    expect(
      builderToFormula({
        first: { kind: 'entity', id: 'sensor.p' },
        steps: [],
        wrap: '',
        condition: { enabled: true, left: { kind: 'entity', id: 'sensor.p' }, cmp: '>', right: { kind: 'number', value: 0 }, elseValue: 0 },
      }),
    ).toBe('IF(sensor.p > 0, sensor.p, 0)')
  })
})

describe('widget rendering', () => {
  it('renders a heading widget', () => {
    render(<HeadingWidget widget={{ id: 'h', type: 'heading', config: {} }} cfg={{ text: 'Energie', subtitle: 'Übersicht' }} results={{}} loading={false} width={400} height={80} />)
    expect(screen.getByText('Energie')).toBeInTheDocument()
    expect(screen.getByText('Übersicht')).toBeInTheDocument()
  })
})
