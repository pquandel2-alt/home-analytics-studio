import { useMemo } from 'react'
import type { ScalarResult, SeriesResult, Source } from '../api/types'
import { EChart } from '../charts/EChart'
import { useRuntime, useThemeTokens } from '../theme/context'
import { withAlpha } from '../theme/presets'
import { formatNumber } from '../utils/format'
import {
  BigValue,
  ErrorNote,
  NeedsConfig,
  axisStyle,
  chartBase,
  colorFor,
  firstError,
  fmtOf,
  labelOf,
  scaleFont,
  seriesOk,
  unitOf,
  useLiveScalar,
  useTimeFormatters,
} from './common'
import type { WidgetProps } from './types'

/** Robust colour range: 2nd–98th percentile, so a single outlier does not flatten the scale. */
export function robustRange(vals: number[]): [number, number] {
  if (!vals.length) return [0, 1]
  const v = [...vals].sort((a, b) => a - b)
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]
  const lo = v.length > 20 ? q(0.02) : v[0]
  const hi = v.length > 20 ? q(0.98) : v[v.length - 1]
  return hi > lo ? [lo, hi] : [v[0], v[v.length - 1] > v[0] ? v[v.length - 1] : v[0] + 1]
}

/** Local hour (0–23). Note: de-DE formatting yields "18 Uhr", so the numeric part is taken from formatToParts. */
export function localHour(ts: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone }).formatToParts(new Date(ts * 1000))
  return Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
}

/** Compact axis label: no trailing zeros (0,8 instead of 0,800), thousands grouping for large values. */
export function axisNumber(v: number, decimals?: number | null): string {
  if (decimals != null) return formatNumber(v, { decimals })
  const a = Math.abs(v)
  const max = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: max, minimumFractionDigits: 0 }).format(v)
}

function sourcesOf(cfg: Record<string, any>): Source[] {
  return ((cfg.sources as Source[]) || []).filter((s) => s && s.id)
}

// ------------------------------------------------------------------ time series (line/area/bar/stacked)

