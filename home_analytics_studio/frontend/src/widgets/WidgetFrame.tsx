import clsx from 'clsx'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Widget } from '../api/types'
import { Spinner } from '../components/ui'
import { useThemeTokens } from '../theme/context'
import { shadowFor, withAlpha } from '../theme/presets'
import { widgetDef } from './registry'
import { useLiveRefresh } from './liveRefresh'
import { useWidgetData } from './useWidgetData'

class Boundary extends React.Component<{ children: React.ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }
  render() {
    if (this.state.error) return <div className="p-2 text-xs text-bad">Darstellungsfehler: {this.state.error.message}</div>
    return this.props.children
  }
}

function useSize(ref: React.RefObject<HTMLElement>) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({ width: Math.round(r.width), height: Math.round(r.height) })
    })
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [ref])
  return size
}

export function widgetStyle(widget: Widget, theme: ReturnType<typeof useThemeTokens>): React.CSSProperties {
  const st = widget.style || {}
  const css: React.CSSProperties = {}
  const bg = st.background
  if (bg) {
    if (/^#[0-9a-f]{6}$/i.test(bg)) css.background = withAlpha(bg, st.opacity ?? theme.surfaceOpacity)
    else css.background = bg
  } else if (st.opacity != null) {
    css.background = `rgb(var(--c-surface) / ${st.opacity})`
  }
  if (st.blur != null) {
    css.backdropFilter = `blur(${st.blur}px)`
    ;(css as any).WebkitBackdropFilter = `blur(${st.blur}px)`
  }
  if (st.borderColor) css.borderColor = st.borderColor
  if (st.borderWidth != null) css.borderWidth = st.borderWidth
  if (st.radius != null) css.borderRadius = st.radius
  if (st.shadow && st.shadow !== 'theme') css.boxShadow = shadowFor(st.shadow, st.accent || theme.accent)
  if (st.textColor) css.color = st.textColor
  return css
}

export default function WidgetFrame({ widget, editing, selected, chrome = true }: { widget: Widget; editing?: boolean; selected?: boolean; chrome?: boolean }) {
  const def = widgetDef(widget.type)
  const theme = useThemeTokens()
  const bodyRef = useRef<HTMLDivElement>(null)
  const { width, height } = useSize(bodyRef)
  const cfg = useMemo(() => ({ ...(def?.defaults || {}), ...widget.config }), [def, widget.config])
  const requests = useMemo(() => (def ? def.requests(cfg) : []), [def, cfg])
  const bump = useLiveRefresh(cfg, requests.length > 0 && cfg.liveRefresh !== false)
  const { results, loading } = useWidgetData(requests, Number(cfg.refresh) || 60, bump)
  const st = widget.style || {}
  const transparent = st.background === 'transparent'
  const showTitle = !st.hideTitle && !!widget.title
  const pad = st.padding ?? 14

  if (!def) return <div className="panel p-3 text-xs text-bad">Unbekannter Widget-Typ: {widget.type}</div>

  const Comp = def.Component
  return (
    <div
      className={clsx(
        'flex h-full w-full flex-col overflow-hidden',
        !transparent && chrome && 'panel',
        transparent && 'rounded-theme',
        selected && 'widget-selected',
        theme.animations && 'anim-fade',
      )}
      style={{ ...(chrome ? widgetStyle(widget, theme) : {}), padding: pad }}
    >
      {showTitle && (
        <div className="mb-1.5 flex shrink-0 items-center gap-2" style={{ justifyContent: st.titleAlign === 'center' ? 'center' : st.titleAlign === 'right' ? 'flex-end' : 'flex-start' }}>
          <h3 className="truncate text-muted" style={{ fontSize: (st.titleSize || 13) * Number(theme.fontScale || 1), fontWeight: theme.titleWeight, letterSpacing: '0.02em' }}>
            {widget.title}
          </h3>
          {loading && Object.keys(results).length > 0 && <Spinner className="h-3 w-3 opacity-60" />}
        </div>
      )}
      <div ref={bodyRef} className={clsx('relative min-h-0 flex-1', editing && 'pointer-events-none')}>
        {loading && Object.keys(results).length === 0 && requests.length > 0 ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : width > 0 && height > 0 ? (
          <Boundary resetKey={JSON.stringify(widget.config)}>
            <Comp widget={widget} cfg={cfg} results={results} loading={loading} width={width} height={height} />
          </Boundary>
        ) : null}
      </div>
    </div>
  )
}
