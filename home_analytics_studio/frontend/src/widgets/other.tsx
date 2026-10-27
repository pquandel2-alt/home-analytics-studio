import clsx from 'clsx'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Info } from 'lucide-react'
import { useEffect, useState } from 'react'
import { assetUrl } from '../api/client'
import { ICONS } from '../utils/icons'
import { numericState, useLiveEntities } from '../api/live'
import type { AnalysisResult, ScalarResult, SeriesResult, Source } from '../api/types'
import { useRuntime, useThemeTokens } from '../theme/context'
import { formatNumber, formatPct, labelFormatter } from '../utils/format'
import { ErrorNote, NeedsConfig, colorFor, fmtOf, labelOf, scaleFont, seriesOk, unitOf } from './common'
import type { WidgetProps } from './types'

function srcs(cfg: Record<string, any>): Source[] {
  return ((cfg.sources as Source[]) || []).filter((s) => s && s.id)
}

// ------------------------------------------------------------------ Tabelle

export function TableWidget({ cfg, results }: WidgetProps) {
  const theme = useThemeTokens()
  const sources = srcs(cfg)
  const fmt = fmtOf(cfg)
  const states = useLiveEntities(sources.filter((s) => s.type === 'entity').map((s) => s.id))
  if (!sources.length) return <NeedsConfig />
  const cols: string[] = cfg.columns || ['current', 'min', 'mean', 'max', 'total']
  const LABEL: Record<string, string> = { current: 'Aktuell', min: 'Min', mean: 'Ø', max: 'Max', total: 'Summe/Verbrauch', last: 'Letzter' }
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface/80 backdrop-blur">
          <tr className="text-[11px] uppercase tracking-wider text-muted">
            <th className="py-1.5 text-left font-medium">Quelle</th>
            {cols.map((c) => (
              <th key={c} className="py-1.5 text-right font-medium">{LABEL[c] || c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sources.map((s, i) => {
            const get = (c: string) => {
              if (c === 'current') {
                const v = s.type === 'entity' ? numericState(states[s.id]) : null
                if (v != null) return v
              }
              const r = results[`s${i}_${c}`]
              return r?.ok ? (r.data as ScalarResult).value : null
            }
            const unitRes = results[`s${i}_mean`] || results[`s${i}_total`] || results[`s${i}_current`]
            const unit = unitOf(cfg, unitRes?.ok ? (unitRes.data as ScalarResult).unit : null)
            const name = labelOf(s, unitRes?.ok ? (unitRes.data as ScalarResult) : null)
            return (
              <tr key={i} className="border-t border-line/30">
                <td className="max-w-[12rem] truncate py-1.5" title={s.id}>
                  <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: colorFor(i, s, cfg, theme) }} />
                  {name}
                </td>
                {cols.map((c) => (
                  <td key={c} className="py-1.5 text-right tabular-nums">
                    {formatNumber(get(c), fmt)} <span className="text-xs text-muted">{unit}</span>
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ Historische Daten

export function HistoryWidget({ cfg, results }: WidgetProps) {
  const rt = useRuntime()
  const sources = srcs(cfg)
  const fmt = fmtOf(cfg)
  const series = sources.map((_, i) => seriesOk(results[`s${i}`]))
  const first = series.find(Boolean) as SeriesResult | undefined
  if (!sources.length) return <NeedsConfig />
  if (!first) return <ErrorNote text={Object.values(results).find((r) => !r?.ok)?.error} />
  const lab = labelFormatter(first.interval, rt.timezone)
  const rows = first.ts.map((t, idx) => ({ t, vals: series.map((s) => s?.values[idx] ?? null) }))
  const ordered = cfg.newestFirst !== false ? rows.reverse() : rows
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-surface/90 backdrop-blur">
          <tr className="text-[11px] uppercase tracking-wider text-muted">
            <th className="py-1.5 text-left font-medium">Zeit</th>
            {sources.map((s, i) => (
              <th key={i} className="py-1.5 text-right font-medium">
                {labelOf(s, series[i])} {series[i]?.unit ? `[${unitOf(cfg, series[i]?.unit)}]` : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr key={r.t} className="border-t border-line/20">
              <td className="whitespace-nowrap py-1 text-muted">{lab(r.t)}</td>
              {r.vals.map((v, i) => (
                <td key={i} className="py-1 text-right tabular-nums">{formatNumber(v, fmt)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------------ Statistikübersicht

export function StatsWidget({ cfg, results }: WidgetProps) {
  const src = srcs(cfg)[0]
  const fmt = fmtOf(cfg)
  if (!src) return <NeedsConfig />
  const get = (k: string) => (results[k]?.ok ? (results[k].data as ScalarResult) : null)
  const unit = unitOf(cfg, get('mean')?.unit || get('total')?.unit)
  const cov = get('coverage')?.value
  const daily = seriesOk(results.daily)
  const isCounter = !!daily && daily.kind !== 'measurement' && daily.kind !== 'metric'
  // counters: statistics per (complete) day instead of time weighted readings
  const days = isCounter && daily ? daily.values.filter((v, i) => v != null && (daily.coverage?.[i] ?? 1) >= 0.8) as number[] : []
  const dayVal: Record<string, number | null> = {
    mean: days.length ? days.reduce((a, b) => a + b, 0) / days.length : null,
    min: days.length ? Math.min(...days) : null,
    max: days.length ? Math.max(...days) : null,
  }
  const items = [
    { k: 'total', label: isCounter ? 'Verbrauch gesamt' : 'Summe / Verbrauch' },
    { k: 'mean', label: isCounter ? 'Ø pro Tag' : 'Durchschnitt' },
    { k: 'min', label: isCounter ? 'Niedrigster Tag' : 'Minimum' },
    { k: 'max', label: isCounter ? 'Höchster Tag' : 'Maximum' },
    { k: 'last', label: isCounter ? 'Zählerstand' : 'Letzter Wert' },
  ].filter((i) => results[i.k])
  const valueOf = (k: string) => (isCounter && k in dayVal ? dayVal[k] : get(k)?.value)
  return (
    <div className="grid h-full grid-cols-2 content-center gap-2">
      {items.map((i) => (
        <div key={i.k} className="rounded-lg border border-line/40 bg-fg/[0.03] p-2.5">
          <div className="text-[11px] uppercase tracking-wider text-muted">{i.label}</div>
          <div className="text-lg font-semibold tabular-nums">
            {formatNumber(valueOf(i.k), fmt)} <span className="text-xs text-muted">{unit}</span>
          </div>
        </div>
      ))}
      <div className="rounded-lg border border-line/40 bg-fg/[0.03] p-2.5">
        <div className="text-[11px] uppercase tracking-wider text-muted">{isCounter ? 'Tage / Abdeckung' : 'Messwerte / Abdeckung'}</div>
        <div className="text-lg font-semibold tabular-nums">
          {formatNumber(isCounter ? days.length : get('mean')?.count ?? get('total')?.count ?? null, { decimals: 0 })}{' '}
          <span className="text-xs text-muted">{cov != null ? `· ${formatNumber(cov * 100, { decimals: 0 })} %` : ''}</span>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ Text (Markdown-light, sicher)

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function renderMarkdown(src: string, values: Record<string, string> = {}): string {
  const withVals = src.replace(/\{\{\s*([a-z_]+\.[a-z0-9_]+)\s*\}\}/g, (_, id) => values[id] ?? '–')
  const lines = escapeHtml(withVals).split('\n')
  const out: string[] = []
  let inList = false
  const inline = (t: string) =>
    t
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.*)$/.exec(line)
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`)
      continue
    }
    if (inList) {
      out.push('</ul>')
      inList = false
    }
    if (m) out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`)
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`)
  }
  if (inList) out.push('</ul>')
  return out.join('')
}

export function TextWidget({ cfg }: WidgetProps) {
  const text: string = cfg.text || ''
  const ids = [...text.matchAll(/\{\{\s*([a-z_]+\.[a-z0-9_]+)\s*\}\}/g)].map((m) => m[1])
  const states = useLiveEntities(ids)
  const values: Record<string, string> = {}
  for (const id of ids) {
    const st = states[id]
    const v = numericState(st)
    values[id] = st ? (v != null ? `${formatNumber(v, fmtOf(cfg))} ${st.attributes?.unit_of_measurement || ''}`.trim() : String(st.state)) : '–'
  }
  return (
    <div
      className="prose-widget h-full overflow-auto"
      style={{ fontSize: `${cfg.fontSize || 14}px`, textAlign: cfg.align || 'left' }}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(text, values) }}
    />
  )
}

export function HeadingWidget({ cfg, width, height }: WidgetProps) {
  const theme = useThemeTokens()
  const size = cfg.fontSize || Math.max(18, Math.min(64, height * 0.45, width / 10))
  return (
    <div className={clsx('flex h-full flex-col justify-center', cfg.align === 'center' && 'items-center text-center', cfg.align === 'right' && 'items-end text-right')}>
      <div className={clsx('font-semibold tracking-tight', theme.glow && 'glow-text')} style={{ fontSize: size, color: cfg.color || undefined, letterSpacing: cfg.uppercase ? '0.12em' : undefined, textTransform: cfg.uppercase ? 'uppercase' : undefined }}>
        {cfg.text || 'Überschrift'}
      </div>
      {cfg.subtitle && <div className="mt-1 text-sm text-muted">{cfg.subtitle}</div>}
      {cfg.underline !== false && <div className="mt-2 h-[3px] w-16 rounded-full" style={{ background: `linear-gradient(90deg, rgb(var(--c-accent)), rgb(var(--c-accent2)))` }} />}
    </div>
  )
}

export function ImageWidget({ cfg }: WidgetProps) {
  if (!cfg.url) return <NeedsConfig text="Bild-URL angeben oder Bild hochladen" />
  return <img src={assetUrl(cfg.url)} alt={cfg.alt || ''} className="h-full w-full" style={{ objectFit: cfg.fit || 'cover', borderRadius: cfg.rounded ? 'calc(var(--radius) * 0.7)' : undefined, opacity: cfg.imageOpacity ?? 1 }} />
}

export function ClockWidget({ cfg, width, height }: WidgetProps) {
  const rt = useRuntime()
  const theme = useThemeTokens()
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const tz = cfg.timezone || rt.timezone
  const time = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', second: cfg.seconds ? '2-digit' : undefined, timeZone: tz }).format(now)
  const date = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: cfg.year ? 'numeric' : undefined, timeZone: tz }).format(now)
  const size = scaleFont(width, height, 1.1)
  return (
    <div className={clsx('flex h-full flex-col justify-center', cfg.align !== 'left' && 'items-center text-center')}>
      {cfg.mode !== 'date' && <div className={clsx('font-semibold tabular-nums tracking-tight', theme.glow && 'glow-text')} style={{ fontSize: size }}>{time}</div>}
      {cfg.mode !== 'time' && <div className="text-muted" style={{ fontSize: Math.max(12, size * (cfg.mode === 'date' ? 0.5 : 0.25)) }}>{date}</div>}
    </div>
  )
}

export function InfoWidget({ cfg }: WidgetProps) {
  const theme = useThemeTokens()
  const src = srcs(cfg)[0]
  const states = useLiveEntities(src && src.type === 'entity' ? [src.id] : [])
  const Icon = ICONS[cfg.icon || 'Info'] || Info
  const st = src ? states[src.id] : undefined
  const v = numericState(st)
  const tone = cfg.tone || 'accent'
  const color = { accent: theme.accent, ok: '#4ade80', warn: '#fbbf24', bad: '#f87171', muted: theme.muted }[tone as string] || theme.accent
  return (
    <div className="flex h-full items-start gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: `${color}22`, color }}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        {cfg.headline && <div className="font-semibold">{cfg.headline}</div>}
        {cfg.text && <div className="mt-0.5 whitespace-pre-line text-sm text-muted">{cfg.text}</div>}
        {src && (
          <div className="mt-1.5 text-sm">
            <span className="text-muted">{src.label || st?.attributes?.friendly_name || src.id}: </span>
            <b className="tabular-nums">{v != null ? formatNumber(v, fmtOf(cfg)) : st?.state ?? '–'}</b> {st?.attributes?.unit_of_measurement || ''}
          </div>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ Analyse-Ergebnis

export function AnalysisWidget({ cfg, results }: WidgetProps) {
  const src = srcs(cfg)[0]
  const r = results.analysis
  if (!src) return <NeedsConfig />
  if (!r) return null
  if (!r.ok) return <ErrorNote text={r.error} />
  const data = r.data as AnalysisResult
  const allowed: string[] = cfg.severities || ['up', 'down', 'warning', 'info']
  const items = data.insights.filter((i) => allowed.includes(i.severity)).slice(0, Number(cfg.maxItems) || 6)
  const week = data.comparisons?.week
  return (
    <div className="flex h-full flex-col gap-2 overflow-auto">
      {cfg.showSummary !== false && week && (
        <div className="flex items-center justify-between rounded-lg bg-fg/[0.04] px-3 py-2 text-sm">
          <span className="text-muted">{data.name} · diese Woche</span>
          <span className="font-semibold tabular-nums">
            {formatNumber(week.current, fmtOf(cfg))} {data.unit} <span className={clsx('ml-1 text-xs', (week.change_pct ?? 0) > 0 ? 'text-warn' : 'text-ok')}>{formatPct(week.change_pct)}</span>
          </span>
        </div>
      )}
      {items.length === 0 && <div className="text-sm text-muted">Noch keine ausreichenden Daten für Erkenntnisse.</div>}
      {items.map((i) => (
        <div key={i.id} className="flex gap-2.5 text-sm leading-snug">
          <span className={clsx('mt-0.5 shrink-0', i.severity === 'up' && 'text-warn', i.severity === 'down' && 'text-ok', i.severity === 'warning' && 'text-bad', i.severity === 'info' && 'text-accent')}>
            {i.severity === 'up' ? <ArrowUpRight className="h-4 w-4" /> : i.severity === 'down' ? <ArrowDownRight className="h-4 w-4" /> : i.severity === 'warning' ? <AlertTriangle className="h-4 w-4" /> : <Info className="h-4 w-4" />}
          </span>
          <span>{i.text}</span>
        </div>
      ))}
    </div>
  )
}
