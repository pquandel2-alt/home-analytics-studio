import { BatteryCharging, Home, PlugZap, Sun, UtilityPole } from 'lucide-react'
import { useMemo } from 'react'
import { numericState, useLiveEntities } from '../api/live'
import type { ScalarResult, Source } from '../api/types'
import { EChart } from '../charts/EChart'
import { useRuntime, useThemeTokens } from '../theme/context'
import { withAlpha } from '../theme/presets'
import { formatNumber } from '../utils/format'
import { BigValue, ErrorNote, MiniLabel, NeedsConfig, axisStyle, chartBase, colorFor, fmtOf, labelOf, scaleFont, seriesOk, unitOf, useTimeFormatters } from './common'
import type { BatchResult, WidgetProps } from './types'

function slot(cfg: Record<string, any>, key: string): Source | undefined {
  const s = cfg.slots?.[key]
  return s && s.id ? s : undefined
}

/** live numeric value of a slot (entity: websocket state, metric: scalar result) */
function useSlotValues(cfg: Record<string, any>, keys: string[], results: Record<string, BatchResult>) {
  const ids = keys.map((k) => slot(cfg, k)).filter((s): s is Source => !!s && s.type === 'entity').map((s) => s.id)
  const states = useLiveEntities(ids)
  const out: Record<string, number | null> = {}
  for (const k of keys) {
    const s = slot(cfg, k)
    if (!s) {
      out[k] = null
      continue
    }
    let v: number | null = null
    if (s.type === 'entity') {
      v = numericState(states[s.id])
      const unit = states[s.id]?.attributes?.unit_of_measurement
      if (v != null && unit === 'kW') v *= 1000
      if (v != null && unit === 'MW') v *= 1e6
    }
    if (v == null) {
      const r = results[`slot_${k}`]
      v = r?.ok ? ((r.data as ScalarResult).value ?? null) : null
    }
    out[k] = v == null ? null : (cfg[`invert_${k}`] ? -v : v)
  }
  return out
}

function fmtPower(w: number | null, fmt: ReturnType<typeof fmtOf>): string {
  if (w == null) return '–'
  if (Math.abs(w) >= 1000) return `${formatNumber(w / 1000, { ...fmt, decimals: fmt.decimals ?? 2 })} kW`
  return `${formatNumber(w, { ...fmt, decimals: 0 })} W`
}

// ------------------------------------------------------------------ Energiefluss

