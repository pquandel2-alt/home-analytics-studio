import clsx from 'clsx'
import { TrendingDown, TrendingUp, Minus } from 'lucide-react'
import { useMemo } from 'react'
import type { Comparison, ScalarResult, Source } from '../api/types'
import { EChart } from '../charts/EChart'
import { useThemeTokens } from '../theme/context'
import { withAlpha } from '../theme/presets'
import { formatNumber, formatPct, rangeLabel } from '../utils/format'
import { BigValue, Delta, ErrorNote, MiniLabel, NeedsConfig, colorFor, fmtOf, labelOf, scaleFont, seriesOk, unitOf, useLiveScalar } from './common'
import type { WidgetProps } from './types'

function srcs(cfg: Record<string, any>): Source[] {
  return ((cfg.sources as Source[]) || []).filter((s) => s && s.id)
}

function thresholdColor(v: number | null, cfg: Record<string, any>): string | undefined {
  const th = ((cfg.thresholds as { value: number; color: string }[]) || []).slice().sort((a, b) => a.value - b.value)
  let c: string | undefined
  if (v == null) return undefined
  for (const t of th) if (v >= t.value) c = t.color
  return c
}

function Spark({ values, color }: { values: (number | null)[]; color: string }) {
  const theme = useThemeTokens()
  const option = useMemo(
    () => ({
      animation: theme.animations,
      grid: { left: 0, right: 0, top: 2, bottom: 0 },
      xAxis: { type: 'category', show: false, boundaryGap: false, data: values.map((_, i) => i) },
      yAxis: { type: 'value', show: false, scale: true },
      series: [{ type: 'line', data: values, smooth: true, showSymbol: false, connectNulls: true, lineStyle: { width: 1.8, color }, areaStyle: { color: withAlpha(color, 0.15) } }],
    }),
    [values, color, theme.animations],
  )
  return <EChart option={option} />
}

// ------------------------------------------------------------------ Einzelwert