export function TimeSeriesChart({ cfg, results, widget }: WidgetProps) {
  const theme = useThemeTokens()
  const sources = sourcesOf(cfg)
  const series = sources.map((_, i) => seriesOk(results[`s${i}`]))
  const first = series.find(Boolean)
  const interval = first?.interval || '1h'
  const fmts = useTimeFormatters(interval)
  const fmt = fmtOf(cfg)
  const kind: string = cfg.chartType || widget.type
  const option = useMemo(() => {
    if (!first) return null
    const units = [...new Set(series.map((s) => (s ? unitOf(cfg, s.unit) : '')))]
    const twoAxes = units.length > 1 && cfg.dualAxis !== false
    const isBar = kind === 'bar' || kind === 'stacked_bar'
    const stacked = kind === 'stacked_bar' || (cfg.stack && kind !== 'line')
    const ax = axisStyle(theme, cfg)
    const yAxes = (twoAxes ? units.slice(0, 2) : [units[0]]).map((u, idx) => ({
      type: 'value',
      name: u || '',
      nameTextStyle: { color: theme.muted, fontSize: 10, align: idx ? 'right' : 'left' },
      scale: !isBar && cfg.zeroBased !== true,
      // axis ends at the highest (and for line charts starts at the lowest) value, so the max is always labelled
      min: cfg.yMin ?? (!isBar && cfg.zeroBased !== true && cfg.axisToData !== false && kind !== 'stacked_bar' ? 'dataMin' : undefined),
      max: cfg.yMax ?? (cfg.axisToData !== false && !stacked ? 'dataMax' : undefined),
      ...ax,
      splitLine: idx ? { show: false } : ax.splitLine,
      axisLabel: { ...ax.axisLabel, showMaxLabel: true, showMinLabel: true, formatter: (v: number) => axisNumber(v, fmt.decimals) },
    }))
    const out: any[] = []
    series.forEach((s, i) => {
      if (!s) return
      const src = sources[i]
      const color = colorFor(i, src, cfg, theme)
      const yIndex = twoAxes ? Math.max(0, units.indexOf(unitOf(cfg, s.unit))) : 0
      const base: any = {
        name: labelOf(src, s),
        type: isBar ? 'bar' : 'line',
        data: s.values.map((v) => (v == null ? null : v)),
        yAxisIndex: Math.min(yIndex, 1),
        itemStyle: { color, borderRadius: isBar ? [4, 4, 0, 0] : undefined },
        lineStyle: { width: cfg.lineWidth ?? 2, color, shadowBlur: theme.glow ? 10 : 0, shadowColor: color },
        smooth: !!cfg.smooth,
        showSymbol: !!cfg.showPoints,
        symbolSize: 5,
        connectNulls: !!cfg.connectNulls,
        stack: stacked ? (isBar ? 'total' : 'area') : undefined,
        barMaxWidth: 36,
        emphasis: { focus: 'series' },
        label: cfg.showLabels ? { show: true, position: 'top', color: theme.muted, fontSize: 10, formatter: (p: any) => formatNumber(p.value, fmt) } : undefined,
      }
      if (kind === 'area' || (kind === 'line' && cfg.fill)) {
        base.areaStyle = {
          opacity: cfg.fillOpacity ?? 0.25,
          color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: withAlpha(color, 0.55) }, { offset: 1, color: withAlpha(color, 0.02) }] },
        }
      }
      if (cfg.showAverage) {
        base.markLine = { symbol: 'none', silent: true, lineStyle: { type: 'dashed', color: withAlpha(color, 0.7) }, label: { color: theme.muted, formatter: (p: any) => `Ø ${formatNumber(p.value, fmt)}` }, data: [{ type: 'average' }] }
      }
      out.push(base)
      if (cfg.showMinMax && !isBar && s.min && s.max) {
        out.push({ name: `${base.name} min`, type: 'line', data: s.min, lineStyle: { opacity: 0 }, stack: `band${i}`, symbol: 'none', silent: true, tooltip: { show: false }, yAxisIndex: base.yAxisIndex })
        out.push({
          name: `${base.name} max`, type: 'line', data: s.max.map((v, j) => (v == null || s.min![j] == null ? null : v - (s.min![j] as number))),
          lineStyle: { opacity: 0 }, areaStyle: { color: withAlpha(color, 0.12) }, stack: `band${i}`, symbol: 'none', silent: true, tooltip: { show: false }, yAxisIndex: base.yAxisIndex,
        })
      }
    })
    const thresholds = (cfg.thresholds as { value: number; color: string; label?: string }[] | undefined) || []
    if (thresholds.length && out[0]) {
      out[0].markLine = {
        symbol: 'none', silent: true,
        data: thresholds.map((t) => ({ yAxis: t.value, lineStyle: { color: t.color, type: 'dashed' }, label: { color: t.color, formatter: t.label || String(t.value) } })),
      }
    }
    return {
      ...chartBase(theme, cfg),
      color: sources.map((s, i) => colorFor(i, s, cfg, theme)),
      legend: { ...chartBase(theme, cfg).legend, data: out.filter((s) => !/ (min|max)$/.test(s.name)).map((s) => s.name) },
      tooltip: {
        ...chartBase(theme, cfg).tooltip,
        formatter: (params: any[]) => {
          const ps = (Array.isArray(params) ? params : [params]).filter((p) => !/ (min|max)$/.test(p.seriesName))
          if (!ps.length) return ''
          const head = fmts.label(first.ts[ps[0].dataIndex])
          return [head, ...ps.map((p) => `${p.marker} ${p.seriesName}: <b>${formatNumber(p.value, fmt)}</b> ${unitOf(cfg, series[p.seriesIndex]?.unit ?? first.unit)}`)].join('<br/>')
        },
      },
      xAxis: { type: 'category', data: first.ts, boundaryGap: isBar, ...axisStyle(theme, cfg), splitLine: { show: false }, axisLabel: { ...axisStyle(theme, cfg).axisLabel, formatter: (v: string) => fmts.tick(Number(v)), hideOverlap: true } },
      yAxis: yAxes,
      dataZoom: cfg.zoom ? [{ type: 'inside' }] : undefined,
      series: out,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, cfg, theme, kind])
  if (!sources.length) return <NeedsConfig />
  if (!first) return <ErrorNote text={firstError(results)} />
  return <EChart option={option!} />
}

