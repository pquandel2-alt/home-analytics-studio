import clsx from 'clsx'
import { Link2, Pencil, RefreshCw, ScanEye, Send, Trash2, Tv } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api/client'
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

/** Pair a new screen with the code it shows (http://<host>/tv). */
export function PairForm({ onPaired, defaultDashboardId }: { onPaired: () => void; defaultDashboardId?: number }) {
  const [code, setCode] = useState('')
  const [name, setName] = useState('Wohnzimmer-TV')
  const [busy, setBusy] = useState(false)
  const host = window.location.host
  const pair = async () => {
    setBusy(true)
    try {
      await api.post('displays/pair', { code, name, dashboard_id: defaultDashboardId ?? null })
      toast.ok(`„${name}“ gekoppelt`)
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
      <div className="text-sm font-medium">Neuen Bildschirm koppeln</div>
      <p className="text-xs text-muted">
        Am Fernseher/Tablet im Browser <b className="text-fg">{host}/tv</b> öffnen – dort erscheint ein 4-stelliger Code. Tipp für Fernseher: als Lesezeichen/Startseite speichern; der Bildschirm bleibt danach dauerhaft gekoppelt.
      </p>
      <div className="grid gap-3 sm:grid-cols-[120px_1fr_auto]">
        <Field label="Code">
          <Input inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="1234" className="font-mono text-lg tracking-widest" />
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <Button variant="primary" loading={busy} disabled={code.length !== 4 || !name.trim()} onClick={pair} icon={<Link2 className="h-4 w-4" />}>
            Koppeln
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Dashboard header button: show the current dashboard on another screen. */
export function CastModal({ open, onClose, dashboard, page }: { open: boolean; onClose: () => void; dashboard: Dashboard; page: Page }) {
  const { list, reload } = useDisplays(open)
  const canEdit = useRole('editor')
  const [target, setTarget] = useState<number | null>(null)
  const [mode, setMode] = useState<'page' | 'all'>('page')
  const [present, setPresent] = useState(true)
  const [busy, setBusy] = useState(false)
  const [pairing, setPairing] = useState(false)

  useEffect(() => {
    if (list && list.length && (target == null || !list.some((d) => d.id === target))) setTarget((list.find((d) => d.online) || list[0]).id)
  }, [list, target])

  const send = async (displayId: number) => {
    setBusy(true)
    try {
      const res = await api.post<{ delivered: boolean }>(`displays/${displayId}/show`, {
        dashboard_id: dashboard.id,
        page_id: mode === 'page' ? page.id : null,
        present: mode === 'all' ? present : false,
      })
      const name = list?.find((d) => d.id === displayId)?.name
      if (res.delivered) toast.ok(`Wird auf „${name}“ angezeigt`)
      else toast.info(`„${name}“ ist gerade nicht verbunden – das Dashboard erscheint, sobald der Bildschirm wieder online ist.`)
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Auf Bildschirm anzeigen" size="md">
      <div className="space-y-4">
        {!list ? (
          <Spinner />
        ) : list.length === 0 ? (
          <Empty icon={<Tv className="h-10 w-10" />} title="Noch kein Bildschirm gekoppelt">
            Öffne am Fernseher im Browser <b>{window.location.host}/tv</b> und koppel ihn hier mit dem angezeigten Code.
          </Empty>
        ) : (
          <div className="space-y-1.5">
            {list.map((d) => (
              <label
                key={d.id}
                className={clsx('flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5', target === d.id ? 'border-accent bg-accent/10' : 'border-line/50 hover:bg-fg/5')}
              >
                <input type="radio" className="accent-[rgb(var(--c-accent))]" checked={target === d.id} onChange={() => setTarget(d.id)} />
                <Tv className="h-5 w-5 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{d.name}</div>
                  <div className={clsx('text-xs', d.online ? 'text-ok' : 'text-muted')}>{d.online ? 'online' : `offline · zuletzt ${formatAge(d.last_seen)}`}</div>
                </div>
                <IconButton
                  title="Bildschirm identifizieren (Name groß einblenden)"
                  onClick={(e) => {
                    e.preventDefault()
                    api.post(`displays/${d.id}/identify`).catch(toast.error)
                  }}
                >
                  <ScanEye className="h-4 w-4" />
                </IconButton>
              </label>
            ))}
          </div>
        )}
        {list && list.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Anzeigen">
              <Select
                value={mode}
                onChange={(v) => setMode(v as 'page' | 'all')}
                options={[
                  { value: 'page', label: `Nur diese Seite („${page.title}“)` },
                  { value: 'all', label: 'Ganzes Dashboard (alle Seiten)' },
                ]}
              />
            </Field>
            {mode === 'all' && (
              <div className="flex items-end pb-2">
                <Switch checked={present} onChange={setPresent} label="Seiten automatisch wechseln" />
              </div>
            )}
          </div>
        )}
        {list && list.length > 0 && (
          <Button variant="primary" className="w-full" disabled={target == null} loading={busy} icon={<Send className="h-4 w-4" />} onClick={() => target != null && send(target)}>
            Senden
          </Button>
        )}
        {canEdit &&
          (pairing || (list && list.length === 0) ? (
            <PairForm
              defaultDashboardId={dashboard.id}
              onPaired={() => {
                setPairing(false)
                reload()
              }}
            />
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setPairing(true)}>
              + Neuen Bildschirm koppeln
            </Button>
          ))}
      </div>
    </Modal>
  )
}

/** Settings section. */
export function DisplaysSettings() {
  const { list, reload } = useDisplays(true)
  const canEdit = useRole('editor')
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
                    <div className="text-xs text-muted">{d.screen ? `${d.screen} · ` : ''}zeigt: {name(d.current?.dashboard_id)}</div>
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
      {canEdit && <PairForm onPaired={reload} />}
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
