import { ArrowDown, ArrowUp, Copy, Download, LayoutDashboard, Pencil, Plus, Presentation, Star, Trash2, Upload } from 'lucide-react'
import { useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, download } from '../api/client'
import type { Dashboard } from '../api/types'
import { Badge, Button, Empty, IconButton, PageHeader, Spinner, confirmDialog, promptDialog, toast, useAsync } from '../components/ui'
import { useApp, useRole } from '../store/app'
import { presetById, resolveTheme, withAlpha } from '../theme/presets'
import { formatAge } from '../utils/format'

export default function DashboardsPage() {
  const navigate = useNavigate()
  const canEdit = useRole('editor')
  const isAdmin = useRole('admin')
  const defaultId = useApp((s) => s.appearance?.general?.default_dashboard)
  const loadAppearance = useApp((s) => s.loadAppearance)
  const { data, loading, reload } = useAsync(() => api.get<Dashboard[]>('dashboards'), [])
  const fileRef = useRef<HTMLInputElement>(null)

  const create = async () => {
    const name = await promptDialog('Neues Dashboard', 'Name', 'Mein Dashboard')
    if (!name) return
    try {
      const d = await api.post<Dashboard>('dashboards', { name })
      navigate(`/d/${d.id}`)
    } catch (e) {
      toast.error(e)
    }
  }

  const rename = async (d: Dashboard) => {
    const name = await promptDialog('Dashboard umbenennen', 'Name', d.name)
    if (!name) return
    await api.put(`dashboards/${d.id}`, { name }).catch(toast.error)
    reload()
  }

  const duplicate = async (d: Dashboard) => {
    try {
      await api.post(`dashboards/${d.id}/duplicate`)
      toast.ok('Dashboard dupliziert')
      reload()
    } catch (e) {
      toast.error(e)
    }
  }

  const remove = async (d: Dashboard) => {
    if (!(await confirmDialog('Dashboard löschen', `„${d.name}“ mit allen Seiten unwiderruflich löschen?`, { danger: true, confirmLabel: 'Löschen' }))) return
    await api.del(`dashboards/${d.id}`).catch(toast.error)
    reload()
  }

  const move = async (idx: number, dir: -1 | 1) => {
    if (!data) return
    const order = data.map((d) => d.id)
    const j = idx + dir
    if (j < 0 || j >= order.length) return
    ;[order[idx], order[j]] = [order[j], order[idx]]
    await api.post('dashboards/reorder', { order }).catch(toast.error)
    reload()
  }

  const setDefault = async (d: Dashboard) => {
    try {
      await api.put('settings/general', { default_dashboard: defaultId === d.id ? null : d.id })
      await loadAppearance()
      toast.ok(defaultId === d.id ? 'Startseite zurückgesetzt' : `„${d.name}“ ist jetzt die Startseite`)
    } catch (e) {
      toast.error(e)
    }
  }

  const importFile = async (f: File) => {
    try {
      const json = JSON.parse(await f.text())
      const res = await api.post<{ dashboard: Dashboard; created: { metrics: string[]; constants: string[]; skipped: string[] } }>('dashboards/import', json)
      toast.ok(`Importiert: ${res.dashboard.name} (${res.created.metrics.length} Kennzahlen, ${res.created.constants.length} Konstanten neu)`)
      reload()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <div>
      <PageHeader
        icon={<LayoutDashboard className="h-5 w-5" />}
        title="Dashboards"
        subtitle="Eigene Analyse-Oberflächen mit mehreren Seiten"
        actions={
          canEdit && (
            <>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
              <Button icon={<Upload className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>
                Importieren
              </Button>
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={create}>
                Neues Dashboard
              </Button>
            </>
          )
        }
      />
      {loading && !data && <Spinner />}
      {data && data.length === 0 && (
        <Empty icon={<LayoutDashboard className="h-12 w-12" />} title="Noch keine Dashboards">
          Legen Sie ein Dashboard an und gestalten Sie es per Drag & Drop. Tipp: Zuerst unter „Entitäten“ die gewünschten Sensoren zur Aufzeichnung auswählen.
        </Empty>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {data?.map((d, i) => {
          const t = resolveTheme(useApp.getState().appearance?.appearance, d.theme)
          return (
            <div key={d.id} className="panel group overflow-hidden">
              <Link to={`/d/${d.id}`} className="block h-28 p-3" style={{ background: t.background, backgroundImage: t.backgroundGradient || undefined }}>
                <div className="grid h-full grid-cols-4 gap-1.5">
                  {[2, 1, 1, 2].map((span, k) => (
                    <div key={k} style={{ gridColumn: `span ${span}`, background: withAlpha(t.surface, t.surfaceOpacity), border: `1px solid ${withAlpha(t.border, t.borderOpacity)}`, borderRadius: Math.min(10, t.radius / 2) }}>
                      <div className="m-2 h-1.5 w-1/2 rounded" style={{ background: t.palette[k] }} />
                    </div>
                  ))}
                </div>
              </Link>
              <div className="flex items-start gap-2 p-4">
                <div className="min-w-0 flex-1">
                  <Link to={`/d/${d.id}`} className="block truncate font-semibold hover:text-accent">
                    {d.name}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <Badge>{d.page_count} Seite(n)</Badge>
                    <Badge tone="accent">{presetById(d.theme?.preset || useApp.getState().appearance?.appearance.preset).name}</Badge>
                    {defaultId === d.id && <Badge tone="ok">Startseite</Badge>}
                    <span>geändert {formatAge(d.updated_at)}</span>
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-0.5 border-t border-line/40 px-2 py-1.5">
                <IconButton title="Präsentation" onClick={() => navigate(`/present/${d.id}`)}>
                  <Presentation className="h-4 w-4" />
                </IconButton>
                {canEdit && (
                  <>
                    <IconButton title="Umbenennen" onClick={() => rename(d)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton title="Duplizieren" onClick={() => duplicate(d)}>
                      <Copy className="h-4 w-4" />
                    </IconButton>
                    <IconButton title="Exportieren" onClick={() => download('GET', `dashboards/${d.id}/export`).catch(toast.error)}>
                      <Download className="h-4 w-4" />
                    </IconButton>
                    <IconButton title="Nach vorne" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="h-4 w-4" />
                    </IconButton>
                    <IconButton title="Nach hinten" disabled={i === data.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="h-4 w-4" />
                    </IconButton>
                  </>
                )}
                {isAdmin && (
                  <IconButton title="Als Startseite festlegen" active={defaultId === d.id} onClick={() => setDefault(d)}>
                    <Star className="h-4 w-4" />
                  </IconButton>
                )}
                {canEdit && (
                  <IconButton title="Löschen" className="ml-auto hover:text-bad" onClick={() => remove(d)}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