// ------------------------------------------------------------------ pie / donut

export function PieWidget({ cfg, results, widget }: WidgetProps) {
  const theme = useThemeTokens()
  const sources = sourcesOf(cfg)
  const fmt = fmtOf(cfg)
  const donut = (cfg.chartType || widget.type) === 'donut'
  const data = sources
    .map((s, i) => {
      const r = results[`s${i}`]
      const d = r?.ok ? (r.data as ScalarResult) : null
      return d ? { name: labelOf(s, d), value: d.value == null ? 0 : Math.max(0, d.value), unit: d.unit, itemStyle: { color: colorFor(i, s, cfg, theme) } } : null
    })
    .filter(Boolean) as { name: string; value: number; unit: string | null }[]
  const unit = unitOf(cfg, data[0]?.unit)
  const total = data.reduce((a, b) => a + b.value, 0)
  const option = useMemo(
    () => ({
      ...chartBase(theme, cfg),
      tooltip: { ...chartBase(theme, cfg).tooltip, trigger: 'item', formatter: (p: any) => `${p.marker} ${p.name}: <b>${formatNumber(p.value, fmt)} ${unit}</b> (${formatNumber(p.percent, { decimals: 1 })} %)` },
      legend: { ...chartBase(theme, cfg).legend, type: 'scroll', top: undefined, bottom: 0 },
      graphic: donut && cfg.showTotal !== false
        ? [{ type: 'text', left: 'center', top: '42%', style: { text: `${formatNumber(total, fmt)}\n${unit}`, fill: theme.text, fontSize: 18, fontWeight: 600, textAlign: 'center', fontFamily: theme.font } }]
        : undefined,
      series: [{
        type: 'pie',
        radius: donut ? ['52%', '76%'] : ['0%', '74%'],
        center: ['50%', cfg.showLegend === false ? '50%' : '46%'],
        roseType: cfg.rose ? 'radius' : undefined,
        itemStyle: { borderRadius: donut ? 6 : 3, borderColor: withAlpha(theme.background, 0.9), borderWidth: 2 },
        label: { show: cfg.showLabels !== false, color: theme.muted, formatter: (p: any) => `${p.name}\n${formatNumber(p.percent, { decimals: 0 })} %`, fontSize: 11 },
        data,
      }],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, cfg, theme, donut],
  )
  if (!sources.length) return <NeedsConfig />
  if (!data.length) return <ErrorNote text={firstError(results)} />
  return <EChart option={option} />
}

// ------------------------------------------------------------------ gauges

function thresholdColor(v: number | null, cfg: Record<string, any>, fallback: string): string {
  const th = ((cfg.thresholds as { value: number; color: string }[]) || []).slice().sort((a, b) => a.value - b.value)
  let c = fallback
  if (v == null) return c
  for (const t of th) if (v >= t.value) c = t.color
  return c
}

export function GaugeWidget({ cfg, results }: WidgetProps) {
  const theme = useThemeTokens()
  const src = sourcesOf(cfg)[0]
  const live = useLiveScalar(src, results.s0)
  const fmt = fmtOf(cfg)
  const min = Number(cfg.min ?? 0)
  const max = Number(cfg.max ?? 100)
  const color = thresholdColor(live.value, cfg, src?.color || theme.accent)
  const unit = unitOf(cfg, live.unit)
  const th = ((cfg.thresholds as { value: number; color: string }[]) || []).slice().sort((a, b) => a.value - b.value)
  const axisColors: [number, string][] = th.length
    ? [...th.map((t, i) => [Math.min(1, Math.max(0, ((th[i + 1]?.value ?? max) - min) / (max - min || 1))), t.color] as [number, string])]
    : [[1, withAlpha(theme.border, 0.6)]]
  if (th.length && th[0].value > min) axisColors.unshift([Math.max(0, (th[0].value - min) / (max - min || 1)), withAlpha(theme.border, 0.6)])
  const option = useMemo(
    () => ({
      ...chartBase(theme, cfg),
      tooltip: { show: false },
      series: [
        {
          type: 'gauge',
          min,
          max,
          startAngle: 220,
          endAngle: -40,
          radius: '92%',
          center: ['50%', '58%'],
          progress: { show: true, width: 14, roundCap: true, itemStyle: { color, shadowBlur: theme.glow ? 14 : 0, shadowColor: color } },
          axisLine: { roundCap: true, lineStyle: { width: 14, color: cfg.showZones ? axisColors : [[1, withAlpha(theme.border, 0.5)]] } },
          pointer: { show: !!cfg.pointer, width: 4, itemStyle: { color } },
          axisTick: { show: false },
          splitLine: { show: !!cfg.showTicks, length: 8, lineStyle: { color: theme.muted, width: 1 } },
          axisLabel: { show: !!cfg.showTicks, color: theme.muted, fontSize: 10, distance: 18, formatter: (v: number) => axisNumber(v) },
          anchor: { show: false },
          title: { show: true, offsetCenter: [0, '58%'], color: theme.muted, fontSize: 12 },
          detail: {
            valueAnimation: true,
            offsetCenter: [0, '8%'],
            fontSize: 26,
            fontWeight: 600,
            color: theme.text,
            formatter: (v: number) => `${formatNumber(v, fmt)}${unit ? ' ' + unit : ''}`,
          },
          data: [{ value: live.value ?? 0, name: cfg.subtitle || '' }],
        },
      ],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [live.value, cfg, theme, color],
  )
  if (!src) return <NeedsConfig />
  if (live.value == null && results.s0 && !results.s0.ok) return <ErrorNote text={results.s0.error} />
  return <EChart option={option} />
}

export function RadialGaugeWidget({ cfg, results }: WidgetProps) {
  const theme = useThemeTokens()
  const sources = sourcesOf(cfg)
  const fmt = fmtOf(cfg)
  const max = Number(cfg.max ?? 100)
  const items = sources.map((s, i) => {
    const d = results[`s${i}`]?.ok ? (results[`s${i}`].data as ScalarResult) : null
    return { name: labelOf(s, d), value: d?.value ?? 0, unit: d?.unit, color: colorFor(i, s, cfg, theme) }
  })
  const option = useMemo(
    () => ({
      ...chartBase(theme, cfg),
      tooltip: { ...chartBase(theme, cfg).tooltip, trigger: 'item', formatter: (p: any) => `${p.name}: <b>${formatNumber(p.value, fmt)} ${unitOf(cfg, items[p.dataIndex]?.unit)}</b>` },
      polar: { radius: ['22%', '88%'], center: ['50%', '54%'] },
      angleAxis: { max, startAngle: 90, show: false },
      radiusAxis: { type: 'category', data: items.map((i) => i.name), show: false },
      legend: { show: false },
      series: [
        {
          type: 'bar',
          coordinateSystem: 'polar',
          roundCap: true,
          barWidth: Math.max(6, 60 / Math.max(1, items.length)),
          showBackground: true,
          backgroundStyle: { color: withAlpha(theme.border, 0.35) },
          data: items.map((i) => ({ value: i.value, name: i.name, itemStyle: { color: i.color, shadowBlur: theme.glow ? 10 : 0, shadowColor: i.color } })),
          label: { show: cfg.showLabels !== false, position: 'start', formatter: (p: any) => `${p.name}: ${formatNumber(p.value, fmt)}`, color: theme.muted, fontSize: 11 },
        },
      ],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, cfg, theme],
  )
  if (!sources.length) return <NeedsConfig />
  return <EChart option={option} />
}

// ------------------------------------------------------------------ heatmaps

export function HeatmapWidget({ cfg, results }: WidgetProps) {
  const theme = useThemeTokens()
  const rt = useRuntime()
  const s = seriesOk(results.s0)
  const fmt = fmtOf(cfg)
  const option = useMemo(() => {
    if (!s) return null
    const dayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: rt.timezone })

    const days: string[] = []
    const data: [number, number, number | null][] = []
    s.ts.forEach((t, i) => {
      const d = dayFmt.format(new Date(t * 1000))
      let di = days.indexOf(d)
      if (di < 0) {
        days.push(d)
        di = days.length - 1
      }
      const h = localHour(t, rt.timezone)
      data.push([h, di, s.values[i]])
    })
    const vals = data.map((d) => d[2]).filter((v): v is number => v != null)
    const color = sourcesOf(cfg)[0]?.color || theme.accent
    return {
      ...chartBase(theme, cfg),
      tooltip: { ...chartBase(theme, cfg).tooltip, trigger: 'item', formatter: (p: any) => `${days[p.value[1]]}, ${p.value[0]}–${p.value[0] + 1} Uhr<br/><b>${formatNumber(p.value[2], fmt)} ${unitOf(cfg, s.unit)}</b>` },
      grid: { left: 4, right: 8, top: 8, bottom: 40, containLabel: true },
      xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => String(i)), splitArea: { show: false }, ...axisStyle(theme, cfg), splitLine: { show: false } },
      yAxis: { type: 'category', data: days, ...axisStyle(theme, cfg), splitLine: { show: false } },
      visualMap: {
        min: robustRange(vals)[0],
        max: robustRange(vals)[1],
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemHeight: 120,
        textStyle: { color: theme.muted, fontSize: 10 },
        inRange: { color: [withAlpha(color, 0.06), withAlpha(color, 0.45), color, cfg.hotColor || theme.accent2] },
        formatter: (v: number) => formatNumber(v, fmt),
      },
      series: [{ type: 'heatmap', data, itemStyle: { borderRadius: 3, borderColor: withAlpha(theme.background, 0.6), borderWidth: 1 }, emphasis: { itemStyle: { shadowBlur: 8 } } }],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, cfg, theme])
  if (!sourcesOf(cfg).length) return <NeedsConfig />
  if (!option) return <ErrorNote text={firstError(results)} />
  return <EChart option={option} />
}

export function CalendarHeatmapWidget({ cfg, results, width }: WidgetProps) {
  const theme = useThemeTokens()
  const rt = useRuntime()
  const s = seriesOk(results.s0)
  const fmt = fmtOf(cfg)
  const option = useMemo(() => {
    if (!s) return null
    const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: rt.timezone })
    const data = s.ts.map((t, i) => [dateFmt.format(new Date(t * 1000)), s.values[i]])
    const vals = s.values.filter((v): v is number => v != null)
    const color = sourcesOf(cfg)[0]?.color || theme.accent
    const range = [data[0]?.[0], data[data.length - 1]?.[0]]
    const cell = Math.max(8, Math.min(22, (width - 60) / Math.max(10, Math.ceil(data.length / 7) + 1)))
    return {
      ...chartBase(theme, cfg),
      tooltip: { ...chartBase(theme, cfg).tooltip, trigger: 'item', formatter: (p: any) => `${p.value[0]}<br/><b>${formatNumber(p.value[1], fmt)} ${unitOf(cfg, s.unit)}</b>` },
      visualMap: {
        min: robustRange(vals)[0],
        max: robustRange(vals)[1],
        show: cfg.showLegend !== false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemHeight: 100,
        textStyle: { color: theme.muted, fontSize: 10 },
        inRange: { color: [withAlpha(color, 0.08), withAlpha(color, 0.5), color] },
        formatter: (v: number) => formatNumber(v, fmt),
      },
      calendar: {
        range,
        top: 24,
        left: 34,
        right: 8,
        cellSize: [cell, cell],
        splitLine: { show: false },
        itemStyle: { color: withAlpha(theme.border, 0.15), borderColor: withAlpha(theme.background, 0.8), borderWidth: 2 },
        dayLabel: { firstDay: 1, nameMap: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], color: theme.muted, fontSize: 10 },
        monthLabel: { nameMap: ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'], color: theme.muted, fontSize: 10 },
        yearLabel: { show: false },
      },
      series: [{ type: 'heatmap', coordinateSystem: 'calendar', data }],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, cfg, theme, width])
  if (!sourcesOf(cfg).length) return <NeedsConfig />
  if (!option) return <ErrorNote text={firstError(results)} />
  return <EChart option={option} />
}

