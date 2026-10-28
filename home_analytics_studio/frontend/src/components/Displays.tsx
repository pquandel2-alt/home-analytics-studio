import clsx from 'clsx'
import { Link2, Pencil, Power, RefreshCw, ScanEye, Send, Trash2, Tv } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { onLiveMessage } from '../api/live'
import type { Dashboard, Page } from '../api/types'
import { useRole } from '../store/app'
import { formatAge } from '../utils/format'
import { Button, Empty, Field, IconButton, Input, Modal, Select, Spinner, Switch, confirmDialog, promptDialog, toast } from './ui'

export interface DisplayInfo {
  id: number
  name: string
  online: boolean
  last_seen: number | null
  screen: string | null
  current: { dashboard_id: number | null; page_id: number | null; present: boolean } | null
  tv_entity?: string | null
  last_launch?: number | null
  last_launch_error?: string | null
}

export function useDisplays(open = true) {
  const [list, setList] = useState<DisplayInfo[] | null>(null)
  const reload = async () => {
    try {
      setList(await api.get<DisplayInfo[]>('displays'))
    } catch (e) {
      toast.error(e)
      setList([])
    }
  }
  useEffect(() => {
    if (!open) return
    reload()
    const t = window.setInterval(reload, 10000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return { list, reload }
}

/** App-wide: toast the outcome of a remote TV launch (turn on + open dashboard). */
export function useLaunchToasts() {
  useEffect(
    () =>
      onLiveMessage((msg) => {
        if (msg.type !== 'display_launch') return
        const n = msg.name || 'Fernseher'
        if (msg.ok) toast.ok(`„${n}“ zeigt jetzt das Dashboard`)
        else toast.error(`„${n}“ konnte nicht geöffnet werden: ${msg.error}`)
      }),
    [],
  )
}

/** Pair a screen with the code it shows (http://<host>/tv) – as a new device or attached to an existing one (e.g. a linked TV). */
export function PairForm({ onPaired, defaultDashboardId, targets = [] }: { onPaired: () => void; defaultDashboardId?: number; targets?: DisplayInfo[] }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('Wohnzimmer-TV')
  const [target, setTarget] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const host = window.location.host
  const pair = async () => {
    setBusy(true)
    try {
      if (target) {
        await api.post(`displays/${target}/claim`, { code })
        toast.ok('Fernseher-Browser zugeordnet')
      } else {
        await api.post('displays/pair', { code, name, dashboard_id: defaultDashboardId ?? null })
        toast.ok(`„${name}“ gekoppelt`)
      }
      setCode('')
      onPaired()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3 rounded-lg border border-line/50 p-3">
      <div className="text-sm font-medium">Gerät per Code koppeln</div>
      <p className="text-xs text-muted">
        Am Fernseher/Tablet im Browser <b className="text-fg">{host}/tv</b> öffnen – dort erscheint ein 4-stelliger Code. Bei einem verknüpften Fernseher den Code diesem Gerät zuordnen,
        dann öffnet er das Dashboard künftig selbst.
      </p>
      <div className="grid gap-3 sm:grid-cols-[110px_1fr_1fr_auto]">
        <Field label="Code">
          <Input inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="1234" className="font-mono text-lg tracking-widest" />
        </Field>
        <Field label="Zuordnen zu">
          <Select value={target} onChange={setTarget} placeholder="Neues Gerät" options={targets.map((t) => ({ value: String(t.id), label: t.name }))} />
        </Field>
        {!target ? (
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        ) : (
          <div />
        )}
        <div className="flex items-end">
          <Button variant="primary" loading={busy} disabled={code.length !== 4 || (!target && !name.trim())} onClick={pair} icon={<Link2 className="h-4 w-4" />}>
            Koppeln
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Share sheet: tap a device to show the dashboard there; presentation link as secondary option. */
export function ShareSheet({ open, onClose, dashboard, page, onPresentationLink }: {
  open: boolean
  onClose: () => void
  dashboard: Dashboard
  page: Page
  onPresentationLink?: () => void
}) {
  const { list, reload } = useDisplays(open)
  const canEdit = useRole('editor')
  const isAdmin = useRole('admin')
  const [mode, setMode] = useState<'page' | 'all'>('page')
  const [present, setPresent] = useState(true)
  const [sending, setSending] = useState<number | string | null>(null)
  const [pairing, setPairing] = useState(false)
  const [tvs, setTvs] = useState<TvCandidate[]>([])
  const [tvEnabled, setTvEnabled] = useState(false)

  useEffect(() => {
    if (!open || !isAdmin) return
    api
      .get<{ candidates: TvCandidate[]; enabled: boolean }>('displays/tv/candidates')
      .then((r) => {
        setTvs(r.candidates.filter((c) => !c.linked))
        setTvEnabled(r.enabled)
      })
      .catch(() => undefined)
  }, [open, isAdmin, list?.length])

  const send = async (d: DisplayInfo) => {
    setSending(d.id)
    try {
      const res = await api.post<{ delivered: boolean; launching: boolean }>(`displays/${d.id}/show`, {
        dashboard_id: dashboard.id,
        page_id: mode === 'page' ? page.id : null,
        present: mode === 'all' ? present : false,
      })
      if (res.delivered) toast.ok(`Wird auf „${d.name}“ angezeigt`)
      else if (res.launching) toast.info(`„${d.name}“ wird eingeschaltet und öffnet das Dashboard … (bis zu einer Minute)`)
      else toast.info(`„${d.name}“ ist gerade nicht verbunden – das Dashboard erscheint, sobald das Gerät wieder online ist.`)
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setSending(null)
    }
  }

  const addTvAndSend = async (c: TvCandidate) => {
    setSending(c.entity_id)
    try {
      if (!tvEnabled) await api.put('settings/displays', { tv_control_enabled: true })
      const d = await api.post<DisplayInfo>('displays/tv', { name: c.name, tv_entity: c.entity_id })
      await send({ ...d, online: false })
      reload()
    } catch (e) {
      toast.error(e)
      setSending(null)
    }
  }

  const status = (d: DisplayInfo) =>
    d.online ? { text: 'online', cls: 'text-ok' } : d.tv_entity ? { text: 'aus – wird beim Antippen eingeschaltet', cls: 'text-muted' } : { text: `offline · ${formatAge(d.last_seen)}`, cls: 'text-muted' }

  return (
    <Modal open={open} onClose={onClose} title="Teilen" size="md">
      <div className="space-y-5">
        <div>
          <div className="label">Auf Gerät anzeigen</div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {(['page', 'all'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={clsx('rounded-full border px-3 py-1 text-xs', mode === m ? 'border-accent bg-accent/15 text-accent' : 'border-line/60 text-muted')}
              >
                {m === 'page' ? `Diese Seite („${page.title}“)` : 'Ganzes Dashboard'}
              </button>
            ))}
            {mode === 'all' && <Switch checked={present} onChange={setPresent} label="Seiten wechseln" />}
          </div>
          {!list ? (
            <Spinner />
          ) : (
            <div className="space-y-1.5">
              {list.map((d) => {
                const st = status(d)
                return (
                  <div key={d.id} className="flex items-center gap-2">
                    <button
                      onClick={() => send(d)}
                      disabled={sending != null}
                      className="flex min-w-0 flex-1 items-center gap-3 rounded-xl border border-line/50 px-3 py-3 text-left transition hover:border-accent hover:bg-accent/10 disabled:opacity-60"
                    >
                      <Tv className="h-6 w-6 shrink-0 text-accent" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{d.name}</div>
                        <div className={clsx('truncate text-xs', st.cls)}>{st.text}</div>
                        {d.last_launch_error && !d.online && <div className="line-clamp-2 text-xs text-bad">{d.last_launch_error}</div>}
                      </div>
                      {sending === d.id ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4 text-muted" />}
                    </button>
                    <IconButton title="Identifizieren (Name groß einblenden)" onClick={() => api.post(`displays/${d.id}/identify`).catch(toast.error)}>
                      <ScanEye className="h-4 w-4" />
                    </IconButton>
                  </div>
                )
              })}
              {isAdmin &&
                tvs.map((c) => (
                  <button
                    key={c.entity_id}
                    onClick={() => addTvAndSend(c)}
                    disabled={sending != null}
                    className="flex w-full items-center gap-3 rounded-xl border border-dashed border-line/60 px-3 py-3 text-left transition hover:border-accent hover:bg-accent/10 disabled:opacity-60"
                  >
                    <Power className="h-6 w-6 shrink-0 text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{c.name}</div>
                      <div className="truncate text-xs text-muted">Fernseher aus Home Assistant – antippen zum Hinzufügen und Anzeigen</div>
                    </div>
                    {sending === c.entity_id ? <Spinner className="h-4 w-4" /> : <Send className="h-4 w-4 text-muted" />}
                  </button>
                ))}
              {list.length === 0 && tvs.length === 0 && (
                <Empty icon={<Tv className="h-10 w-10" />} title="Noch kein Gerät">
                  Am Fernseher im Browser <b>{window.location.host}/tv</b> öffnen und unten mit dem Code koppeln.
                </Empty>
              )}
            </div>
          )}
        </div>
        {canEdit &&
          (pairing ? (
            <PairForm
              defaultDashboardId={dashboard.id}
              targets={(list || []).filter((d) => d.tv_entity)}
              onPaired={() => {
                setPairing(false)
                reload()
              }}
            />
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setPairing(true)} icon={<Link2 className="h-4 w-4" />}>
              Gerät per Code koppeln
            </Button>
          ))}
        {canEdit && onPresentationLink && (
          <div className="border-t border-line/40 pt-4">
            <div className="label">Link teilen</div>
            <Button size="sm" variant="secondary" icon={<Link2 className="h-4 w-4" />} onClick={onPresentationLink}>
              Präsentationslink (nur lesen)
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

interface TvCandidate {
  entity_id: string
  name: string
  state: string
  can_launch_apps: boolean
  can_power_on: boolean
  linked: boolean
}

function TvControl({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<{ candidates: TvCandidate[]; tv_url: string | null; enabled: boolean } | null>(null)
  const [url, setUrl] = useState('')
  const [entity, setEntity] = useState('')
  const [name, setName] = useState('Wohnzimmer-TV')
  const load = async () => {
    try {
      const r = await api.get<{ candidates: TvCandidate[]; tv_url: string | null; enabled: boolean }>('displays/tv/candidates')
      setInfo(r)
      const s = await api.get<Record<string, any>>('settings')
      setUrl(s.displays?.tv_url || '')
    } catch (e) {
      toast.error(e)
    }
  }
  useEffect(() => {
    load()
  }, [])
  if (!info) return <Spinner />
  const save = async (patch: Record<string, any>) => {
    try {
      await api.put('settings/displays', patch)
      await load()
      toast.ok('Gespeichert')
    } catch (e) {
      toast.error(e)
    }
  }
  const free = info.candidates.filter((c) => !c.linked)
  return (
    <div className="panel space-y-4 p-5">
      <div>
        <h3 className="text-sm font-semibold">Fernseher automatisch einschalten und öffnen</h3>
        <p className="mt-1 text-xs text-muted">
          Beim Senden schaltet Home Assistant einen verknüpften Fernseher ein und öffnet dort das Dashboard im Browser – am Fernseher ist nichts zu tun.
          <b className="text-warn"> Dafür darf das Add-on ausnahmsweise Geräte steuern</b>, und zwar ausschließlich: verknüpfte Fernseher einschalten und die Dashboard-Adresse im Browser öffnen
          (<code>media_player.turn_on</code>, <code>media_player.play_media</code> mit Typ „browser“). Alles andere bleibt gesperrt.
        </p>
      </div>
      <Switch checked={info.enabled} onChange={(v) => save({ tv_control_enabled: v })} label="Fernseher-Steuerung erlauben" />
      <Field label="Adresse, die der Fernseher öffnet" hint={`Leer = automatisch (${info.tv_url || 'unbekannt – bitte eintragen'})`}>
        <div className="flex gap-2">
          <Input value={url} placeholder="http://192.168.178.101:8100" onChange={(e) => setUrl(e.target.value)} />
          <Button onClick={() => save({ tv_url: url.trim() })}>Speichern</Button>
        </div>
      </Field>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <Field label="Fernseher (aus Home Assistant)">
          <Select
            value={entity}
            placeholder={free.length ? 'Fernseher wählen …' : 'keine weiteren Fernseher gefunden'}
            onChange={setEntity}
            options={free.map((c) => ({ value: c.entity_id, label: `${c.name} (${c.entity_id})${c.can_launch_apps ? '' : ' – öffnen von Seiten evtl. nicht möglich'}` }))}
          />
        </Field>
        <Field label="Name in der Bildschirmliste">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <Button
            variant="primary"
            disabled={!entity || !name.trim()}
            onClick={async () => {
              try {
                await api.post('displays/tv', { name, tv_entity: entity })
                toast.ok(`„${name}“ verknüpft`)
                setEntity('')
                await load()
                onChanged()
              } catch (e) {
                toast.error(e)
              }
            }}
          >
            Verknüpfen
          </Button>
        </div>
      </div>
    </div>
  )
}

function TvLinkSelect({ display, onChanged }: { display: DisplayInfo; onChanged: () => void }) {
  const [options, setOptions] = useState<TvCandidate[] | null>(null)
  const load = () => api.get<{ candidates: TvCandidate[] }>('displays/tv/candidates').then((r) => setOptions(r.candidates)).catch(() => setOptions([]))
  return (
    <select
      className="mt-1 rounded-md border border-line/60 bg-bg/60 px-1.5 py-1 text-xs"
      value={display.tv_entity || ''}
      onFocus={() => options == null && load()}
      onMouseDown={() => options == null && load()}
      onChange={async (e) => {
        try {
          await api.put(`displays/${display.id}/tv`, { tv_entity: e.target.value || null })
          toast.ok(e.target.value ? 'Mit Fernseher verknüpft' : 'Verknüpfung entfernt')
          onChanged()
        } catch (err) {
          toast.error(err)
        }
      }}
      title="Mit einem Fernseher aus Home Assistant verknüpfen (zum automatischen Einschalten)"
    >
      <option value="">– kein Fernseher verknüpft –</option>
      {display.tv_entity && !options && <option value={display.tv_entity}>{display.tv_entity}</option>}
      {(options || []).filter((o) => !o.linked || o.entity_id === display.tv_entity).map((o) => (
        <option key={o.entity_id} value={o.entity_id}>
          Fernseher: {o.name} ({o.entity_id})
        </option>
      ))}
    </select>
  )
}

/** Settings section. */
export function DisplaysSettings() {
  const { list, reload } = useDisplays(true)
  const canEdit = useRole('editor')
  const isAdmin = useRole('admin')

  const [dashboards, setDashboards] = useState<Dashboard[]>([])
  useEffect(() => {
    api.get<Dashboard[]>('dashboards').then(setDashboards).catch(() => undefined)
  }, [])
  const name = (id: number | null | undefined) => dashboards.find((d) => d.id === id)?.name || '–'
  return (
    <div className="space-y-6">
      <div className="panel p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Gekoppelte Bildschirme</h3>
          <IconButton title="Aktualisieren" onClick={reload}>
            <RefreshCw className="h-4 w-4" />
          </IconButton>
        </div>
        {!list ? (
          <Spinner />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted">Noch keine Bildschirme gekoppelt.</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {list.map((d) => (
                <tr key={d.id} className="border-t border-line/30 first:border-0">
                  <td className="py-2">
                    <div className="font-medium">{d.name}</div>
                    <div className="text-xs text-muted">
                      {d.tv_entity ? `${d.tv_entity} · ` : d.screen ? `${d.screen} · ` : ''}zeigt: {name(d.current?.dashboard_id)}
                    </div>
                    {d.last_launch_error && <div className="text-xs text-bad">Letzter Start fehlgeschlagen: {d.last_launch_error}</div>}
                    {isAdmin && <TvLinkSelect display={d} onChanged={reload} />}
                  </td>
                  <td className={clsx('px-2 text-xs', d.online ? 'text-ok' : 'text-muted')}>{d.online ? 'online' : `offline · ${formatAge(d.last_seen)}`}</td>
                  <td className="whitespace-nowrap px-2 text-right">
                    <select
                      className="mr-1 rounded-md border border-line/60 bg-bg/60 px-1.5 py-1 text-xs"
                      value={d.current?.dashboard_id ?? ''}
                      onChange={async (e) => {
                        const v = e.target.value ? Number(e.target.value) : null
                        await api.post(`displays/${d.id}/show`, { dashboard_id: v, page_id: null, present: true }).catch(toast.error)
                        reload()
                      }}
                      title="Dashboard auf diesem Bildschirm"
                    >
                      <option value="">– Uhr / Bereitschaft –</option>
                      {dashboards.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </select>
                    {d.tv_entity && (
                      <IconButton
                        title="Fernseher einschalten und Dashboard öffnen"
                        onClick={() =>
                          api
                            .post(`displays/${d.id}/launch`)
                            .then(() => toast.info(`„${d.name}“ wird eingeschaltet …`))
                            .catch(toast.error)
                        }
                      >
                        <Power className="h-4 w-4" />
                      </IconButton>
                    )}
                    <IconButton title="Identifizieren" onClick={() => api.post(`displays/${d.id}/identify`).catch(toast.error)}>
                      <ScanEye className="h-4 w-4" />
                    </IconButton>
                    {canEdit && (
                      <>
                        <IconButton title="Neu laden" onClick={() => api.post(`displays/${d.id}/reload`).then(() => toast.ok('Neu geladen')).catch(toast.error)}>
                          <RefreshCw className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          title="Umbenennen"
                          onClick={async () => {
                            const n = await promptDialog('Bildschirm umbenennen', 'Name', d.name)
                            if (n) {
                              await api.patch(`displays/${d.id}`, { name: n }).catch(toast.error)
                              reload()
                            }
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </IconButton>
                        <IconButton
                          title="Entkoppeln"
                          onClick={async () => {
                            if (await confirmDialog('Bildschirm entkoppeln', `„${d.name}“ entfernen? Der Bildschirm zeigt danach wieder einen neuen Kopplungscode.`, { danger: true })) {
                              await api.del(`displays/${d.id}`).catch(toast.error)
                              reload()
                            }
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {isAdmin && <TvControl onChanged={reload} />}
      {canEdit && <PairForm onPaired={reload} targets={(list || []).filter((d) => d.tv_entity)} />}
      <div className="panel p-5 text-sm text-muted">
        <div className="mb-2 font-medium text-fg">Hinweise für Fernseher</div>
        <ul className="list-disc space-y-1 pl-5">
          <li>Samsung/LG: im TV-Browser <b className="text-fg">{window.location.host}/tv</b> öffnen und als Lesezeichen speichern. Der Browser muss geöffnet bleiben.</li>
          <li>Fire TV / Android TV: Silk-Browser oder eine Kiosk-App (z. B. „Fully Kiosk Browser“) mit dieser Adresse als Startseite.</li>
          <li>Bildschirme haben nur Lesezugriff. Die Verbindung läuft nur im lokalen Netz; nach Stromausfall oder WLAN-Abbruch verbindet sich der Bildschirm selbst neu und zeigt wieder das zuletzt gesendete Dashboard.</li>
        </ul>
      </div>
    </div>
  )
}
