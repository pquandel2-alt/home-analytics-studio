import clsx from 'clsx'
import {
  Bot,
  Calculator,
  CheckCircle2,
  Cpu,
  Database,
  DatabaseBackup,
  Download,
  FileDown,
  HardDrive,
  History,
  Home,
  LayoutDashboard,
  Palette,
  Plug,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  Stethoscope,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, download } from '../api/client'
import { useLive } from '../api/live'
import type { Dashboard, Job, Source, ThemeSpec } from '../api/types'
import RangePicker from '../components/RangePicker'
import { SourceList } from '../components/SourcePicker'
import { Badge, Button, Card, Field, IconButton, Input, Modal, NumberInput, PageHeader, Select, Spinner, Switch, confirmDialog, toast, useAsync } from '../components/ui'
import { useApp } from '../store/app'
import ThemeEditor from '../theme/ThemeEditor'
import { INTERVALS, formatAge, formatBytes, formatNumber, formatTs } from '../utils/format'

type Settings = Record<string, Record<string, any>>

const SECTIONS = [
  { id: 'general', label: 'Allgemein', icon: SettingsIcon },
  { id: 'homeassistant', label: 'Home-Assistant-Verbindung', icon: Home },
  { id: 'entities', label: 'Entitäten', icon: Plug },
  { id: 'storage', label: 'Datenspeicherung', icon: HardDrive },
  { id: 'database', label: 'Datenbank', icon: Database },
  { id: 'import', label: 'Historischer Import', icon: History },
  { id: 'metrics', label: 'Berechnete Kennzahlen', icon: Calculator },
  { id: 'dashboards', label: 'Dashboard-Verwaltung', icon: LayoutDashboard },
  { id: 'appearance', label: 'Erscheinungsbild', icon: Palette },
  { id: 'security', label: 'Benutzer und Sicherheit', icon: ShieldCheck },
  { id: 'ai', label: 'KI-Anbieter (optional)', icon: Bot },
  { id: 'backup', label: 'Backup', icon: DatabaseBackup },
  { id: 'export', label: 'Export', icon: FileDown },
  { id: 'system', label: 'Systeminformationen', icon: Cpu },
  { id: 'diagnostics', label: 'Diagnose', icon: Stethoscope },
]

function useSection(settings: Settings | undefined, section: string, reload: () => void) {
  const [draft, setDraft] = useState<Record<string, any>>({})
  useEffect(() => {
    if (settings) setDraft(settings[section] || {})
  }, [settings, section])
  const set = (k: string, v: any) => setDraft((d) => ({ ...d, [k]: v }))
  const save = async () => {
    try {
      await api.put(`settings/${section}`, draft)
      toast.ok('Einstellungen gespeichert')
      reload()
    } catch (e) {
      toast.error(e)
    }
  }
  return { draft, set, save }
}

function SaveBar({ onSave }: { onSave: () => void }) {
  return (
    <div className="flex justify-end pt-2">
      <Button variant="primary" onClick={onSave}>
        Speichern
      </Button>
    </div>
  )
}

// ------------------------------------------------------------------ sections

function General({ settings, reload }: { settings: Settings; reload: () => void }) {
  const { draft, set, save } = useSection(settings, 'general', reload)
  const loadAppearance = useApp((s) => s.loadAppearance)
  const { data: dashboards } = useAsync(() => api.get<Dashboard[]>('dashboards'), [])
  return (
    <Card title="Allgemein" bodyClass="grid gap-4 p-5 md:grid-cols-2">
      <Field label="Name der Instanz">
        <Input value={draft.instance_name || ''} onChange={(e) => set('instance_name', e.target.value)} />
      </Field>
      <Field label="Zeitzone" hint="leer = Zeitzone von Home Assistant (Tage/Wochen/Monate werden darin berechnet)">
        <Input value={draft.timezone || ''} placeholder="Europe/Berlin" onChange={(e) => set('timezone', e.target.value)} />
      </Field>
      <Field label="Währung">
        <Input value={draft.currency || ''} onChange={(e) => set('currency', e.target.value)} />
      </Field>
      <Field label="Startseite">
        <Select value={draft.default_dashboard ?? ''} placeholder="Dashboard-Übersicht" onChange={(v) => set('default_dashboard', v ? Number(v) : null)} options={(dashboards || []).map((d) => ({ value: d.id, label: d.name }))} />
      </Field>
      <div className="md:col-span-2">
        <SaveBar
          onSave={async () => {
            await save()
            loadAppearance()
          }}
        />
      </div>
    </Card>
  )
}