// ------------------------------------------------------------------ sparkline (Verlaufskurve)

export function SparklineWidget({ cfg, results, width, height }: WidgetProps) {
  const theme = useThemeTokens()
  const src = sourcesOf(cfg)[0]
  const s = seriesOk(results.s0)
  const cur = useLiveScalar(src ? { ...src, stat: 'current' } : undefined, results.cur)
  const fmt = fmtOf(cfg)
  const color = src?.color || theme.accent
  const option = useMemo(
    () =>
      s && {
        animation: theme.animations,
        grid: { left: 0, right: 0, top: 4, bottom: 0 },
        xAxis: { type: 'category', show: false, data: s.ts, boundaryGap: false },
        yAxis: { type: 'value', show: false, scale: true },
        tooltip: { show: false },
        series: [{
          type: 'line', data: s.values, smooth: true, showSymbol: false, connectNulls: true,
          lineStyle: { width: 2, color, shadowBlur: theme.glow ? 10 : 0, shadowColor: color },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: withAlpha(color, 0.4) }, { offset: 1, color: withAlpha(color, 0) }] } },
        }],
      },
    [s, color, theme],
  )
  if (!src) return <NeedsConfig />
  const value = cfg.valueMode === 'last' ? [...(s?.values || [])].reverse().find((v) => v != null) ?? null : cur.value
  return (
    <div className="flex h-full flex-col">
      <BigValue value={value} unit={unitOf(cfg, cur.unit || s?.unit)} fmt={fmt} size={scaleFont(width, height, 0.6)} />
      <div className="min-h-0 flex-1">{option ? <EChart option={option} /> : <ErrorNote text={firstError(results)} />}</div>
    </div>
  )
}