export function EnergyFlowWidget({ cfg, results, width, height }: WidgetProps) {
  const theme = useThemeTokens()
  const fmt = fmtOf(cfg)
  const v = useSlotValues(cfg, ['solar', 'grid', 'grid_import', 'grid_export', 'battery', 'battery_soc', 'home'], results)
  const configured = ['solar', 'grid', 'grid_import', 'grid_export', 'battery', 'home'].some((k) => slot(cfg, k))
  if (!configured) return <NeedsConfig text="Leistungs-Entitäten (W) für Solar, Netz, Batterie, Haus wählen" />

  const S = Math.max(0, v.solar ?? 0)
  let I = 0
  let E = 0
  if (slot(cfg, 'grid')) {
    const g = v.grid ?? 0
    I = Math.max(0, g)
    E = Math.max(0, -g)
  } else {
    I = Math.max(0, v.grid_import ?? 0)
    E = Math.max(0, v.grid_export ?? 0)
  }
  const bat = v.battery ?? 0 // + charging, - discharging
  const C = Math.max(0, bat)
  const D = Math.max(0, -bat)
  const s2g = Math.min(E, S)
  const s2b = Math.min(C, S - s2g)
  const s2h = Math.max(0, S - s2g - s2b)
  const g2b = Math.max(0, C - s2b)
  const g2h = Math.max(0, I - g2b)
  const b2h = D
  const H = v.home != null ? v.home : s2h + g2h + b2h

  const W = Math.max(260, width)
  const Hh = Math.max(220, height)
  const r = Math.max(26, Math.min(W, Hh) * 0.11)
  const pos = {
    solar: { x: W / 2, y: r + 6 },
    grid: { x: r + 6, y: Hh / 2 },
    battery: { x: W - r - 6, y: Hh / 2 },
    home: { x: W / 2, y: Hh - r - 6 },
  }
  const maxFlow = Math.max(1, S, I, E, C, D, H)
  const colors = {
    solar: cfg.colorSolar || '#fbbf24',
    grid: cfg.colorGrid || '#60a5fa',
    battery: cfg.colorBattery || '#a78bfa',
    home: cfg.colorHome || theme.accent,
    export: cfg.colorExport || '#34d399',
  }
  const flow = (from: { x: number; y: number }, to: { x: number; y: number }, value: number, color: string, key: string) => {
    const active = value > 1
    const w = active ? 1.5 + (value / maxFlow) * 5 : 1
    const mx = (from.x + to.x) / 2
    const my = (from.y + to.y) / 2
    const cx = mx + (to.y - from.y) * 0.12
    const cy = my - (to.x - from.x) * 0.12
    const d = `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`
    return (
      <g key={key}>
        <path d={d} fill="none" stroke={withAlpha(theme.border, 0.5)} strokeWidth={1} />
        {active && (
          <path d={d} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" className={theme.animations ? 'flow-line' : ''} style={{ filter: theme.glow ? `drop-shadow(0 0 4px ${color})` : undefined }} />
        )}
        {active && cfg.showFlowLabels !== false && (
          <text x={cx * 0.5 + mx * 0.5} y={cy * 0.5 + my * 0.5} fill={theme.muted} fontSize={10} textAnchor="middle">
            {fmtPower(value, fmt)}
          </text>
        )}
      </g>
    )
  }
  const node = (key: keyof typeof pos, label: string, value: string, color: string, Icon: any, sub?: string) => (
    <g key={key}>
      <circle cx={pos[key].x} cy={pos[key].y} r={r} fill={withAlpha(color, 0.12)} stroke={color} strokeWidth={2} style={{ filter: theme.glow ? `drop-shadow(0 0 8px ${color})` : undefined }} />
      <foreignObject x={pos[key].x - r} y={pos[key].y - r} width={r * 2} height={r * 2}>
        <div className="flex h-full w-full flex-col items-center justify-center text-center leading-tight" style={{ color: theme.text }}>
          <Icon style={{ color, width: r * 0.42, height: r * 0.42 }} />
          <span className="font-semibold tabular-nums" style={{ fontSize: Math.max(10, r * 0.3) }}>{value}</span>
          {sub && <span style={{ fontSize: Math.max(8, r * 0.22), color: theme.muted }}>{sub}</span>}
        </div>
      </foreignObject>
      <text x={pos[key].x} y={key === 'home' ? pos[key].y - r - 6 : pos[key].y + r + 13} textAnchor="middle" fill={theme.muted} fontSize={11}>
        {label}
      </text>
    </g>
  )
  return (
    <svg width="100%" height="100%" viewBox={`0 0 ${W} ${Hh}`} preserveAspectRatio="xMidYMid meet">
      {flow(pos.solar, pos.home, s2h, colors.solar, 's2h')}
      {flow(pos.solar, pos.grid, s2g, colors.export, 's2g')}
      {flow(pos.solar, pos.battery, s2b, colors.solar, 's2b')}
      {flow(pos.grid, pos.home, g2h, colors.grid, 'g2h')}
      {flow(pos.grid, pos.battery, g2b, colors.grid, 'g2b')}
      {flow(pos.battery, pos.home, b2h, colors.battery, 'b2h')}
      {(slot(cfg, 'solar') || true) && node('solar', 'Solar', fmtPower(S, fmt), colors.solar, Sun)}
      {node('grid', 'Netz', fmtPower(I > 0 ? I : -E, fmt), colors.grid, UtilityPole, I > 0 ? 'Bezug' : E > 0 ? 'Einspeisung' : '')}
      {(slot(cfg, 'battery') || slot(cfg, 'battery_soc')) &&
        node('battery', 'Batterie', fmtPower(bat, fmt), colors.battery, BatteryCharging, v.battery_soc != null ? `${formatNumber(v.battery_soc, { decimals: 0 })} %` : undefined)}
      {node('home', 'Haus', fmtPower(H, fmt), colors.home, Home)}
    </svg>
  )
}

// ------------------------------------------------------------------ power/energy cards (Stromverbrauch, Solar, Netzbezug, Einspeisung)

