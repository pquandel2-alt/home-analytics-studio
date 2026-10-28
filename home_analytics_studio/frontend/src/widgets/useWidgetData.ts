import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import { useRuntime } from '../theme/context'
import type { BatchResult, DataRequest } from './types'

/** Fetches all data requests of a widget in one batch call and refreshes periodically. */
export function useWidgetData(requests: DataRequest[], refreshSeconds: number, bump = 0) {
  const runtime = useRuntime()
  const key = useMemo(() => JSON.stringify(requests), [requests])
  const [results, setResults] = useState<Record<string, BatchResult>>({})
  const [loading, setLoading] = useState(requests.length > 0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    const reqs: DataRequest[] = JSON.parse(key)
    if (!reqs.length) {
      setResults({})
      setLoading(false)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const res = await api.post<{ results: BatchResult[] }>('data/batch', {
          requests: reqs.map(({ key: _k, ...r }) => r),
        })
        if (cancelled || !alive.current) return
        const map: Record<string, BatchResult> = {}
        reqs.forEach((r, i) => (map[r.key] = res.results[i]))
        setResults(map)
      } catch (e) {
        if (cancelled || !alive.current) return
        const map: Record<string, BatchResult> = {}
        reqs.forEach((r) => (map[r.key] = { ok: false, error: e instanceof Error ? e.message : String(e) }))
        setResults(map)
      } finally {
        if (!cancelled && alive.current) setLoading(false)
      }
    }
    setLoading(true)
    load()
    const sec = Math.max(5, refreshSeconds || 60)
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, sec * 1000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [key, refreshSeconds, runtime.refreshNonce, bump])

  return { results, loading }
}