// ------------------------------------------------------------------ comparison chart

export function CompareChartWidget({ cfg, results }: WidgetProps) {
  const theme = useThemeTokens()
  const a = seriesOk(results.a)
  const b = seriesOk(results.b)
  const fmt = fmtOf(cfg)
  const src = sourcesOf(cfg)[0]
  const fmts = useTimeFormatters(a?.interval || '1d')
  const option = useMemo(() => {
    if (!a) return null
    const n = Math.max(a.values.length, b?.values.length || 0)
    const isBar = cfg.chartType !== 'line'
    const c1 = src?.color || theme.palette[0]
    const c2 = cfg.compareColor || withAlpha(theme.muted, 0.8)
    return {
      ...chartBase(theme, cfg),
      tooltip: {
        ...chartBase(theme, cfg).tooltip,
        formatter: (ps: any[]) => [`#${ps[0].dataIndex + 1}`, ...ps.map((p) => `${p.marker} ${p.seriesName}: <b>${formatNumber(p.value, fmt)}</b> ${unitOf(cfg, a.unit)}`)].join('<br/>'),
      },
      xAxis: {
        type: 'category',
        data: Array.from({ length: n }, (_, i) => (a.ts[i] ? fmts.tick(a.ts[i]) : `${i + 1}`)),
        ...axisStyle(theme, cfg),
        splitLine: { show: false },
      },
      yAxis: { type: 'value', ...axisStyle(theme, cfg), axisLabel: { ...axisStyle(theme, cfg).axisLabel, formatter: (v: number) => formatNumber(v, { decimals: 0 }) } },
      series: [
        { name: cfg.labelA || 'Aktuell', type: isBar ? 'bar' : 'line', data: a.values, itemStyle: { color: c1, borderRadius: [4, 4, 0, 0] }, lineStyle: { color: c1, width: 2 }, smooth: true, showSymbol: false, barMaxWidth: 26 },
        { name: cfg.labelB || 'Vergleich', type: isBar ? 'bar' : 'line', data: b?.values || [], itemStyle: { color: c2, borderRadius: [4, 4, 0, 0] }, lineStyle: { color: c2, width: 2, type: 'dashed' }, smooth: true, showSymbol: false, barMaxWidth: 26 },
      ],
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, cfg, theme])
  if (!src) return <NeedsConfig />
  if (!option) return <ErrorNote text={firstError(results)} />
  return <EChart option={option} />
}

export type { SeriesResult }