export function PowerEnergyCard({ cfg, results, width, height, widget }: WidgetProps) {
  const theme = useThemeTokens()
  const fmt = fmtOf(cfg)
  const v = useSlotValues(cfg, ['power'], results)
  const energy = results.slot_energy?.ok ? (results.slot_energy.data as ScalarResult) : null
  const bars = seriesOk(results.bars)
  const fmts = useTimeFormatters(bars?.interval || '1h')
  const accent =
    cfg.color || { solar: '#fbbf24', grid_import: '#60a5fa', grid_export: '#34d399', power: theme.accent }[widget.type as string] || theme.accent
  const Icon = { solar: Sun, grid_import: UtilityPole, grid_export: PlugZap, power: PlugZap }[widget.type as string] || PlugZap
  const option = useMemo(
    () =>
      bars && {
        ...chartBase(theme, { ...cfg, showLegend: false }),
        grid: { left: 2, right: 2, top: 6, bottom: 2, containLabel: true },
        tooltip: { ...chartBase(theme, cfg).tooltip, formatter: (ps: any[]) => `${fmts.label(bars.ts[ps[0].dataIndex])}<br/><b>${formatNumber(ps[0].value, fmt)} ${bars.unit || ''}</b>` },
        xAxis: { type: 'category', data: bars.ts, ...axisStyle(theme, cfg), splitLine: { show: false }, axisLabel: { ...axisStyle(theme, cfg).axisLabel, formatter: (x: string) => fmts.tick(Number(x)), hideOverlap: true, fontSize: 9 } },
        yAxis: { type: 'value', show: false },
        series: [{ type: 'bar', data: bars.values, itemStyle: { color: accent, borderRadius: [3, 3, 0, 0] }, barMaxWidth: 18 }],
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bars, theme, accent],
  )
  if (!slot(cfg, 'power') && !slot(cfg, 'energy')) return <NeedsConfig text="Leistung (W) und/oder Energiezähler (kWh) wählen" />
  const big = scaleFont(width, height, 0.5)
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: withAlpha(accent, 0.15), color: accent }}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="grid flex-1 grid-cols-2 gap-2">
          {slot(cfg, 'power') && (
            <div>
              <MiniLabel>Aktuell</MiniLabel>
              <div className="font-semibold tabular-nums" style={{ fontSize: big }}>
                {fmtPower(v.power, fmt)}
              </div>
            </div>
          )}
          {slot(cfg, 'energy') && (
            <div>
              <MiniLabel>{cfg.energyLabel || 'Heute'}</MiniLabel>
              <BigValue value={energy?.value} unit={energy?.unit} fmt={fmt} size={big} />
            </div>
          )}
        </div>
      </div>
      {option && cfg.showChart !== false && height > 140 && (
        <div className="min-h-0 flex-1">
          <EChart option={option} />
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Kostenübersicht

const COST_PERIODS = [
  { key: 'today', label: 'Heute' },
  { key: 'this_week', label: 'Diese Woche' },
  { key: 'this_month', label: 'Dieser Monat' },
  { key: 'this_year', label: 'Dieses Jahr' },
]

export function CostsWidget({ cfg, results }: WidgetProps) {
  const theme = useThemeTokens()
  const rt = useRuntime()
  const sources = ((cfg.sources as Source[]) || []).filter((s) => s?.id)
  const fmt = { ...fmtOf(cfg), decimals: cfg.decimals ?? 2 }
  if (!sources.length) return <NeedsConfig text="Kosten-Kennzahl oder Verbrauchsquelle (mit Preis) wählen" />
  const price = cfg.price != null && cfg.price !== '' ? Number(cfg.price) : null
  const currency = cfg.unit || rt.currency
  const periods = COST_PERIODS.filter((p) => (cfg.periods || COST_PERIODS.map((x) => x.key)).includes(p.key))
  const val = (si: number, p: string) => {
    const r = results[`s${si}_${p}`]
    const d = r?.ok ? (r.data as ScalarResult) : null
    if (!d || d.value == null) return null
    return price != null ? d.value * price : d.value
  }
  return (
    <div className="flex h-full flex-col justify-center gap-2 overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-muted">
            <th className="py-1 text-left font-medium">Zeitraum</th>
            {sources.map((s, i) => (
              <th key={i} className="py-1 text-right font-medium" style={{ color: sources.length > 1 ? colorFor(i, s, cfg, theme) : undefined }}>
                {labelOf(s, (results[`s${i}_${periods[0]?.key}`]?.data as ScalarResult) || null)}
              </th>
            ))}
            {sources.length > 1 && <th className="py-1 text-right font-medium">Summe</th>}
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => {
            const vals = sources.map((_, i) => val(i, p.key))
            const sum = vals.reduce<number | null>((a, b) => (b == null ? a : (a ?? 0) + b), null)
            return (
              <tr key={p.key} className="border-t border-line/30">
                <td className="py-1.5 text-muted">{p.label}</td>
                {vals.map((v, i) => (
                  <td key={i} className="py-1.5 text-right font-semibold tabular-nums">
                    {formatNumber(v, fmt)} {currency}
                  </td>
                ))}
                {sources.length > 1 && <td className="py-1.5 text-right font-semibold tabular-nums text-accent">{formatNumber(sum, fmt)} {currency}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
      {price != null && <div className="text-[11px] text-muted">berechnet mit {formatNumber(price, { decimals: 4 })} {currency} je Einheit</div>}
    </div>
  )
}

// ------------------------------------------------------------------ Verbrauchsverteilung

export function DistributionWidget({ cfg, results }: WidgetProps) {
  const theme = useThemeTokens()
  const fmt = fmtOf(cfg)
  const sources = ((cfg.sources as Source[]) || []).filter((s) => s?.id)
  const items = sources.map((s, i) => {
    const d = results[`s${i}`]?.ok ? (results[`s${i}`].data as ScalarResult) : null
    return { name: labelOf(s, d), value: Math.max(0, d?.value ?? 0), unit: d?.unit, color: colorFor(i, s, cfg, theme) }
  })
  const total = results.total?.ok ? (results.total.data as ScalarResult).value : null
  const sum = items.reduce((a, b) => a + b.value, 0)
  if (total != null && total > sum) items.push({ name: 'Sonstige', value: total - sum, unit: items[0]?.unit, color: withAlpha(theme.muted, 0.6) })
  const all = items.reduce((a, b) => a + b.value, 0)
  const unit = unitOf(cfg, items[0]?.unit)
  const option = useMemo(
    () => ({
      ...chartBase(theme, cfg),
      legend: { show: false },
      tooltip: { ...chartBase(theme, cfg).tooltip, trigger: 'item', formatter: (p: any) => `${p.name}: <b>${formatNumber(p.value, fmt)} ${unit}</b> (${formatNumber(p.percent, { decimals: 1 })} %)` },
      series: [{ type: 'pie', radius: ['55%', '85%'], label: { show: false }, itemStyle: { borderRadius: 5, borderColor: withAlpha(theme.background, 0.9), borderWidth: 2 }, data: items.map((i) => ({ name: i.name, value: i.value, itemStyle: { color: i.color } })) }],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, cfg, theme],
  )
  if (!sources.length) return <NeedsConfig text="Verbraucher (Energiezähler) wählen" />
  if (!items.some((i) => i.value > 0) && Object.values(results).some((r) => r && !r.ok)) return <ErrorNote text={Object.values(results).find((r) => !r.ok)?.error} />
  return (
    <div className="flex h-full gap-3">
      <div className="h-full min-w-0 flex-1">
        <EChart option={option} />
      </div>
      <div className="flex w-[45%] flex-col justify-center gap-1.5 overflow-auto text-xs">
        {items
          .slice()
          .sort((a, b) => b.value - a.value)
          .map((i) => (
            <div key={i.name} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: i.color }} />
              <span className="min-w-0 flex-1 truncate">{i.name}</span>
              <span className="tabular-nums text-muted">{formatNumber(all ? (i.value / all) * 100 : 0, { decimals: 0 })} %</span>
              <span className="w-20 text-right font-medium tabular-nums">{formatNumber(i.value, fmt)} {unit}</span>
            </div>
          ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ Eigenverbrauch / Autarkie

function Ring({ pct, color, label, size }: { pct: number | null; color: string; label: string; size: number }) {
  const theme = useThemeTokens()
  const r = size / 2 - 8
  const c = 2 * Math.PI * r
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={withAlpha(theme.border, 0.5)} strokeWidth={9} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={9} strokeLinecap="round" strokeDasharray={`${(p / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray 0.8s ease' }} />
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill={theme.text} fontSize={size / 5} fontWeight={600}>
          {pct == null ? '–' : `${formatNumber(pct, { decimals: 0 })} %`}
        </text>
      </svg>
      <span className="text-xs text-muted">{label}</span>
    </div>
  )
}

export function SelfConsumptionWidget({ cfg, results, width, height }: WidgetProps) {
  const fmt = fmtOf(cfg)
  const get = (k: string) => (results[`slot_${k}`]?.ok ? ((results[`slot_${k}`].data as ScalarResult).value ?? null) : null)
  const solar = get('solar_energy')
  const exp = get('export_energy')
  const imp = get('import_energy')
  const home = get('home_energy')
  if (!slot(cfg, 'solar_energy')) return <NeedsConfig text="Solarertrag (kWh) und Einspeisung (kWh) wählen" />
  const self = solar != null && exp != null ? Math.max(0, solar - exp) : null
  const ratio = self != null && solar ? (self / solar) * 100 : null
  const consumption = home ?? (self != null && imp != null ? self + imp : null)
  const autarky = consumption && imp != null ? Math.max(0, (1 - imp / consumption) * 100) : null
  const size = Math.max(70, Math.min(height - 70, width / (autarky != null ? 2.4 : 1.4)))
  return (
    <div className="flex h-full flex-col justify-center gap-3">
      <div className="flex items-center justify-around">
        <Ring pct={ratio} color={cfg.color || '#fbbf24'} label="Eigenverbrauchsquote" size={size} />
        {autarky != null && <Ring pct={autarky} color={cfg.color2 || '#4ade80'} label="Autarkiegrad" size={size} />}
      </div>
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div><MiniLabel>Erzeugt</MiniLabel><b className="tabular-nums">{formatNumber(solar, fmt)} kWh</b></div>
        <div><MiniLabel>Selbst genutzt</MiniLabel><b className="tabular-nums">{formatNumber(self, fmt)} kWh</b></div>
        <div><MiniLabel>Eingespeist</MiniLabel><b className="tabular-nums">{formatNumber(exp, fmt)} kWh</b></div>
      </div>
    </div>
  )
}

export { ErrorNote }