export function ValueWidget({ cfg, results, width, height }: WidgetProps) {
  const theme = useThemeTokens()
  const src = srcs(cfg)[0]
  const v = useLiveScalar(src, results.s0)
  const spark = seriesOk(results.spark)
  if (!src) return <NeedsConfig />
  if (v.value == null && results.s0 && !results.s0.ok) return <ErrorNote text={results.s0.error} />
  const color = thresholdColor(v.value, cfg) || cfg.valueColor || undefined
  const align = cfg.align || 'left'
  return (
    <div className={clsx('flex h-full flex-col justify-center gap-1', align === 'center' && 'items-center text-center', align === 'right' && 'items-end text-right')}>
      <BigValue value={v.value} unit={unitOf(cfg, v.unit)} fmt={fmtOf(cfg)} size={scaleFont(width, height, cfg.sparkline ? 0.7 : 1) * (cfg.fontScale || 1)} color={color} className={theme.glow ? 'glow-text' : ''} />
      {cfg.subtitle !== '' && <div className="truncate text-xs text-muted">{cfg.subtitle || (src.stat === 'current' ? 'aktuell' : rangeLabel(cfg.range))}</div>}
      {cfg.sparkline && spark && (
        <div className="h-1/3 min-h-[24px] w-full">
          <Spark values={spark.values} color={src.color || theme.accent} />
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Mehrere Kennzahlen

function MultiItem({ src, res, cfg, i, size }: { src: Source; res: any; cfg: Record<string, any>; i: number; size: number }) {
  const theme = useThemeTokens()
  const v = useLiveScalar(src, res)
  return (
    <div className="min-w-0 rounded-xl border border-line/40 bg-fg/[0.03] p-3">
      <div className="mb-1 flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: colorFor(i, src, cfg, theme) }} />
        <MiniLabel>{labelOf(src, { name: v.name })}</MiniLabel>
      </div>
      <BigValue value={v.value} unit={unitOf(cfg, v.unit)} fmt={fmtOf(cfg)} size={size} color={thresholdColor(v.value, cfg)} />
    </div>
  )
}

export function MultiValueWidget({ cfg, results, width, height }: WidgetProps) {
  const sources = srcs(cfg)
  if (!sources.length) return <NeedsConfig />
  const cols = Number(cfg.columns) || Math.max(1, Math.min(sources.length, Math.floor(width / 150)))
  const rows = Math.ceil(sources.length / cols)
  const size = Math.max(14, Math.min(40, Math.min(width / cols / 5, height / rows / 3)))
  return (
    <div className="grid h-full content-center gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {sources.map((s, i) => (
        <MultiItem key={i} src={s} res={results[`s${i}`]} cfg={cfg} i={i} size={size} />
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ KPI-Karte

export function KpiWidget({ cfg, results, width, height }: WidgetProps) {
  const theme = useThemeTokens()
  const src = srcs(cfg)[0]
  const cmp = results.cmp?.ok ? (results.cmp.data as Comparison) : null
  const spark = seriesOk(results.spark)
  const fmt = fmtOf(cfg)
  if (!src) return <NeedsConfig />
  if (!cmp) return <ErrorNote text={results.cmp?.error} />
  const unit = unitOf(cfg, spark?.unit)
  const target = cfg.target != null && cfg.target !== '' ? Number(cfg.target) : null
  const progress = target && cmp.current != null ? Math.min(1, cmp.current / target) : null
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <BigValue value={cmp.current} unit={unit} fmt={fmt} size={scaleFont(width, height, 0.62)} className={theme.glow ? 'glow-text' : ''} />
        <Delta pct={(cmp as any).previous_same_elapsed_coverage != null && (cmp as any).previous_same_elapsed_coverage < 0.5 ? null : cmp.change_pct} invert={!!cfg.invertColors} />
      </div>
      <div className="text-xs text-muted">
        {cmp.label} · {cmp.previous_label} bis jetzt: {formatNumber(cmp.previous_same_elapsed, fmt)} {unit}
        {cmp.previous != null && <> · gesamt: {formatNumber(cmp.previous, fmt)} {unit}</>}
      </div>
      {progress != null && (
        <div>
          <div className="mb-1 flex justify-between text-[11px] text-muted">
            <span>Ziel {formatNumber(target, fmt)} {unit}</span>
            <span>{formatNumber(progress * 100, { decimals: 0 })} %</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-line/50">
            <div className="h-full rounded-full transition-all" style={{ width: `${progress * 100}%`, background: src.color || theme.accent }} />
          </div>
        </div>
      )}
      {spark && cfg.sparkline !== false && (
        <div className="min-h-[28px] flex-1">
          <Spark values={spark.values} color={src.color || theme.accent} />
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Vergleichskarte

export function ComparisonWidget({ cfg, results, width, height }: WidgetProps) {
  const theme = useThemeTokens()
  const src = srcs(cfg)[0]
  const a = results.a?.ok ? (results.a.data as ScalarResult) : null
  const b = results.b?.ok ? (results.b.data as ScalarResult) : null
  const fmt = fmtOf(cfg)
  if (!src) return <NeedsConfig />
  if (!a || !b) return <ErrorNote text={results.a?.error || results.b?.error} />
  const covA = a.coverage ?? 1
  const covB = b.coverage ?? 1
  const thin = Math.min(covA, covB) < 0.8
  const pct = a.value != null && b.value != null && b.value !== 0 && Math.min(covA, covB) >= 0.5 ? ((a.value - b.value) / Math.abs(b.value)) * 100 : null
  const unit = unitOf(cfg, a.unit)
  const max = Math.max(Math.abs(a.value || 0), Math.abs(b.value || 0)) || 1
  const size = scaleFont(width, height, 0.45)
  const rows = [
    { label: cfg.labelA || rangeLabel(cfg.rangeA), v: a.value, color: src.color || theme.accent },
    { label: cfg.labelB || rangeLabel(cfg.rangeB), v: b.value, color: withAlpha(theme.muted, 0.8) },
  ]
  return (
    <div className="flex h-full flex-col justify-center gap-3">
      {rows.map((r, i) => (
        <div key={i}>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <MiniLabel>{r.label}</MiniLabel>
            <span className="font-semibold tabular-nums" style={{ fontSize: size }}>
              {formatNumber(r.v, fmt)} <span className="text-xs text-muted">{unit}</span>
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-line/40">
            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${(Math.abs(r.v || 0) / max) * 100}%`, background: r.color }} />
          </div>
        </div>
      ))}
      <div className="flex items-center justify-between text-xs text-muted">
        <span>Veränderung</span>
        <Delta pct={pct} invert={!!cfg.invertColors} />
      </div>
      {thin && (
        <div className="text-[11px] text-warn">
          Datenbasis unvollständig ({covA < 0.8 ? `A: ${Math.round(covA * 100)} %` : ''}{covA < 0.8 && covB < 0.8 ? ', ' : ''}{covB < 0.8 ? `B: ${Math.round(covB * 100)} %` : ''})
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Prozentanzeige

export function PercentWidget({ cfg, results, width, height }: WidgetProps) {
  const theme = useThemeTokens()
  const sources = srcs(cfg)
  const a = useLiveScalar(sources[0], results.s0)
  const b = useLiveScalar(sources[1], results.s1)
  if (!sources.length) return <NeedsConfig />
  let pct: number | null = null
  if (cfg.mode === 'ratio') pct = a.value != null && b.value ? (a.value / b.value) * 100 : null
  else if (cfg.mode === 'range') {
    const min = Number(cfg.min ?? 0)
    const max = Number(cfg.max ?? 100)
    pct = a.value != null ? ((a.value - min) / (max - min || 1)) * 100 : null
  } else pct = a.value
  const clamped = pct == null ? 0 : Math.max(0, Math.min(100, pct))
  const color = thresholdColor(pct, cfg) || sources[0]?.color || theme.accent
  const decimals = cfg.decimals === '' || cfg.decimals == null ? 0 : Number(cfg.decimals)
  if (cfg.display === 'bar') {
    return (
      <div className="flex h-full flex-col justify-center gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted">{cfg.subtitle || labelOf(sources[0], { name: a.name })}</span>
          <span className="font-semibold tabular-nums" style={{ fontSize: scaleFont(width, height, 0.5) }}>
            {formatNumber(pct, { decimals })} %
          </span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-line/40">
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${clamped}%`, background: `linear-gradient(90deg, ${withAlpha(color, 0.6)}, ${color})`, boxShadow: theme.glow ? `0 0 12px ${color}` : undefined }} />
        </div>
      </div>
    )
  }
  const size = Math.min(width, height) - 8
  const r = size / 2 - 10
  const c = 2 * Math.PI * r
  return (
    <div className="flex h-full items-center justify-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={withAlpha(theme.border, 0.5)} strokeWidth={10} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * c} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dasharray 0.8s ease', filter: theme.glow ? `drop-shadow(0 0 6px ${color})` : undefined }}
        />
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fill={theme.text} fontSize={Math.max(14, size / 5)} fontWeight={600}>
          {formatNumber(pct, { decimals })} %
        </text>
        {cfg.subtitle && (
          <text x="50%" y={size / 2 + Math.max(14, size / 5) * 0.85} textAnchor="middle" fill={theme.muted} fontSize={Math.max(10, size / 14)}>
            {cfg.subtitle}
          </text>
        )}
      </svg>
    </div>
  )
}

// ------------------------------------------------------------------ Trendanzeige

export function TrendWidget({ cfg, results, width, height }: WidgetProps) {
  const theme = useThemeTokens()
  const src = srcs(cfg)[0]
  const s = seriesOk(results.s0)
  const fmt = fmtOf(cfg)
  const stats = useMemo(() => {
    if (!s) return null
    const pts = s.values.map((v, i) => [i, v] as [number, number | null]).filter((p): p is [number, number] => p[1] != null)
    if (pts.length < 2) return { slope: 0, pct: null, first: null, last: null }
    const n = pts.length
    const sx = pts.reduce((a, p) => a + p[0], 0)
    const sy = pts.reduce((a, p) => a + p[1], 0)
    const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0)
    const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0)
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1)
    const intercept = (sy - slope * sx) / n
    const startFit = intercept + slope * pts[0][0]
    const endFit = intercept + slope * pts[n - 1][0]
    const pct = startFit !== 0 ? ((endFit - startFit) / Math.abs(startFit)) * 100 : null
    return { slope, pct, first: pts[0][1], last: pts[n - 1][1] }
  }, [s])
  if (!src) return <NeedsConfig />
  if (!s || !stats) return <ErrorNote text={results.s0?.error} />
  const up = (stats.pct ?? 0) > 1
  const down = (stats.pct ?? 0) < -1
  const good = cfg.invertColors ? up : down
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus
  const color = !up && !down ? theme.muted : good ? (theme.mode === 'dark' ? '#4ade80' : '#16a34a') : theme.mode === 'dark' ? '#f87171' : '#dc2626'
  return (
    <div className="flex h-full flex-col gap-1">
      <div className="flex items-center gap-3">
        <Icon className="shrink-0" style={{ color, width: scaleFont(width, height, 0.6), height: scaleFont(width, height, 0.6) }} />
        <div>
          <div className="font-semibold tabular-nums" style={{ fontSize: scaleFont(width, height, 0.45), color }}>
            {formatPct(stats.pct, 1)}
          </div>
          <div className="text-xs text-muted">
            Trend {rangeLabel(cfg.range)} · {formatNumber(stats.last, fmt)} {unitOf(cfg, s.unit)}
          </div>
        </div>
      </div>
      <div className="min-h-[24px] flex-1">
        <Spark values={s.values} color={src.color || theme.accent} />
      </div>
    </div>
  )
}
