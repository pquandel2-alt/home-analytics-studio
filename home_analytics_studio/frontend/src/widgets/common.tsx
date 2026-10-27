import clsx from 'clsx'
import { AlertTriangle } from 'lucide-react'
import type React from 'react'
import { numericState, useLiveEntities } from '../api/live'
import type { ScalarResult, SeriesResult, Source, ThemeTokens } from '../api/types'
import { useRuntime } from '../theme/context'
import { withAlpha } from '../theme/presets'
import { formatNumber, labelFormatter, tickFormatter, type NumberFormat } from '../utils/format'
import type { BatchResult } from './types'

export function fmtOf(cfg: Record<string, any>): NumberFormat {
  return {
    decimals: cfg.decimals === '' || cfg.decimals == null ? null : Number(cfg.decimals),
    thousands: cfg.thousands !== false,
    compact: !!cfg.compact,
    prefix: cfg.prefix || '',
    suffix: cfg.suffix || '',
  }
}

export function unitOf(cfg: Record<string, any>, fallback?: string | null): string {
  if (cfg.unit === '-') return ''
  return cfg.unit || fallback || ''
}

export function paletteOf(cfg: Record<string, any>, theme: ThemeTokens): string[] {
  const custom = (cfg.colors as string[] | undefined)?.filter(Boolean)
  return custom && custom.length ? [...custom, ...theme.palette] : theme.palette
}

export function colorFor(i: number, src: Source | undefined, cfg: Record<string, any>, theme: ThemeTokens): string {
  return src?.color || paletteOf(cfg, theme)[i % paletteOf(cfg, theme).length]
}

export function labelOf(src: Source | undefined, res?: { name?: string | null } | null): string {
  return src?.label || res?.name || src?.id || ''
}

export function ErrorNote({ text }: { text?: string }) {
  if (!text) return null
  return (
    <div className="flex h-full items-center justify-center gap-2 p-2 text-center text-xs text-warn">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="line-clamp-3">{text}</span>
    </div>
  )
}

export function NeedsConfig({ text = 'Datenquelle im Editor wählen' }: { text?: string }) {
  return <div className="flex h-full items-center justify-center p-2 text-center text-xs text-muted">{text}</div>
}

/** Big number display with unit; size adapts to widget size. */
export function BigValue({
  value,
  unit,
  fmt,
  size,
  color,
  className,
}: {
  value: number | null | undefined
  unit?: string | null
  fmt: NumberFormat
  size: number
  color?: string
  className?: string
}) {
  return (
    <div className={clsx('flex items-baseline gap-1.5 leading-none', className)} style={{ color }}>
      <span className="font-semibold tabular-nums tracking-tight" style={{ fontSize: size }}>
        {formatNumber(value, fmt)}
      </span>
      {unit && value != null && (
        <span className="font-medium text-muted" style={{ fontSize: Math.max(11, size * 0.38) }}>
          {unit}
        </span>
      )}
    </div>
  )
}

/** For entity sources with stat "current": live value from the websocket, else the scalar result. */
export function useLiveScalar(src: Source | undefined, res: BatchResult<ScalarResult> | undefined): { value: number | null; unit: string | null; name: string } {
  const isLive = !!src && src.type === 'entity' && src.stat === 'current'
  const states = useLiveEntities(isLive && src ? [src.id] : [])
  const scalar = res?.ok ? res.data : undefined
  if (isLive && src) {
    const st = states[src.id]
    const v = numericState(st)
    if (st !== undefined && v != null) {
      return { value: v, unit: scalar?.unit ?? st?.attributes?.unit_of_measurement ?? null, name: scalar?.name || st?.attributes?.friendly_name || src.id }
    }
  }
  return { value: scalar?.value ?? null, unit: scalar?.unit ?? null, name: scalar?.name || src?.id || '' }
}

export function scaleFont(width: number, height: number, factor = 1): number {
  return Math.max(16, Math.min(96, Math.min(width / 6, height / 2.6) * factor))
}

export function chartBase(theme: ThemeTokens, cfg: Record<string, any>): Record<string, any> {
  const text = theme.text
  const muted = theme.muted
  return {
    animation: cfg.animation !== false && theme.animations,
    animationDuration: 600,
    textStyle: { fontFamily: theme.font, color: text },
    grid: { left: 8, right: 12, top: cfg.showLegend === false ? 14 : 34, bottom: 6, containLabel: true },
    legend: {
      show: cfg.showLegend !== false,
      top: 0,
      textStyle: { color: muted, fontSize: 11 },
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: withAlpha(theme.mode === 'dark' ? '#0b1020' : '#ffffff', 0.94),
      borderColor: withAlpha(theme.border, 0.8),
      textStyle: { color: text, fontSize: 12 },
      confine: true,
    },
  }
}

export function axisStyle(theme: ThemeTokens, cfg: Record<string, any>) {
  return {
    axisLine: { lineStyle: { color: withAlpha(theme.border, 0.9) } },
    axisLabel: { color: theme.muted, fontSize: 11 },
    splitLine: { show: cfg.showGrid !== false, lineStyle: { color: withAlpha(theme.border, 0.45), type: 'dashed' } },
    axisTick: { show: false },
  }
}

export function useTimeFormatters(interval: string) {
  const rt = useRuntime()
  return { tick: tickFormatter(interval, rt.timezone), label: labelFormatter(interval, rt.timezone) }
}

export function seriesOk(r: BatchResult | undefined): SeriesResult | null {
  return r?.ok && r.data ? (r.data as SeriesResult) : null
}

export function firstError(results: Record<string, BatchResult>): string | undefined {
  return Object.values(results).find((r) => r && !r.ok)?.error
}

export function Delta({ pct, invert, className }: { pct: number | null | undefined; invert?: boolean; className?: string }) {
  if (pct == null || !Number.isFinite(pct)) return <span className={clsx('text-xs text-muted', className)}>–</span>
  const up = pct > 0
  const good = invert ? !up : up
  return (
    <span className={clsx('inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums', Math.abs(pct) < 0.05 ? 'bg-fg/10 text-muted' : good ? 'bg-ok/15 text-ok' : 'bg-bad/15 text-bad', className)}>
      {up ? '▲' : pct < 0 ? '▼' : '■'} {formatNumber(Math.abs(pct), { decimals: Math.abs(pct) < 10 ? 1 : 0 })} %
    </span>
  )
}

export function MiniLabel({ children }: { children: React.ReactNode }) {
  return <div className="truncate text-[11px] uppercase tracking-wider text-muted">{children}</div>
}
