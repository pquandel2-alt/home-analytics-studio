import clsx from 'clsx'
import { ChevronLeft, ChevronRight, Maximize, Minimize, Pause, Play, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, getShareToken } from '../api/client'
import type { Dashboard } from '../api/types'
import { Empty, IconButton, Spinner } from '../components/ui'
import GridCanvas from '../dashboard/GridCanvas'
import ThemedSurface from '../dashboard/ThemedSurface'
import { completeLayouts } from '../dashboard/editorStore'
import { useApp } from '../store/app'
import { RuntimeContext } from '../theme/context'

/** Fullscreen presentation / kiosk mode: hidden navigation, auto page rotation, auto refresh, scaling. */
export default function PresentPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const kiosk = params.get('kiosk') === '1' || !!getShareToken()
  const timezone = useApp((s) => s.appearance?.timezone)
  const currency = useApp((s) => s.appearance?.general?.currency) || '€'
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [nonce, setNonce] = useState(0)
  const [controls, setControls] = useState(true)
  const [isFull, setIsFull] = useState(false)
  const [fit, setFit] = useState(params.get('fit') !== '0')
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })
  const hideTimer = useRef<number | null>(null)
  const [now, setNow] = useState(new Date())

  const load = useCallback(async () => {
    try {
      setDash(await api.get<Dashboard>(`dashboards/${id}`))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const pages = useMemo(() => {
    if (!dash) return []
    const sel = dash.settings.presentation.pages
    return dash.pages.filter((p) => !p.hidden && (sel === 'all' || !Array.isArray(sel) || sel.includes(p.id)))
  }, [dash])

  useEffect(() => {
    const start = Number(params.get('page'))
    if (start && pages.length) {
      const i = pages.findIndex((p) => p.id === start)
      if (i >= 0) setIndex(i)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length])

  const pres = dash?.settings.presentation
  // auto page rotation
  useEffect(() => {
    if (!pres || !playing || pages.length < 2 || !pres.interval) return
    const t = window.setInterval(() => setIndex((i) => (i + 1) % pages.length), pres.interval * 1000)
    return () => window.clearInterval(t)
  }, [pres, playing, pages.length])

  // periodic data + layout refresh (picks up dashboard changes made elsewhere)
  useEffect(() => {
    if (!pres) return
    const t = window.setInterval(() => {
      setNonce((n) => n + 1)
      load()
    }, Math.max(15, pres.refresh || 60) * 1000)
    return () => window.clearInterval(t)
  }, [pres, load])

  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight })
    const onFs = () => setIsFull(!!document.fullscreenElement)
    window.addEventListener('resize', onResize)
    document.addEventListener('fullscreenchange', onFs)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('fullscreenchange', onFs)
    }
  }, [])

  // keep screen awake where supported (wall displays)
  useEffect(() => {
    let lock: any = null
    const nav: any = navigator
    if (nav.wakeLock?.request) nav.wakeLock.request('screen').then((l: any) => (lock = l)).catch(() => undefined)
    return () => lock?.release?.()
  }, [])

  // auto-hide controls / cursor
  const poke = () => {
    setControls(true)
    if (hideTimer.current) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setControls(false), 3000)
  }
  useEffect(() => {
    poke()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setIndex((i) => (i + 1) % Math.max(1, pages.length))
      if (e.key === 'ArrowLeft') setIndex((i) => (i - 1 + pages.length) % Math.max(1, pages.length))
      if (e.key === ' ') setPlaying((p) => !p)
      if (e.key === 'f') toggleFull()
      poke()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length])

  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined)
    else document.documentElement.requestFullscreen?.().catch(() => undefined)
  }

  const runtime = useMemo(() => ({ timezone, currency, editing: false, refreshNonce: nonce }), [timezone, currency, nonce])
  const page = pages[index % Math.max(1, pages.length)]
  const specs = useMemo(() => [dash?.theme, page?.settings?.theme], [dash?.theme, page?.settings?.theme])
  const layouts = useMemo(() => (page && dash ? completeLayouts(page.widgets, page.layouts, dash.settings.grid.cols) : {}), [page, dash])

  if (error) return <Empty title="Präsentation nicht verfügbar">{error}</Empty>
  if (!dash) return <div className="app-bg flex h-full items-center justify-center"><Spinner className="h-8 w-8" /></div>
  if (!page) return <Empty title="Keine sichtbaren Seiten" />

  return (
    <RuntimeContext.Provider value={runtime}>
      <ThemedSurface specs={specs} className={clsx('h-full overflow-hidden', !controls && 'kiosk-cursor-hidden')} fixedBg>
        <div className="h-full overflow-y-auto" onMouseMove={poke} onTouchStart={poke}>
          <div key={page.id} className={clsx(pres?.transition && pres.transition !== 'none' && `trans-${pres.transition}`)}>
            <GridCanvas widgets={page.widgets} layouts={layouts} settings={dash.settings} fitHeight={fit ? viewport.h : null} />
          </div>
        </div>
        {pres?.showClock && (
          <div className="pointer-events-none fixed right-5 top-4 text-right">
            <div className="text-2xl font-semibold tabular-nums">{new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(now)}</div>
          </div>
        )}
        {pages.length > 1 && (
          <div className="pointer-events-none fixed bottom-3 left-1/2 flex -translate-x-1/2 gap-1.5">
            {pages.map((p, i) => (
              <span key={p.id} className={clsx('h-1.5 rounded-full transition-all', i === index ? 'w-6 bg-accent' : 'w-1.5 bg-fg/30')} />
            ))}
          </div>
        )}
        <div className={clsx('fixed left-1/2 top-4 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-line/50 bg-[rgb(var(--c-surface)/0.9)] px-2 py-1 shadow-lg backdrop-blur transition-opacity', controls ? 'opacity-100' : 'pointer-events-none opacity-0')}>
          <IconButton title="Vorherige Seite" onClick={() => setIndex((i) => (i - 1 + pages.length) % pages.length)}>
            <ChevronLeft className="h-4 w-4" />
          </IconButton>
          <span className="px-2 text-sm">{page.title}</span>
          <IconButton title="Nächste Seite" onClick={() => setIndex((i) => (i + 1) % pages.length)}>
            <ChevronRight className="h-4 w-4" />
          </IconButton>
          <IconButton title={playing ? 'Automatischen Wechsel pausieren' : 'Automatischen Wechsel starten'} onClick={() => setPlaying((p) => !p)}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </IconButton>
          <IconButton title={fit ? 'Natürliche Größe (scrollen)' : 'An Bildschirmhöhe anpassen'} active={fit} onClick={() => setFit((f) => !f)}>
            <span className="text-[10px] font-bold">FIT</span>
          </IconButton>
          <IconButton title="Vollbild (F)" onClick={toggleFull}>
            {isFull ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </IconButton>
          {!kiosk && (
            <IconButton title="Präsentation beenden" onClick={() => navigate(`/d/${dash.id}/${page.id}`)}>
              <X className="h-4 w-4" />
            </IconButton>
          )}
        </div>
      </ThemedSurface>
    </RuntimeContext.Provider>
  )
}
