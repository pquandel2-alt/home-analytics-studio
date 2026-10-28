import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { useLiveEntities } from '../api/live'
import type { Source } from '../api/types'

// entity dependencies of metrics (loaded once, also available to read-only displays)
let metricDeps: Record<string, string[]> | null = null
let loading: Promise<void> | null = null
const waiters = new Set<() => void>()

function loadMetricDeps() {
  if (metricDeps || loading) return
  loading = api
    .get<{ key: string; entities?: string[] }[]>('metrics')
    .then((list) => {
      metricDeps = Object.fromEntries(list.map((m) => [m.key, m.entities || []]))
    })
    .catch(() => {
      metricDeps = {}
    })
    .finally(() => waiters.forEach((w) => w()))
}

const ENTITY_RE = /\{?\s*([a-z_][a-z0-9_]*\.[a-z0-9_]+(?:::[a-z0-9_]+)?)\s*\}?/g

/** All entities a widget's numbers depend on (sources, slots, metric formulas, ad-hoc formulas). */
export function widgetEntities(cfg: Record<string, any>, deps: Record<string, string[]> | null): string[] {
  const out = new Set<string>()
  const srcs: Source[] = [...((cfg.sources as Source[]) || []), ...(Object.values(cfg.slots || {}) as Source[])]
  for (const s of srcs) {
    if (!s?.id) continue
    if (s.type === 'entity') out.add(s.id)
    else if (s.type === 'metric') (deps?.[s.id] || []).forEach((e) => out.add(e))
    else if (s.type === 'formula' && s.formula) for (const m of s.formula.matchAll(ENTITY_RE)) out.add(m[1])
  }
  return [...out].sort()
}

/**
 * Returns a counter that increases shortly after any entity the widget depends on changes in Home
 * Assistant – widgets re-evaluate immediately instead of waiting for their polling interval.
 * Debounced (1.5 s) and throttled (max. every 5 s) to protect low-power hardware.
 */
export function useLiveRefresh(cfg: Record<string, any>, enabled: boolean): number {
  const [, setReady] = useState(0)
  useEffect(() => {
    if (metricDeps) return
    const w = () => setReady((x) => x + 1)
    waiters.add(w)
    loadMetricDeps()
    return () => {
      waiters.delete(w)
    }
  }, [])
  const ids = useMemo(() => (enabled ? widgetEntities(cfg, metricDeps) : []), [cfg, enabled, metricDeps])
  const states = useLiveEntities(ids)
  const signature = ids.map((id) => states[id]?.last_updated || '').join('|')
  const [bump, setBump] = useState(0)
  const first = useRef(true)
  const last = useRef(0)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (!signature.replace(/\|/g, '')) return
    const wait = Math.max(1500, 5000 - (Date.now() - last.current))
    const t = window.setTimeout(() => {
      last.current = Date.now()
      setBump((b) => b + 1)
    }, wait)
    return () => window.clearTimeout(t)
  }, [signature])
  return bump
}