function HomeAssistant({ settings, reload }: { settings: Settings; reload: () => void }) {
  const { draft, set, save } = useSection(settings, 'homeassistant', reload)
  const { data: status, reload: reloadStatus } = useAsync(() => api.get<any>('ha/status'), [])
  const live = useLive((s) => s.haStatus)
  const [test, setTest] = useState<any>(null)
  const st = live || status
  return (
    <div className="space-y-6">
      <Card title="Verbindungsstatus" actions={<Button size="sm" icon={<RefreshCw className="h-4 w-4" />} onClick={async () => { await api.post('ha/reconnect'); setTimeout(reloadStatus, 1500) }}>Neu verbinden</Button>}>
        {st ? (
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div><div className="label">Status</div><Badge tone={st.state === 'connected' ? 'ok' : 'warn'}>{st.state}</Badge></div>
            <div><div className="label">Home Assistant</div>{st.ha_version || '–'}</div>
            <div><div className="label">Endpunkt</div>{st.endpoint || '–'}</div>
            <div><div className="label">Verbunden seit</div>{formatTs(st.connected_since)}</div>
            <div><div className="label">Wiederverbindungen</div>{st.reconnects}</div>
            <div><div className="label">Entitäten</div>{status?.entity_count ?? '–'}</div>
            {st.error && <div className="text-warn md:col-span-3">{st.error}</div>}
          </div>
        ) : <Spinner />}
        <p className="mt-4 text-xs text-muted">Die Verbindung ist ausschließlich lesend: Es werden nur Abfragebefehle (Zustände, Registry, Historie, Statistiken) und Ereignis-Abonnements verwendet. Dienstaufrufe zur Gerätesteuerung sind technisch gesperrt.</p>
      </Card>
      <Card title="Verbindungsart" bodyClass="grid gap-4 p-5 md:grid-cols-2">
        <Field label="Modus">
          <Select
            value={draft.mode || 'auto'}
            onChange={(v) => set('mode', v)}
            options={[
              { value: 'auto', label: 'Automatisch (Supervisor / Add-on)' },
              { value: 'manual', label: 'Manuell (URL + Langzeit-Token)' },
            ]}
          />
        </Field>
        <div />
        {draft.mode === 'manual' && (
          <>
            <Field label="Home-Assistant-URL">
              <Input value={draft.url || ''} placeholder="http://homeassistant.local:8123" onChange={(e) => set('url', e.target.value)} />
            </Field>
            <Field label="Langzeit-Zugriffstoken" hint="Profil → Sicherheit → Langlebige Zugriffstoken">
              <Input type="password" value={draft.token || ''} onChange={(e) => set('token', e.target.value)} />
            </Field>
            <Switch checked={draft.verify_ssl !== false} onChange={(v) => set('verify_ssl', v)} label="TLS-Zertifikat prüfen" />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  setTest(null)
                  try {
                    setTest(await api.post('ha/test', { url: draft.url, token: draft.token, verify_ssl: draft.verify_ssl }))
                  } catch (e) {
                    toast.error(e)
                  }
                }}
              >
                Verbindung testen
              </Button>
              {test && (test.ok ? <span className="text-sm text-ok">OK – HA {test.ha_version}</span> : <span className="text-sm text-bad">{test.error}</span>)}
            </div>
          </>
        )}
        <div className="md:col-span-2"><SaveBar onSave={save} /></div>
      </Card>
    </div>
  )
}

function Storage({ settings, reload }: { settings: Settings; reload: () => void }) {
  const { draft, set, save } = useSection(settings, 'storage', reload)
  return (
    <Card title="Datenspeicherung & Verdichtung" bodyClass="grid gap-4 p-5 md:grid-cols-2">
      <Field label="Rohdaten aufbewahren (Tage, 0 = unbegrenzt)" hint="Exakte Einzelwerte. Danach bleiben verdichtete Werte erhalten.">
        <NumberInput value={draft.raw_retention_days} min={0} onChange={(v) => set('raw_retention_days', v ?? 0)} />
      </Field>
      <Field label="5-Minuten-Verdichtung aufbewahren (Tage, 0 = unbegrenzt)">
        <NumberInput value={draft.stats5m_retention_days} min={0} onChange={(v) => set('stats5m_retention_days', v ?? 0)} />
      </Field>
      <Field label="Stundenwerte aufbewahren (Tage, 0 = unbegrenzt)" hint="Grundlage für Tages-, Wochen-, Monats- und Jahresauswertungen">
        <NumberInput value={draft.hourly_retention_days} min={0} onChange={(v) => set('hourly_retention_days', v ?? 0)} />
      </Field>
      <Field label="Schreibintervall (Sekunden)" hint="Puffert Messwerte und schreibt gesammelt (schont SD-Karten)">
        <NumberInput value={draft.flush_interval_seconds} min={1} max={300} onChange={(v) => set('flush_interval_seconds', v ?? 5)} />
      </Field>
      <Field label="Mindestabstand zwischen Messwerten (Sekunden, 0 = alle)" hint="Drosselt sehr häufig aktualisierende Sensoren">
        <NumberInput value={draft.min_interval_seconds} min={0} onChange={(v) => set('min_interval_seconds', v ?? 0)} />
      </Field>
      <Field label="Mindestens freier Speicher (MB)" hint="Darunter pausiert die Aufzeichnung automatisch">
        <NumberInput value={draft.min_free_disk_mb} min={0} onChange={(v) => set('min_free_disk_mb', v ?? 0)} />
      </Field>
      <Field label="Maximale Datenbankgröße (MB, 0 = unbegrenzt)">
        <NumberInput value={draft.max_db_size_mb} min={0} onChange={(v) => set('max_db_size_mb', v ?? 0)} />
      </Field>
      <div className="flex items-end">
        <Switch checked={!!draft.auto_vacuum} onChange={(v) => set('auto_vacuum', v)} label="Freien Speicher automatisch zurückgeben" />
      </div>
      <div className="md:col-span-2">
        <Switch checked={draft.auto_import_on_record !== false} onChange={(v) => set('auto_import_on_record', v)} label="Beim Aktivieren der Aufzeichnung vorhandene Home-Assistant-Historie automatisch importieren" />
      </div>
      <Field label="Langzeitstatistiken importieren (Tage)" hint="Stündliche HA-Statistiken, 0 = aus">
        <NumberInput value={draft.auto_import_statistics_days} min={0} max={3650} onChange={(v) => set('auto_import_statistics_days', v ?? 0)} />
      </Field>
      <Field label="Rohdaten-Historie importieren (Tage)" hint="Exakte Werte, begrenzt durch die Recorder-Aufbewahrung von HA (meist 10 Tage)">
        <NumberInput value={draft.auto_import_history_days} min={0} max={365} onChange={(v) => set('auto_import_history_days', v ?? 0)} />
      </Field>
      <div className="md:col-span-2"><SaveBar onSave={save} /></div>
    </Card>
  )
}

