export interface NumberFormat {
  decimals?: number | null
  thousands?: boolean
  compact?: boolean
  prefix?: string
  suffix?: string
  locale?: string
}

const DEFAULT_LOCALE = 'de-DE'

export function autoDecimals(v: number): number {
  const a = Math.abs(v)
  if (a >= 1000) return 0
  if (a >= 100) return 1
  if (a >= 1) return 2
  if (a === 0) return 0
  return 3
}

export function formatNumber(v: number | null | undefined, fmt: NumberFormat = {}): string {
  if (v == null || !Number.isFinite(v)) return '–'
  const decimals = fmt.decimals == null || (fmt.decimals as unknown) === '' ? autoDecimals(v) : Number(fmt.decimals)
  let s: string
  if (fmt.compact && Math.abs(v) >= 1000) {
    s = new Intl.NumberFormat(fmt.locale || DEFAULT_LOCALE, {
      notation: 'compact',
      maximumFractionDigits: Math.max(1, decimals),
    }).format(v)
  } else {
    s = new Intl.NumberFormat(fmt.locale || DEFAULT_LOCALE, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
      useGrouping: fmt.thousands !== false,
    }).format(v)
  }
  return `${fmt.prefix || ''}${s}${fmt.suffix || ''}`
}

export function formatValue(v: number | null | undefined, unit?: string | null, fmt: NumberFormat = {}): string {
  const s = formatNumber(v, fmt)
  return unit && s !== '–' ? `${s} ${unit}` : s
}

export function formatPct(v: number | null | undefined, decimals = 1, signed = true): string {
  if (v == null || !Number.isFinite(v)) return '–'
  const s = formatNumber(Math.abs(v), { decimals })
  if (!signed) return `${s} %`
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${s} %`
}

export function formatBytes(b: number | null | undefined): string {
  if (!b) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = b
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${formatNumber(v, { decimals: i ? 1 : 0 })} ${units[i]}`
}

export function formatTs(ts: number | null | undefined, opts: Intl.DateTimeFormatOptions = {}, tz?: string): string {
  if (!ts) return '–'
  const ms = ts > 1e11 ? ts : ts * 1000
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: tz,
    ...opts,
  }).format(new Date(ms))
}

export function formatAge(ts: number | null | undefined): string {
  if (!ts) return '–'
  const ms = ts > 1e11 ? ts : ts * 1000
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return `vor ${s} s`
  if (s < 3600) return `vor ${Math.round(s / 60)} min`
  if (s < 86400) return `vor ${Math.round(s / 3600)} h`
  return `vor ${Math.round(s / 86400)} Tagen`
}

/** Axis label formatter by interval. */
export function tickFormatter(interval: string, tz?: string) {
  const o: Intl.DateTimeFormatOptions =
    interval === '1y'
      ? { year: 'numeric' }
      : interval === '1mo'
        ? { month: 'short', year: '2-digit' }
        : interval === '1d' || interval === '1w'
          ? { day: '2-digit', month: '2-digit' }
          : { hour: '2-digit', minute: '2-digit' }
  const f = new Intl.DateTimeFormat(DEFAULT_LOCALE, { ...o, timeZone: tz })
  return (ts: number) => f.format(new Date(ts > 1e11 ? ts : ts * 1000))
}

export function labelFormatter(interval: string, tz?: string) {
  const o: Intl.DateTimeFormatOptions =
    interval === '1y'
      ? { year: 'numeric' }
      : interval === '1mo'
        ? { month: 'long', year: 'numeric' }
        : interval === '1d'
          ? { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }
          : interval === '1w'
            ? { day: '2-digit', month: '2-digit', year: 'numeric' }
            : { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
  const f = new Intl.DateTimeFormat(DEFAULT_LOCALE, { ...o, timeZone: tz })
  return (ts: number) => (interval === '1w' ? 'KW ab ' : '') + f.format(new Date(ts > 1e11 ? ts : ts * 1000))
}

export const RANGE_PRESETS: { value: string; label: string }[] = [
  { value: 'last_1h', label: 'Letzte Stunde' },
  { value: 'last_6h', label: 'Letzte 6 Stunden' },
  { value: 'last_24h', label: 'Letzte 24 Stunden' },
  { value: 'last_48h', label: 'Letzte 48 Stunden' },
  { value: 'today', label: 'Heute' },
  { value: 'yesterday', label: 'Gestern' },
  { value: 'last_7d', label: 'Letzte 7 Tage' },
  { value: 'this_week', label: 'Diese Woche' },
  { value: 'last_week', label: 'Letzte Woche' },
  { value: 'last_30d', label: 'Letzte 30 Tage' },
  { value: 'this_month', label: 'Dieser Monat' },
  { value: 'last_month', label: 'Letzter Monat' },
  { value: 'last_90d', label: 'Letzte 90 Tage' },
  { value: 'this_year', label: 'Dieses Jahr' },
  { value: 'last_year', label: 'Letztes Jahr' },
  { value: 'last_365d', label: 'Letzte 365 Tage' },
  { value: 'all', label: 'Gesamter Zeitraum' },
]

export const INTERVALS: { value: string; label: string }[] = [
  { value: 'auto', label: 'Automatisch' },
  { value: '1min', label: 'Minute' },
  { value: '5min', label: '5 Minuten' },
  { value: '15min', label: '15 Minuten' },
  { value: '30min', label: '30 Minuten' },
  { value: '1h', label: 'Stunde' },
  { value: '1d', label: 'Tag' },
  { value: '1w', label: 'Woche' },
  { value: '1mo', label: 'Monat' },
  { value: '1y', label: 'Jahr' },
]

export function rangeLabel(r: unknown): string {
  if (typeof r === 'string') return RANGE_PRESETS.find((p) => p.value === r)?.label || r
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>
    if (o.preset) return rangeLabel(o.preset) + (o.offset ? ` (${o.offset})` : '')
    if (o.last) return `Letzte ${o.last}`
    if (o.start) return `${o.start} – ${o.end || 'jetzt'}`
  }
  return ''
}

export function uid(prefix = 'w'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`
}
