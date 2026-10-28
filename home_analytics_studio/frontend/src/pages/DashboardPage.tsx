import clsx from 'clsx'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Download,
  Eye,
  Layers,
  LayoutGrid,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Presentation,
  RefreshCw,
  Settings2,
  Trash2,
  Share2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ApiError, api, download } from '../api/client'
import type { Breakpoint, Dashboard, Page } from '../api/types'
import { Button, Empty, Field, IconButton, Input, Modal, NumberInput, Spinner, Tabs, confirmDialog, promptDialog, toast } from '../components/ui'
import { ShareSheet } from '../components/Displays'
import { DashboardSettingsModal, PageSettingsModal } from '../dashboard/DashboardSettings'
import { EditorToolbar, LayersPanel, WidgetPalette } from '../dashboard/EditorPanels'
import GridCanvas from '../dashboard/GridCanvas'
import ThemedSurface from '../dashboard/ThemedSurface'
import { useEditor } from '../dashboard/editorStore'
import { useApp, useRole } from '../store/app'
import { useCatalog } from '../store/catalog'
import { RuntimeContext } from '../theme/context'
import WidgetEditor from '../widgets/WidgetEditor'
import { widgetDef } from '../widgets/registry'

export function PageNav({ dashboard, pageId, onSelect, editing, onReorder, onAdd, onPageMenu }: {
  dashboard: Dashboard
  pageId: number
  onSelect: (id: number) => void
  editing?: boolean
  onReorder?: (id: number, dir: -1 | 1) => void
  onAdd?: () => void
  onPageMenu?: (p: Page) => void
}) {
  const nav = dashboard.settings.navigation
  const pages = dashboard.pages.filter((p) => editing || !p.hidden)
  if (!editing && (nav.position === 'hidden' || pages.length < 2)) return null
  const vertical = nav.position === 'side'
  return (
    <nav className={clsx('flex gap-1', vertical ? 'flex-col' : 'flex-wrap items-center')}>
      {pages.map((p, i) => (
        <div key={p.id} className="group flex items-center">
          <button
            onClick={() => onSelect(p.id)}
            onDoubleClick={() => editing && onPageMenu?.(p)}
            className={clsx(
              'whitespace-nowrap px-3 py-1.5 text-sm transition',
              nav.style === 'pills' && 'rounded-full',
              nav.style === 'tabs' && 'rounded-lg',
              nav.style === 'minimal' && 'border-b-2 border-transparent',
              p.id === pageId
                ? nav.style === 'minimal'
                  ? 'border-accent text-accent'
                  : 'bg-accent/15 text-accent'
                : 'text-muted hover:bg-fg/5 hover:text-fg',
              p.hidden && 'opacity-50',
            )}
          >
            {p.title}
          </button>
          {editing && (
            <span className="hidden items-center group-hover:flex">
              {i > 0 && (
                <IconButton className="h-6 w-6" title="Nach vorne" onClick={() => onReorder?.(p.id, -1)}>
                  <ArrowLeft className="h-3 w-3" />
                </IconButton>
              )}
              {i < pages.length - 1 && (
                <IconButton className="h-6 w-6" title="Nach hinten" onClick={() => onReorder?.(p.id, 1)}>
                  <ArrowRight className="h-3 w-3" />
                </IconButton>
              )}
              <IconButton className="h-6 w-6" title="Seiteneinstellungen" onClick={() => onPageMenu?.(p)}>
                <Settings2 className="h-3 w-3" />
              </IconButton>
            </span>
          )}
        </div>
      ))}
      {editing && (
        <IconButton title="Seite hinzufügen" onClick={onAdd}>
          <Plus className="h-4 w-4" />
        </IconButton>
      )}
    </nav>
  )
}