function DatabaseSection() {
  const { data, reload } = useAsync(() => api.get<any>('system/info'), [])
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (what: string, path: string, msg: string) => {
    setBusy(what)
    try {
      const res = await api.post<any>(path)
      toast.ok(msg + (res?.job_id ? ` (Job ${res.job_id})` : ''))
      reload()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }
  if (!data) return <Spinner />
  const d = data.disk
  return (
    <div className="space-y-6">
      <Card title="Datenbank">
        <div className="grid gap-4 text-sm md:grid-cols-4">
          <div><div className="label">Größe</div>{formatBytes(d.db_bytes)}</div>
          <div><div className="label">WAL</div>{formatBytes(d.wal_bytes)}</div>
          <div><div className="label">Freie Seiten</div>{formatBytes(d.free_bytes)}</div>
          <div><div className="label">Schema-Version</div>{data.schema_version}</div>
          <div><div className="label">Messwerte gesamt</div>{formatNumber(data.counts.samples, { decimals: 0 })}</div>
          <div><div className="label">Aufgezeichnete Entitäten</div>{data.counts.recorded_entities}</div>
          <div><div className="label">Datenträger frei</div>{formatBytes(d.free)} von {formatBytes(d.total)}</div>
          <div><div className="label">Status</div>{d.paused ? <Badge tone="bad">{d.paused}</Badge> : <Badge tone="ok">Aufzeichnung aktiv</Badge>}</div>
          <div><div className="label">Letzte Integritätsprüfung</div>{data.maintenance.integrity ? `${data.maintenance.integrity} · ${formatAge(data.maintenance.last_integrity)}` : '–'}</div>
          <div><div className="label">Letzte Bereinigung</div>{formatAge(data.maintenance.last_retention)}</div>
          <div><div className="label">Letzte Verdichtung</div>{formatAge(data.recorder.last_rollup)}</div>
          <div><div className="label">Puffer</div>{data.recorder.pending} ausstehend</div>
        </div>
      </Card>
      <Card title="Wartung" bodyClass="flex flex-wrap gap-2 p-5">
        <Button loading={busy === 'm'} onClick={() => run('m', 'system/maintenance', 'Wartung ausgeführt')}>Wartung jetzt ausführen</Button>
        <Button loading={busy === 'v'} onClick={() => run('v', 'system/vacuum', 'Datenbank komprimiert')}>Komprimieren (VACUUM)</Button>
        <Button loading={busy === 'r'} onClick={() => run('r', 'system/rebuild-rollups', 'Neuberechnung gestartet')}>Verdichtungen neu berechnen</Button>
        <p className="w-full text-xs text-muted">Wartung: Aufbewahrungsregeln anwenden, Speicher prüfen, Integritätsprüfung. Die Datenbank läuft im WAL-Modus und wird täglich auf Beschädigung geprüft; beim Start wird sie bei Bedarf automatisch aus der letzten Sicherung wiederhergestellt.</p>
      </Card>
    </div>
  )
}

function ImportSection() {
  const [sources, setSources] = useState<Source[]>([])
  const [kind, setKind] = useState<'statistics' | 'history'>('statistics')
  const [range, setRange] = useState<any>({ last: '365d' })
  const { data: jobs, reload } = useAsync(() => api.get<Job[]>('jobs'), [])
  const liveJobs = useLive((s) => s.jobs)
  const start = async () => {
    try {
      const r = await api.post<{ job_id: number }>(`import/${kind}`, { entity_ids: sources.filter((s) => s.type === 'entity').map((s) => s.id), range, record: true })
      toast.ok(`Import gestartet (Job ${r.job_id})`)
      reload()
    } catch (e) {
      toast.error(e)
    }
  }
  const all = (jobs || []).map((j) => liveJobs[j.id] || j)
  return (
    <div className="space-y-6">
      <Card title="Historische Daten aus Home Assistant importieren" bodyClass="space-y-4 p-5">
        <Field label="Entitäten">
          <SourceList value={sources} onChange={setSources} multi showStat={false} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Quelle">
            <Select
              value={kind}
              onChange={(v) => {
                setKind(v as any)
                setRange(v === 'history' ? { last: '10d' } : { last: '365d' })
              }}
              options={[
                { value: 'statistics', label: 'Langzeitstatistiken (stündlich)' },
                { value: 'history', label: 'Rohdaten-Historie (Recorder)' },
              ]}
            />
          </Field>
          <Field label="Zeitraum">
            <RangePicker value={range} onChange={setRange} />
          </Field>
        </div>
        <Button variant="primary" disabled={!sources.length} onClick={start}>Import starten</Button>
      </Card>
      <Card title="Hintergrundaufgaben" actions={<IconButton title="Aktualisieren" onClick={reload}><RefreshCw className="h-4 w-4" /></IconButton>} bodyClass="p-0">
        <table className="w-full text-sm">
          <tbody>
            {all.map((j) => (
              <tr key={j.id} className="border-t border-line/30 first:border-0">
                <td className="px-5 py-2">#{j.id} {j.type}</td>
                <td className="px-2 py-2"><Badge tone={j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'accent'}>{j.status}</Badge></td>
                <td className="px-2 py-2 text-xs text-muted">{j.message}</td>
                <td className="w-40 px-2 py-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-line/50"><div className="h-full bg-accent" style={{ width: `${j.progress * 100}%` }} /></div>
                </td>
                <td className="px-3 py-2 text-xs text-muted">{formatAge(j.updated_at)}</td>
                <td className="px-3 py-2">{j.status === 'running' && <Button size="sm" variant="ghost" onClick={() => api.post(`jobs/${j.id}/cancel`).then(reload)}>Abbrechen</Button>}</td>
              </tr>
            ))}
            {!all.length && <tr><td className="p-5 text-sm text-muted">Keine Aufgaben</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

function Appearance({ settings, reload }: { settings: Settings; reload: () => void }) {
  const [spec, setSpec] = useState<ThemeSpec>({})
  const setLocal = useApp((s) => s.setAppearanceLocal)
  const loadAppearance = useApp((s) => s.loadAppearance)
  useEffect(() => {
    const a = settings.appearance || {}
    setSpec({ preset: a.preset, overrides: a.overrides || {} })
  }, [settings])
  return (
    <Card title="Globales Erscheinungsbild" bodyClass="space-y-4 p-5">
      <p className="text-sm text-muted">Gilt für die gesamte Oberfläche. Jedes Dashboard und jede Seite kann ein eigenes Design überlagern.</p>
      <ThemeEditor
        value={spec}
        onChange={(v) => {
          setSpec(v)
          setLocal(v)
        }}
      />
      <SaveBar
        onSave={async () => {
          try {
            await api.put('settings/appearance', { preset: spec.preset || 'dark-analytics', overrides: spec.overrides || {} })
            toast.ok('Erscheinungsbild gespeichert')
            reload()
            loadAppearance()
          } catch (e) {
            toast.error(e)
          }
        }}
      />
    </Card>
  )
}

function Security({ settings, reload }: { settings: Settings; reload: () => void }) {
  const { draft, set, save } = useSection(settings, 'security', reload)
  const me = useApp((s) => s.status?.user)
  const { data: users, reload: reloadUsers } = useAsync(() => api.get<any[]>('auth/users'), [])
  const { data: shares, reload: reloadShares } = useAsync(() => api.get<any[]>('auth/shares'), [])
  const [newUser, setNewUser] = useState<{ username: string; password: string; role: string } | null>(null)
  const [pw, setPw] = useState({ current: '', new: '' })
  return (
    <div className="space-y-6">
      <Card title="Benutzer" actions={<Button size="sm" onClick={() => setNewUser({ username: '', password: '', role: 'viewer' })}>Benutzer anlegen</Button>} bodyClass="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-muted"><th className="px-5 py-2">Benutzer</th><th className="px-2 py-2">Quelle</th><th className="px-2 py-2">Rolle</th><th className="px-2 py-2">Letzte Anmeldung</th><th /></tr>
          </thead>
          <tbody>
            {users?.map((u) => (
              <tr key={u.id} className="border-t border-line/30">
                <td className="px-5 py-2">{u.username}</td>
                <td className="px-2 py-2"><Badge>{u.source === 'homeassistant' ? 'Home Assistant' : 'lokal'}</Badge></td>
                <td className="px-2 py-2">
                  <select
                    className="rounded-md border border-line/60 bg-bg/60 px-1.5 py-1 text-xs"
                    value={u.role}
                    onChange={async (e) => {
                      try {
                        await api.patch(`auth/users/${u.id}`, { role: e.target.value })
                        reloadUsers()
                      } catch (err) {
                        toast.error(err)
                      }
                    }}
                  >
                    <option value="viewer">Betrachter</option>
                    <option value="editor">Bearbeiter</option>
                    <option value="admin">Administrator</option>
                  </select>
                </td>
                <td className="px-2 py-2 text-xs text-muted">{formatAge(u.last_login)}</td>
                <td className="px-3 py-2 text-right">
                  {u.id !== me?.id && (
                    <IconButton
                      title="Löschen"
                      onClick={async () => {
                        if (!(await confirmDialog('Benutzer löschen', `${u.username} löschen?`, { danger: true }))) return
                        try {
                          await api.del(`auth/users/${u.id}`)
                          reloadUsers()
                        } catch (err) {
                          toast.error(err)
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {me?.kind === 'login' && (
        <Card title="Eigenes Passwort ändern" bodyClass="grid gap-4 p-5 md:grid-cols-3">
          <Field label="Aktuelles Passwort"><Input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label="Neues Passwort"><Input type="password" value={pw.new} onChange={(e) => setPw({ ...pw, new: e.target.value })} /></Field>
          <div className="flex items-end">
            <Button onClick={async () => { try { await api.post('auth/password', pw); toast.ok('Passwort geändert'); setPw({ current: '', new: '' }) } catch (e) { toast.error(e) } }}>Ändern</Button>
          </div>
        </Card>
      )}
      <Card title="Sicherheitseinstellungen" bodyClass="grid gap-4 p-5 md:grid-cols-2">
        <Field label="Sitzungsdauer (Stunden)"><NumberInput value={draft.session_hours} min={1} onChange={(v) => set('session_hours', v ?? 720)} /></Field>
        <Field label="Rolle für Home-Assistant-Benutzer (Seitenleiste)">
          <Select value={draft.ingress_role || 'admin'} onChange={(v) => set('ingress_role', v)} options={[{ value: 'admin', label: 'Administrator' }, { value: 'editor', label: 'Bearbeiter' }, { value: 'viewer', label: 'Betrachter' }]} />
        </Field>
        <Field label="Max. Anmeldeversuche je 5 Minuten"><NumberInput value={draft.login_rate_limit} min={1} onChange={(v) => set('login_rate_limit', v ?? 10)} /></Field>
        <div className="flex items-end"><Switch checked={draft.allow_direct_login !== false} onChange={(v) => set('allow_direct_login', v)} label="Anmeldung über Direktport erlauben" /></div>
        <p className="text-xs text-muted md:col-span-2">Die Rolle gilt für neu angelegte Home-Assistant-Benutzer; bestehende lassen sich oben ändern. Den Direktport nicht ungeschützt ins Internet freigeben – für Fernzugriff einen Reverse Proxy mit TLS verwenden.</p>
        <div className="md:col-span-2"><SaveBar onSave={save} /></div>
      </Card>
      <Card title="Präsentationslinks (schreibgeschützt)" bodyClass="p-0">
        <table className="w-full text-sm">
          <tbody>
            {shares?.map((s) => (
              <tr key={s.id} className="border-t border-line/30 first:border-0">
                <td className="px-5 py-2">{s.name} <span className="text-xs text-muted">…{s.token_hint}</span></td>
                <td className="px-2 py-2 text-xs text-muted">Dashboard #{s.dashboard_id}</td>
                <td className="px-2 py-2 text-xs text-muted">{s.expires_at ? `gültig bis ${formatTs(s.expires_at)}` : 'unbegrenzt'}</td>
                <td className="px-2 py-2 text-xs text-muted">zuletzt {formatAge(s.last_used)}</td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={async () => { await api.del(`auth/shares/${s.id}`); reloadShares() }}>Widerrufen</Button>
                </td>
              </tr>
            ))}
            {!shares?.length && <tr><td className="p-5 text-sm text-muted">Keine Links. Erstellen im Dashboard über das Link-Symbol.</td></tr>}
          </tbody>
        </table>
      </Card>
      <Modal
        open={!!newUser}
        onClose={() => setNewUser(null)}
        title="Benutzer anlegen"
        size="sm"
        footer={
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await api.post('auth/users', newUser)
                setNewUser(null)
                reloadUsers()
                toast.ok('Benutzer angelegt')
              } catch (e) {
                toast.error(e)
              }
            }}
          >
            Anlegen
          </Button>
        }
      >
        {newUser && (
          <div className="space-y-3">
            <Field label="Benutzername"><Input value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} /></Field>
            <Field label="Passwort" hint="mindestens 8 Zeichen"><Input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} /></Field>
            <Field label="Rolle">
              <Select value={newUser.role} onChange={(v) => setNewUser({ ...newUser, role: v })} options={[{ value: 'viewer', label: 'Betrachter' }, { value: 'editor', label: 'Bearbeiter' }, { value: 'admin', label: 'Administrator' }]} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  )
}

function AiSection({ settings, reload }: { settings: Settings; reload: () => void }) {
  const { draft, set, save } = useSection(settings, 'ai', reload)
  return (
    <Card title="KI-Anbieter" bodyClass="grid gap-4 p-5 md:grid-cols-2">
      <p className="text-sm text-muted md:col-span-2">
        Standard ist <b>„Nur Export“</b>: Daten und Prompt werden erzeugt und von Ihnen in ChatGPT eingefügt – ohne API-Key. Optional kann ein lokaler (Ollama) oder OpenAI-kompatibler Dienst für direkte Analysen eingetragen werden. Diese Anbieter sind standardmäßig deaktiviert.
      </p>
      <Field label="Anbieter">
        <Select
          value={draft.provider || 'none'}
          onChange={(v) => set('provider', v)}
          options={[
            { value: 'none', label: 'Nur Export (ChatGPT manuell)' },
            { value: 'ollama', label: 'Ollama (lokal)' },
            { value: 'openai_compatible', label: 'OpenAI-kompatible API' },
          ]}
        />
      </Field>
      <Field label="ChatGPT-Adresse für „ChatGPT öffnen“"><Input value={draft.chatgpt_url || ''} onChange={(e) => set('chatgpt_url', e.target.value)} /></Field>
      {draft.provider === 'ollama' && (
        <>
          <Field label="Ollama-URL"><Input value={draft.ollama_url || ''} onChange={(e) => set('ollama_url', e.target.value)} /></Field>
          <Field label="Modell"><Input value={draft.ollama_model || ''} onChange={(e) => set('ollama_model', e.target.value)} /></Field>
        </>
      )}
      {draft.provider === 'openai_compatible' && (
        <>
          <Field label="Basis-URL" hint="z. B. http://192.168.1.10:1234/v1"><Input value={draft.openai_base_url || ''} onChange={(e) => set('openai_base_url', e.target.value)} /></Field>
          <Field label="Modell"><Input value={draft.openai_model || ''} onChange={(e) => set('openai_model', e.target.value)} /></Field>
          <Field label="API-Key (optional)"><Input type="password" value={draft.openai_api_key || ''} onChange={(e) => set('openai_api_key', e.target.value)} /></Field>
        </>
      )}
      {draft.provider !== 'none' && <Field label="Zeitlimit (Sekunden)"><NumberInput value={draft.timeout_seconds} min={10} max={900} onChange={(v) => set('timeout_seconds', v ?? 120)} /></Field>}
      <div className="md:col-span-2"><SaveBar onSave={save} /></div>
    </Card>
  )
}

function BackupSection({ settings, reload }: { settings: Settings; reload: () => void }) {
  const { draft, set, save } = useSection(settings, 'backup', reload)
  const { data: backups, reload: reloadBackups } = useAsync(() => api.get<any[]>('backups'), [])
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const create = async (include_data: boolean) => {
    setBusy(true)
    try {
      const r = await api.post<any>('backups', { include_data })
      toast.ok(`Sicherung erstellt: ${r.name}`)
      reloadBackups()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  const verify = async (name: string) => {
    try {
      const r = await api.post<any>(`backups/${name}/verify`)
      if (r.ok) toast.ok('Sicherung ist gültig (Prüfsummen und Integrität OK)')
      else toast.error('Ungültig: ' + r.errors.join('; '))
    } catch (e) {
      toast.error(e)
    }
  }
  const restore = async (name: string, mode: 'full' | 'config') => {
    const ok = await confirmDialog(
      'Wiederherstellen',
      mode === 'full'
        ? `Gesamte Datenbank aus „${name}“ wiederherstellen? Der aktuelle Stand wird vorher automatisch gesichert.`
        : `Nur Konfiguration (Dashboards, Kennzahlen, Einstellungen, Entitätenauswahl) aus „${name}“ übernehmen? Messwerte bleiben erhalten.`,
      { danger: true, confirmLabel: 'Wiederherstellen' },
    )
    if (!ok) return
    try {
      const r = await api.post<any>(`backups/${name}/restore`, { mode })
      toast.ok(`Wiederhergestellt (${r.mode})`)
      setTimeout(() => window.location.reload(), 1200)
    } catch (e) {
      toast.error(e)
    }
  }
  const upload = async (f: File) => {
    const fd = new FormData()
    fd.append('file', f)
    try {
      await api.post('backups/upload', fd)
      toast.ok('Sicherung hochgeladen und geprüft')
      reloadBackups()
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <div className="space-y-6">
      <Card
        title="Sicherungen"
        actions={
          <>
            <input ref={fileRef} type="file" accept=".zip" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>Hochladen</Button>
            <Button size="sm" loading={busy} onClick={() => create(false)}>Nur Konfiguration</Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => create(true)}>Vollständige Sicherung</Button>
          </>
        }
        bodyClass="p-0"
      >
        <table className="w-full text-sm">
          <tbody>
            {backups?.map((b) => (
              <tr key={b.name} className="border-t border-line/30 first:border-0">
                <td className="px-5 py-2">
                  <div className="font-mono text-xs">{b.name}</div>
                  <div className="text-xs text-muted">{formatTs(b.created_at)} · {formatBytes(b.size)} · v{b.app_version} {b.invalid && <Badge tone="bad">ungültig</Badge>}</div>
                </td>
                <td className="px-2 py-2"><Badge tone={b.include_data ? 'accent' : 'default'}>{b.include_data ? 'mit Messwerten' : 'Konfiguration'}</Badge> <Badge>{b.kind}</Badge></td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <Button size="sm" variant="ghost" onClick={() => verify(b.name)}>Prüfen</Button>
                  <IconButton title="Herunterladen" onClick={() => download('GET', `backups/${b.name}/download`, undefined, b.name).catch(toast.error)}><Download className="h-4 w-4" /></IconButton>
                  {b.include_data && <Button size="sm" variant="ghost" onClick={() => restore(b.name, 'full')}>Komplett</Button>}
                  <Button size="sm" variant="ghost" onClick={() => restore(b.name, 'config')}>Konfig.</Button>
                  <IconButton title="Löschen" onClick={async () => { if (await confirmDialog('Sicherung löschen', b.name, { danger: true })) { await api.del(`backups/${b.name}`); reloadBackups() } }}><Trash2 className="h-4 w-4" /></IconButton>
                </td>
              </tr>
            ))}
            {!backups?.length && <tr><td className="p-5 text-sm text-muted">Noch keine Sicherungen.</td></tr>}
          </tbody>
        </table>
      </Card>
      <Card title="Automatische Sicherung" bodyClass="grid gap-4 p-5 md:grid-cols-2">
        <Switch checked={!!draft.auto_enabled} onChange={(v) => set('auto_enabled', v)} label="Tägliche automatische Sicherung" />
        <Switch checked={!!draft.auto_include_data} onChange={(v) => set('auto_include_data', v)} label="Messwerte einschließen" />
        <Field label="Anzahl aufbewahren"><NumberInput value={draft.auto_keep} min={1} max={60} onChange={(v) => set('auto_keep', v ?? 3)} /></Field>
        <Field label="Uhrzeit (Stunde)"><NumberInput value={draft.auto_hour} min={0} max={23} onChange={(v) => set('auto_hour', v ?? 3)} /></Field>
        <p className="text-xs text-muted md:col-span-2">
          Home-Assistant-Backups: Vor jedem HA-Backup erstellt das Add-on automatisch einen konsistenten Datenbank-Snapshot, der im HA-Backup enthalten ist. Nach einer Wiederherstellung über Home Assistant wird dieser Snapshot beim Start übernommen.
          Sicherungen enthalten auch gespeicherte Zugangsdaten (z. B. HA-Token) – sicher aufbewahren.
        </p>
        <div className="md:col-span-2"><SaveBar onSave={save} /></div>
      </Card>
    </div>
  )
}

function ExportSection() {
  const [sources, setSources] = useState<Source[]>([])
  const [range, setRange] = useState<any>('last_30d')
  const [interval, setInterval] = useState('1h')
  const [busy, setBusy] = useState(false)
  const exp = async (format: 'csv' | 'json') => {
    setBusy(true)
    try {
      await download('POST', 'export/series', { sources, range, interval, format })
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-6">
      <Card title="Messwerte exportieren" bodyClass="space-y-4 p-5">
        <Field label="Datenquellen"><SourceList value={sources} onChange={setSources} multi /></Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Zeitraum"><RangePicker value={range} onChange={setRange} /></Field>
          <Field label="Intervall"><Select value={interval} onChange={setInterval} options={INTERVALS.filter((i) => i.value !== 'auto')} /></Field>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" disabled={!sources.length} loading={busy} onClick={() => exp('csv')}>CSV exportieren</Button>
          <Button disabled={!sources.length} loading={busy} onClick={() => exp('json')}>JSON exportieren</Button>
        </div>
        <p className="text-xs text-muted">CSV mit Semikolon und Dezimalkomma (Excel-kompatibel), Zeitstempel in lokaler Zeitzone.</p>
      </Card>
      <Card title="Konfiguration exportieren" bodyClass="space-y-3 p-5">
        <p className="text-sm text-muted">Dashboards, Kennzahlen, Konstanten, Einstellungen und Entitätenauswahl als JSON (ohne Messwerte, Zugangsdaten maskiert).</p>
        <Button onClick={() => download('GET', 'export/config').catch(toast.error)}>Konfiguration herunterladen</Button>
        <p className="text-xs text-muted">Einzelne Dashboards lassen sich in der Dashboard-Übersicht exportieren und importieren.</p>
      </Card>
    </div>
  )
}

function SystemInfo() {
  const { data, reload } = useAsync(() => api.get<any>('system/info'), [])
  if (!data) return <Spinner />
  const rows: [string, any][] = [
    ['Version', data.version],
    ['Schema', data.schema_version],
    ['Python', data.python],
    ['Architektur', data.arch],
    ['Plattform', data.platform],
    ['Supervisor', data.supervisor ? 'ja' : 'nein (Standalone)'],
    ['Datenverzeichnis', data.data_dir],
    ['Ingress-Port', data.ingress_port],
    ['Direktport', data.direct_port || 'deaktiviert'],
    ['Zeitzone', data.timezone],
    ['Laufzeit', `${formatNumber(data.uptime / 3600, { decimals: 1 })} h`],
    ['Dashboards / Seiten', `${data.counts.dashboards} / ${data.counts.pages}`],
    ['Kennzahlen / Konstanten', `${data.counts.metrics} / ${data.counts.constants}`],
    ['Empfangene Messwerte (seit Start)', data.recorder.ingested],
    ['Geschriebene Messwerte (seit Start)', data.recorder.flushed],
    ['HA-Ereignisse empfangen', data.ha.events_received],
  ]
  return (
    <Card title="Systeminformationen" actions={<IconButton title="Aktualisieren" onClick={reload}><RefreshCw className="h-4 w-4" /></IconButton>} bodyClass="p-0">
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t border-line/30 first:border-0">
              <td className="w-72 px-5 py-2 text-muted">{k}</td>
              <td className="px-2 py-2 font-mono text-xs">{String(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function Diagnostics() {
  const { data, reload, loading } = useAsync(() => api.get<any>('system/diagnostics'), [])
  const [level, setLevel] = useState('')
  return (
    <div className="space-y-6">
      <Card title="Selbsttest" actions={<Button size="sm" loading={loading} icon={<RefreshCw className="h-4 w-4" />} onClick={reload}>Erneut prüfen</Button>}>
        {!data ? <Spinner /> : (
          <ul className="space-y-2">
            {data.checks.map((c: any) => (
              <li key={c.name} className="flex items-center gap-3 text-sm">
                {c.ok ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <XCircle className="h-4 w-4 text-bad" />}
                <span className="w-64">{c.name}</span>
                <span className="text-muted">{c.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Protokoll" actions={<Select className="w-36" value={level} onChange={setLevel} placeholder="Alle" options={[{ value: 'WARNING', label: 'Warnungen' }, { value: 'ERROR', label: 'Fehler' }]} />} bodyClass="p-0">
        <pre className="max-h-[60vh] overflow-auto p-4 text-xs leading-relaxed">
          {(data?.logs || [])
            .filter((l: any) => !level || l.level === level || (level === 'WARNING' && l.level === 'ERROR'))
            .map((l: any) => `${new Date(l.ts * 1000).toLocaleString('de-DE')} ${l.level.padEnd(7)} [${l.logger}] ${l.message}`)
            .join('\n') || 'Keine Einträge'}
        </pre>
      </Card>
    </div>
  )
}

function LinkCard({ title, text, to, icon: Icon }: { title: string; text: string; to: string; icon: any }) {
  return (
    <Card title={title}>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted">{text}</p>
        <Link to={to}><Button icon={<Icon className="h-4 w-4" />}>Öffnen</Button></Link>
      </div>
    </Card>
  )
}

export default function SettingsPage() {
  const { section = 'general' } = useParams()
  const navigate = useNavigate()
  const { data: settings, reload } = useAsync(() => api.get<Settings>('settings'), [])
  const content = () => {
    if (!settings) return <Spinner />
    switch (section) {
      case 'general': return <General settings={settings} reload={reload} />
      case 'homeassistant': return <HomeAssistant settings={settings} reload={reload} />
      case 'entities': return <LinkCard title="Entitäten" text="Auswahl der aufzuzeichnenden Entitäten, Wertetyp, Aufbewahrung je Entität und Speicherverbrauch." to="/entities" icon={Plug} />
      case 'storage': return <Storage settings={settings} reload={reload} />
      case 'database': return <DatabaseSection />
      case 'import': return <ImportSection />
      case 'metrics': return <LinkCard title="Berechnete Kennzahlen" text="Formeln, Konstanten (Preise) und Vorschau rückwirkender Berechnungen." to="/metrics" icon={Calculator} />
      case 'dashboards': return <LinkCard title="Dashboard-Verwaltung" text="Dashboards anlegen, umbenennen, duplizieren, sortieren, exportieren/importieren und als Startseite festlegen." to="/dashboards" icon={LayoutDashboard} />
      case 'appearance': return <Appearance settings={settings} reload={reload} />
      case 'security': return <Security settings={settings} reload={reload} />
      case 'ai': return <AiSection settings={settings} reload={reload} />
      case 'backup': return <BackupSection settings={settings} reload={reload} />
      case 'export': return <ExportSection />
      case 'system': return <SystemInfo />
      case 'diagnostics': return <Diagnostics />
      default: return null
    }
  }
  return (
    <div>
      <PageHeader icon={<SettingsIcon className="h-5 w-5" />} title="Einstellungen" />
      <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
        <nav className="space-y-0.5">
          <select className="input mb-3 lg:hidden" value={section} onChange={(e) => navigate(`/settings/${e.target.value}`)}>
            {SECTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          {SECTIONS.map((s) => (
            <Link key={s.id} to={`/settings/${s.id}`} className={clsx('hidden items-center gap-2.5 rounded-lg px-3 py-2 text-sm lg:flex', section === s.id ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-fg/5 hover:text-fg')}>
              <s.icon className="h-4 w-4" />
              {s.label}
            </Link>
          ))}
        </nav>
        <div className="min-w-0">{content()}</div>
      </div>
    </div>
  )
}

