import { MonitorSmartphone, Tv } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api, setDisplayToken } from '../api/client'
import { live, onLiveMessage, useLive } from '../api/live'
import { Spinner } from '../components/ui'
import { useApp } from '../store/app'
import { PresentationView } from './Present'

const TOKEN_KEY = 'has-display-token'

interface Current {
  dashboard_id: number | null
  page_id: number | null
  present: boolean
  ts: number
}

interface Me {
  id: number
  name: string
  paired: boolean
  code: string | null
  current: Current | null
}

/** Remote display (TV / wall tablet). Opened via http://<host>:<port>/tv – no login, no input needed. */
export default function DisplayPage() {
  const [me, setMe] = useState<Me | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [identify, setIdentify] = useState<string | null>(null)
  const [now, setNow] = useState(new Date())
  const connected = useLive((s) => s.connected)
  const loadAppearance = useApp((s) => s.loadAppearance)
  const timezone = useApp((s) => s.appearance?.timezone)
  const started = useRef(false)

  const register = useCallback(async () => {
    setDisplayToken(null)
    const res = await api.post<{ token: string }>('displays/register', { screen: `${window.screen.width}x${window.screen.height}` })
    localStorage.setItem(TOKEN_KEY, res.token)
    setDisplayToken(res.token)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const m = await api.get<Me>('displays/me')
      setMe(m)
      setError(null)
      if (m.paired) loadAppearance()
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
        // unknown or removed display: start over with a new pairing code
        await register()
        live.restart()
        return refresh()
      }
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [register, loadAppearance])

  // bootstrap: reuse stored token or register
  useEffect(() => {
    if (started.current) return
    started.current = true
    ;(async () => {
      try {
        const tok = localStorage.getItem(TOKEN_KEY)
        if (tok) setDisplayToken(tok)
        else await register()
        live.start()
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [register, refresh])

  // commands from the server
  useEffect(
    () =>
      onLiveMessage((msg) => {
        if (msg.type === 'display_show') setMe((m) => (m ? { ...m, current: msg.current } : m))
        else if (msg.type === 'display_paired') refresh()
        else if (msg.type === 'display_identify') {
          setIdentify(msg.name)
          window.setTimeout(() => setIdentify(null), 6000)
        } else if (msg.type === 'display_reload') window.location.reload()
        else if (msg.type === 'display_unpaired') {
          localStorage.removeItem(TOKEN_KEY)
          window.location.reload()
        } else if (msg.type === 'hello') refresh() // after reconnect: fetch the current assignment
      }),
    [refresh],
  )

  // safety net: poll every 5 min in case a websocket message was missed
  useEffect(() => {
    const t = window.setInterval(refresh, 300000)
    const c = window.setInterval(() => setNow(new Date()), 1000)
    return () => {
      window.clearInterval(t)
      window.clearInterval(c)
    }
  }, [refresh])

  // keep the screen awake while possible
  useEffect(() => {
    const nav: any = navigator
    let lock: any = null
    nav.wakeLock?.request?.('screen').then((l: any) => (lock = l)).catch(() => undefined)
    return () => lock?.release?.()
  }, [])

  const banner = identify && (
    <div className="pointer-events-none fixed inset-0 z-[3000] flex items-center justify-center bg-black/70">
      <div className="rounded-3xl border-4 border-accent bg-black/80 px-16 py-12 text-center">
        <Tv className="mx-auto mb-4 h-20 w-20 text-accent" />
        <div className="text-6xl font-bold text-white">{identify}</div>
      </div>
    </div>
  )

  if (error && !me) {
    return (
      <div className="app-bg flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="text-3xl font-semibold">Verbindung fehlgeschlagen</div>
        <div className="text-xl text-muted">{error}</div>
        <div className="text-lg text-muted">Neuer Versuch in wenigen Sekunden …</div>
        <Reloader />
      </div>
    )
  }
  if (!me) {
    return (
      <div className="app-bg flex h-full items-center justify-center">
        <Spinner className="h-12 w-12" />
      </div>
    )
  }

  if (!me.paired) {
    const host = window.location.host
    return (
      <div className="app-bg flex h-full flex-col items-center justify-center gap-10 p-8 text-center">
        <div className="flex items-center gap-4 text-3xl font-semibold">
          <img src="./favicon.svg" alt="" className="h-14 w-14" />
          Home Analytics Studio
        </div>
        <div>
          <div className="mb-4 text-2xl text-muted">Kopplungscode für diesen Bildschirm</div>
          <div className="font-mono text-[9rem] font-bold leading-none tracking-[0.25em] text-accent glow-text">{me.code}</div>
        </div>
        <div className="max-w-3xl space-y-2 text-xl text-muted">
          <p>
            <MonitorSmartphone className="mr-2 inline h-6 w-6 align-[-4px]" />
            Am Handy oder PC ein Dashboard öffnen → <b className="text-fg">„Auf Bildschirm anzeigen“</b> → <b className="text-fg">„Neuen Bildschirm koppeln“</b>
          </p>
          <p>oder unter Einstellungen → Bildschirme. Adresse dieses Bildschirms: {host}/tv</p>
        </div>
        <div className={connected ? 'text-ok' : 'text-warn'}>{connected ? 'Verbunden – warte auf Kopplung' : 'Verbinde …'}</div>
      </div>
    )
  }

  const cur = me.current
  if (!cur || !cur.dashboard_id) {
    return (
      <div className="app-bg flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
        <div className="text-[8rem] font-semibold leading-none tabular-nums glow-text">
          {new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(now)}
        </div>
        <div className="text-3xl text-muted">{new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone }).format(now)}</div>
        <div className="mt-8 text-xl text-muted">
          <Tv className="mr-2 inline h-6 w-6" /> {me.name} – bereit. Dashboard am Handy über „Auf Bildschirm anzeigen“ senden.
        </div>
        {banner}
      </div>
    )
  }

  return (
    <PresentationView
      key={`${cur.dashboard_id}:${cur.page_id}:${cur.ts}`}
      dashboardId={cur.dashboard_id}
      startPageId={cur.page_id}
      kiosk
      autoplay={cur.present}
      overlay={banner || undefined}
    />
  )
}

function Reloader() {
  useEffect(() => {
    const t = window.setTimeout(() => window.location.reload(), 15000)
    return () => window.clearTimeout(t)
  }, [])
  return null
}