function ShareModal({ open, onClose, dashboard }: { open: boolean; onClose: () => void; dashboard: Dashboard }) {
  const [days, setDays] = useState<number | null>(null)
  const [name, setName] = useState('Wanddisplay')
  const [link, setLink] = useState<string | null>(null)
  const create = async () => {
    try {
      const res = await api.post<{ token: string }>('auth/shares', { name, dashboard_id: dashboard.id, days })
      const configured = (useApp.getState().appearance?.base_url || '').replace(/\/+$/, '')
      const base = configured ? `${configured}/` : window.location.href.split('#')[0]
      setLink(`${base}#/present/${dashboard.id}?share=${res.token}&kiosk=1`)
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <Modal open={open} onClose={() => { setLink(null); onClose() }} title="Präsentationslink (schreibgeschützt)" size="md">
      {!link ? (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Erstellt einen Link, mit dem dieses Dashboard ohne Anmeldung im Präsentationsmodus angezeigt werden kann (z. B. für Wanddisplays). Der Zugang kann nur Daten lesen und keine Einstellungen ändern.
            Links lassen sich unter Einstellungen → Benutzer & Sicherheit widerrufen.
          </p>
          <Field label="Bezeichnung">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Gültigkeit in Tagen (leer = unbegrenzt)">
            <NumberInput value={days} min={1} onChange={setDays} />
          </Field>
          <Button variant="primary" onClick={create} icon={<Link2 className="h-4 w-4" />}>
            Link erzeugen
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-warn">Der Link wird nur jetzt angezeigt. Bitte sicher aufbewahren und nicht öffentlich ins Internet stellen.</p>
          <Input readOnly value={link} onFocus={(e) => e.target.select()} />
          <Button
            icon={<Copy className="h-4 w-4" />}
            onClick={() => {
              navigator.clipboard?.writeText(link).then(() => toast.ok('Link kopiert'), () => toast.error('Kopieren nicht möglich – bitte manuell markieren'))
            }}
          >
            Kopieren
          </Button>
        </div>
      )}
    </Modal>
  )
}

export default function DashboardPage() {
  const { id, pageId: pageParam } = useParams()
  const navigate = useNavigate()
  const canEdit = useRole('editor')
  const timezone = useApp((s) => s.appearance?.timezone)
  const currency = useApp((s) => s.appearance?.general?.currency) || '€'
  const loadCatalog = useCatalog((s) => s.load)
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [side, setSide] = useState<'widgets' | 'layers'>('widgets')
  const [previewBp, setPreviewBp] = useState<Breakpoint | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pageMenu, setPageMenu] = useState<Page | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [castOpen, setCastOpen] = useState(false)
  const isUser = useApp((s) => s.status?.user?.kind === 'login' || s.status?.user?.kind === 'ingress')
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [nonce, setNonce] = useState(0)
  const versionRef = useRef<number>(1)
  const viewBpRef = useRef<Breakpoint>('lg')

  const editor = useEditor()
  const pageId = Number(pageParam) || dash?.pages[0]?.id || 0
  const page = dash?.pages.find((p) => p.id === pageId) || dash?.pages[0]

  const load = useCallback(async () => {
    try {
      const d = await api.get<Dashboard>(`dashboards/${id}`)
      setDash(d)
      setError(null)
      return d
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [id])

  useEffect(() => {
    load()
    loadCatalog()
  }, [load, loadCatalog])

  // load page into editor store
  useEffect(() => {
    if (!page || !dash) return
    useEditor.getState().load(page.id, page.widgets, page.layouts, dash.settings.grid.cols)
    versionRef.current = page.version
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.id, dash?.id, dash?.settings.grid.cols])

  // ---------------------------------------------------------- autosave
  const save = useCallback(async () => {
    const s = useEditor.getState()
    if (!s.pageId || s.rev === s.savedRev) return
    const rev = s.rev
    setSaving('saving')
    try {
      const res = await api.put<Page>(`pages/${s.pageId}`, { widgets: s.widgets, layouts: s.layouts, version: versionRef.current })
      versionRef.current = res.version
      useEditor.getState().markSaved(rev)
      setDash((d) => (d ? { ...d, pages: d.pages.map((p) => (p.id === res.id ? res : p)) } : d))
      setSaving('saved')
    } catch (e) {
      setSaving('error')
      if (e instanceof ApiError && e.status === 409) {
        toast.error('Die Seite wurde an anderer Stelle geändert. Die aktuelle Version wird geladen.')
        const d = await load()
        const p = d?.pages.find((x) => x.id === s.pageId)
        if (p) {
          useEditor.getState().load(p.id, p.widgets, p.layouts, d!.settings.grid.cols)
          versionRef.current = p.version
        }
      } else toast.error(e)
    }
  }, [load])

  useEffect(() => {
    if (!editing || editor.rev === editor.savedRev) return
    const t = window.setTimeout(save, 800)
    return () => window.clearTimeout(t)
  }, [editor.rev, editor.savedRev, editing, save])

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      const s = useEditor.getState()
      if (s.rev !== s.savedRev) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  // ---------------------------------------------------------- keyboard shortcuts
  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      const mod = e.ctrlKey || e.metaKey
      const st = useEditor.getState()
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        st.undo()
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault()
        st.redo()
      } else if (mod && e.key.toLowerCase() === 'c') {
        const n = st.copySelected()
        if (n) toast.info(`${n} Widget(s) kopiert`)
      } else if (mod && e.key.toLowerCase() === 'v') {
        st.paste()
      } else if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        st.duplicateSelected()
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        st.selectAll()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        st.removeSelected()
      } else if (e.key === 'Escape') {
        st.select(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing])

  const toggleEdit = async () => {
    if (editing) {
      await save()
      useEditor.getState().select(null)
      setPreviewBp(null)
    } else {
      // edit exactly the layout the view is currently showing (reported by the grid in view mode);
      // the canvas is scaled to fit next to the editor panels
      const bp = viewBpRef.current
      setPreviewBp(bp)
      editor.setBreakpoint(bp)
    }
    setEditing((e) => !e)
  }

  // ---------------------------------------------------------- page / dashboard actions
  const selectPage = async (pid: number) => {
    if (editing) await save()
    navigate(`/d/${id}/${pid}`)
  }

  const addPage = async () => {
    const title = await promptDialog('Neue Seite', 'Titel', `Seite ${(dash?.pages.length || 0) + 1}`)
    if (!title) return
    try {
      await save()
      const p = await api.post<Page>(`dashboards/${id}/pages`, { title })
      await load()
      navigate(`/d/${id}/${p.id}`)
    } catch (e) {
      toast.error(e)
    }
  }

  const reorderPage = async (pid: number, dir: -1 | 1) => {
    if (!dash) return
    const order = dash.pages.map((p) => p.id)
    const i = order.indexOf(pid)
    const j = i + dir
    if (j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    await api.post(`dashboards/${id}/pages/reorder`, { order })
    await load()
  }

  const savePageMeta = async (p: Page, patch: Partial<Page>) => {
    await save()
    const res = await api.put<Page>(`pages/${p.id}`, patch)
    if (p.id === useEditor.getState().pageId) versionRef.current = res.version
    await load()
  }

  const duplicatePage = async (p: Page) => {
    await save()
    const np = await api.post<Page>(`pages/${p.id}/duplicate`)
    await load()
    navigate(`/d/${id}/${np.id}`)
  }

  const deletePage = async (p: Page) => {
    if (!(await confirmDialog('Seite löschen', `Seite „${p.title}“ mit allen Widgets löschen?`, { danger: true, confirmLabel: 'Löschen' }))) return
    try {
      await api.del(`pages/${p.id}`)
      const d = await load()
      navigate(`/d/${id}/${d?.pages[0]?.id || ''}`)
    } catch (e) {
      toast.error(e)
    }
  }

  const saveDashboard = async (patch: Partial<Dashboard>) => {
    try {
      await api.put(`dashboards/${id}`, patch)
      await load()
      toast.ok('Dashboard gespeichert')
    } catch (e) {
      toast.error(e)
    }
  }

  const addWidget = (type: string) => {
    const def = widgetDef(type)
    if (!def) return
    editor.addWidget(type, def.defaultSize, def.defaults, def.label)
  }

  const selectedWidget = editor.selected.length === 1 ? editor.widgets.find((w) => w.id === editor.selected[0]) : undefined
  const themeSpecs = useMemo(() => [dash?.theme, page?.settings?.theme], [dash?.theme, page?.settings?.theme])
  const runtime = useMemo(() => ({ timezone, currency, editing, refreshNonce: nonce }), [timezone, currency, editing, nonce])

  if (error) return <Empty title="Dashboard konnte nicht geladen werden">{error}</Empty>
  if (!dash || !page) return <div className="flex h-full items-center justify-center"><Spinner className="h-8 w-8" /></div>

  const nav = dash.settings.navigation
  const navEl = (
    <PageNav dashboard={dash} pageId={page.id} onSelect={selectPage} editing={editing} onReorder={reorderPage} onAdd={addPage} onPageMenu={setPageMenu} />
  )

  return (
    <RuntimeContext.Provider value={runtime}>
      <ThemedSurface specs={themeSpecs} className="flex min-h-full flex-col">
        {/* header */}
        <header className="sticky top-0 z-40 flex flex-wrap items-center gap-3 border-b border-line/40 bg-[rgb(var(--c-bg)/0.75)] px-4 py-2.5 pl-14 backdrop-blur-xl md:pl-4">
          {nav.showTitle && (
            <Link to="/dashboards" className="mr-2 truncate text-lg font-semibold tracking-tight hover:text-accent" title="Alle Dashboards">
              {dash.name}
            </Link>
          )}
          {nav.position === 'top' && navEl}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            {editing && (
              <span className="mr-2 flex items-center gap-1 text-xs text-muted">
                {saving === 'saving' && <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Speichert…</>}
                {saving === 'saved' && editor.rev === editor.savedRev && <><Check className="h-3.5 w-3.5 text-ok" /> Gespeichert</>}
                {saving === 'error' && <span className="text-bad">Speichern fehlgeschlagen</span>}
              </span>
            )}
            <IconButton title="Daten neu laden" onClick={() => setNonce((n) => n + 1)}>
              <RefreshCw className="h-4 w-4" />
            </IconButton>
            <IconButton title="Präsentationsmodus" onClick={() => navigate(`/present/${dash.id}?page=${page.id}`)}>
              <Presentation className="h-4 w-4" />
            </IconButton>
            {isUser && (
              <Button size="sm" variant="outline" icon={<Share2 className="h-4 w-4" />} onClick={() => setCastOpen(true)} title="Teilen – auf Fernseher oder anderem Gerät anzeigen">
                <span className="hidden sm:inline">Teilen</span>
              </Button>
            )}
            {canEdit && (
              <>

                <IconButton title="Dashboard exportieren (JSON)" onClick={() => download('GET', `dashboards/${dash.id}/export`).catch(toast.error)}>
                  <Download className="h-4 w-4" />
                </IconButton>
                <IconButton title="Dashboard-Einstellungen" onClick={() => setSettingsOpen(true)}>
                  <Settings2 className="h-4 w-4" />
                </IconButton>
                <Button size="sm" variant={editing ? 'primary' : 'secondary'} icon={editing ? <Eye className="h-4 w-4" /> : <Pencil className="h-4 w-4" />} onClick={toggleEdit}>
                  {editing ? 'Fertig' : 'Bearbeiten'}
                </Button>
              </>
            )}
          </div>
        </header>

        {editing && (
          <div className="sticky top-[53px] z-30 border-b border-line/40 bg-[rgb(var(--c-surface)/0.92)] px-3 py-1.5 backdrop-blur-xl">
            <EditorToolbar
              previewBp={previewBp}
              setPreviewBp={(bp) => {
                setPreviewBp(bp)
                if (bp) editor.setBreakpoint(bp)
              }}
              onCopy={() => {
                const n = editor.copySelected()
                if (n) toast.info(`${n} Widget(s) kopiert`)
              }}
              onPaste={() => {
                if (!editor.paste()) toast.info('Zwischenablage ist leer')
              }}
            />
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {editing && (
            <aside className="sticky top-[100px] hidden h-[calc(100vh-100px)] w-64 shrink-0 flex-col border-r border-line/40 bg-[rgb(var(--c-surface)/0.85)] p-3 backdrop-blur-xl lg:flex">
              <Tabs
                value={side}
                onChange={setSide}
                className="mb-3"
                tabs={[
                  { value: 'widgets', label: 'Widgets', icon: <LayoutGrid className="h-3.5 w-3.5" /> },
                  { value: 'layers', label: 'Ebenen', icon: <Layers className="h-3.5 w-3.5" /> },
                ]}
              />
              <div className="min-h-0 flex-1 overflow-y-auto">{side === 'widgets' ? <WidgetPalette onAdd={addWidget} /> : <LayersPanel />}</div>
            </aside>
          )}
          {nav.position === 'side' && !editing && <aside className="w-52 shrink-0 border-r border-line/40 p-3">{navEl}</aside>}
          <main
            className="min-w-0 flex-1 overflow-x-hidden pb-24"
            onDragOver={(e) => editing && e.dataTransfer.types.includes('text/has-widget') && e.preventDefault()}
            onDrop={(e) => {
              const type = e.dataTransfer.getData('text/has-widget')
              if (editing && type) addWidget(type)
            }}
          >
            {editing && nav.position !== 'top' && <div className="px-4 pt-3">{navEl}</div>}
            {editor.widgets.length === 0 && !editing ? (
              <Empty icon={<LayoutGrid className="h-10 w-10" />} title="Diese Seite ist noch leer">
                {canEdit ? 'Klicken Sie auf „Bearbeiten“ und fügen Sie Widgets aus der Palette hinzu.' : 'Es wurden noch keine Widgets angelegt.'}
              </Empty>
            ) : (
              <GridCanvas
                widgets={editor.widgets}
                layouts={editor.layouts}
                settings={dash.settings}
                editing={editing}
                selected={editor.selected}
                previewBp={editing ? previewBp : null}
                onSelect={editor.select}
                onInteractionStart={editor.checkpoint}
                onLayoutChange={(all) => editor.setLayouts(all, false)}
                onBreakpoint={(bp) => {
                  if (!editing) viewBpRef.current = bp
                  if (!previewBp) editor.setBreakpoint(bp)
                }}
                minHeight={editing ? 500 : undefined}
              />
            )}
            {editing && editor.widgets.length === 0 && (
              <p className="text-center text-sm text-muted">Widgets per Klick oder Drag & Drop aus der Palette links hinzufügen.</p>
            )}
          </main>
          {editing && (
            <aside className="sticky top-[100px] h-[calc(100vh-100px)] w-[340px] shrink-0 overflow-y-auto border-l border-line/40 bg-[rgb(var(--c-surface)/0.9)] p-4 backdrop-blur-xl">
              {selectedWidget ? (
                <>
                  <div className="mb-3 flex items-center justify-between">
                    <div className="text-sm font-semibold">{widgetDef(selectedWidget.type)?.label}</div>
                    <IconButton title="Widget löschen" onClick={editor.removeSelected}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                  <WidgetEditor widget={selectedWidget} onChange={editor.updateWidget} />
                </>
              ) : editor.selected.length > 1 ? (
                <div className="space-y-3 text-sm text-muted">
                  <p>{editor.selected.length} Widgets ausgewählt. Nutzen Sie die Ausrichtungswerkzeuge in der Werkzeugleiste.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="text-sm font-semibold">Seite „{page.title}“</div>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setPageMenu(page)} icon={<Settings2 className="h-4 w-4" />}>
                      Einstellungen
                    </Button>
                    <Button size="sm" onClick={() => duplicatePage(page)} icon={<Copy className="h-4 w-4" />}>
                      Duplizieren
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => deletePage(page)} icon={<Trash2 className="h-4 w-4" />}>
                      Löschen
                    </Button>
                  </div>
                  <div className="text-xs text-muted">
                    Tipps: Widget anklicken zum Bearbeiten · Umschalt+Klick für Mehrfachauswahl · Strg+Z/Y rückgängig/wiederholen · Strg+C/V kopieren/einfügen (auch seitenübergreifend) · Entf löschen.
                    Über die Geräte-Symbole bearbeiten Sie das Layout für jede Bildschirmgröße separat.
                  </div>
                  <div>
                    <div className="label">Ebenen</div>
                    <LayersPanel />
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>
        {nav.position === 'bottom' && !editing && <footer className="sticky bottom-0 border-t border-line/40 bg-[rgb(var(--c-bg)/0.8)] px-4 py-2 backdrop-blur-xl">{navEl}</footer>}
      </ThemedSurface>
      <DashboardSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} dashboard={dash} onSave={saveDashboard} />
      {pageMenu && <PageSettingsModal open={!!pageMenu} onClose={() => setPageMenu(null)} page={pageMenu} onSave={(patch) => savePageMeta(pageMenu, patch)} />}
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} dashboard={dash} />
      {castOpen && (
        <ShareSheet
          open={castOpen}
          onClose={() => setCastOpen(false)}
          dashboard={dash}
          page={page}
          onPresentationLink={canEdit ? () => { setCastOpen(false); setShareOpen(true) } : undefined}
        />
      )}
    </RuntimeContext.Provider>
  )
}
