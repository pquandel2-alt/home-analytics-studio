import { useEffect, useState } from 'react'
import type { Breakpoint, Dashboard, DashboardSettings as DS, Page, ThemeSpec } from '../api/types'
import { Button, Field, Input, Modal, NumberInput, Select, Switch, Tabs, Textarea } from '../components/ui'
import ThemeEditor from '../theme/ThemeEditor'
import { BP_LABELS, BP_ORDER } from './editorStore'

type Tab = 'general' | 'design' | 'grid' | 'nav' | 'present'

export function DashboardSettingsModal({ open, onClose, dashboard, onSave }: { open: boolean; onClose: () => void; dashboard: Dashboard; onSave: (patch: Partial<Dashboard>) => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('general')
  const [name, setName] = useState(dashboard.name)
  const [description, setDescription] = useState(dashboard.description || '')
  const [theme, setTheme] = useState<ThemeSpec>(dashboard.theme || {})
  const [settings, setSettings] = useState<DS>(dashboard.settings)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setName(dashboard.name)
      setDescription(dashboard.description || '')
      setTheme(dashboard.theme || {})
      setSettings(dashboard.settings)
    }
  }, [open, dashboard])
  const grid = settings.grid
  const setGrid = (k: keyof DS['grid'], v: any) => setSettings({ ...settings, grid: { ...grid, [k]: v } })
  const nav = settings.navigation
  const pres = settings.presentation
  const save = async () => {
    setBusy(true)
    try {
      await onSave({ name, description, theme, settings })
      onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Dashboard-Einstellungen"
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-5"
        tabs={[
          { value: 'general', label: 'Allgemein' },
          { value: 'design', label: 'Design' },
          { value: 'grid', label: 'Raster' },
          { value: 'nav', label: 'Navigation' },
          { value: 'present', label: 'Präsentation' },
        ]}
      />
      {tab === 'general' && (
        <div className="space-y-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Beschreibung">
            <Textarea className="font-sans" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
      )}
      {tab === 'design' && <ThemeEditor value={theme} onChange={setTheme} />}
      {tab === 'grid' && (
        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Zeilenhöhe (px)">
              <NumberInput value={grid.rowHeight} min={10} max={200} onChange={(v) => setGrid('rowHeight', v ?? 40)} />
            </Field>
            <Field label="Abstand zwischen Widgets (px)">
              <NumberInput value={grid.margin} min={0} max={60} onChange={(v) => setGrid('margin', v ?? 12)} />
            </Field>
            <Field label="Automatisches Nachrücken">
              <Select
                value={grid.compact || 'none'}
                onChange={(v) => setGrid('compact', v)}
                options={[
                  { value: 'none', label: 'Aus – freie Positionierung' },
                  { value: 'vertical', label: 'Nach oben' },
                  { value: 'horizontal', label: 'Nach links' },
                ]}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-6">
            <Switch checked={!!grid.allowOverlap} onChange={(v) => setGrid('allowOverlap', v)} label="Überlappung erlauben (Ebenen)" />
            <Switch checked={grid.snap !== false} onChange={(v) => setGrid('snap', v)} label="Rasterlinien im Editor anzeigen" />
          </div>
          <div>
            <div className="label">Spalten je Bildschirmgröße</div>
            <div className="grid gap-3 md:grid-cols-3">
              {BP_ORDER.map((bp: Breakpoint) => (
                <Field key={bp} label={BP_LABELS[bp]}>
                  <NumberInput value={grid.cols[bp]} min={1} max={64} onChange={(v) => setGrid('cols', { ...grid.cols, [bp]: v ?? grid.cols[bp] })} />
                </Field>
              ))}
            </div>
          </div>
        </div>
      )}
      {tab === 'nav' && (
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Position der Seitennavigation">
            <Select
              value={nav.position}
              onChange={(v) => setSettings({ ...settings, navigation: { ...nav, position: v as any } })}
              options={[
                { value: 'top', label: 'Oben' },
                { value: 'side', label: 'Seitlich' },
                { value: 'bottom', label: 'Unten' },
                { value: 'hidden', label: 'Ausgeblendet' },
              ]}
            />
          </Field>
          <Field label="Stil">
            <Select
              value={nav.style}
              onChange={(v) => setSettings({ ...settings, navigation: { ...nav, style: v as any } })}
              options={[
                { value: 'tabs', label: 'Tabs' },
                { value: 'pills', label: 'Pillen' },
                { value: 'minimal', label: 'Minimal' },
              ]}
            />
          </Field>
          <div className="flex items-end">
            <Switch checked={nav.showTitle} onChange={(v) => setSettings({ ...settings, navigation: { ...nav, showTitle: v } })} label="Dashboard-Titel anzeigen" />
          </div>
        </div>
      )}
      {tab === 'present' && (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Automatischer Seitenwechsel (Sekunden, 0 = aus)">
            <NumberInput value={pres.interval} min={0} max={3600} onChange={(v) => setSettings({ ...settings, presentation: { ...pres, interval: v ?? 0 } })} />
          </Field>
          <Field label="Daten aktualisieren (Sekunden)">
            <NumberInput value={pres.refresh} min={5} max={3600} onChange={(v) => setSettings({ ...settings, presentation: { ...pres, refresh: v ?? 60 } })} />
          </Field>
          <Field label="Übergang">
            <Select
              value={pres.transition}
              onChange={(v) => setSettings({ ...settings, presentation: { ...pres, transition: v as any } })}
              options={[
                { value: 'fade', label: 'Überblenden' },
                { value: 'slide', label: 'Schieben' },
                { value: 'zoom', label: 'Zoom' },
                { value: 'none', label: 'Keiner' },
              ]}
            />
          </Field>
          <div className="flex items-end">
            <Switch checked={pres.showClock} onChange={(v) => setSettings({ ...settings, presentation: { ...pres, showClock: v } })} label="Uhr einblenden" />
          </div>
        </div>
      )}
    </Modal>
  )
}

export function PageSettingsModal({ open, onClose, page, onSave }: { open: boolean; onClose: () => void; page: Page; onSave: (patch: Partial<Page>) => Promise<void> }) {
  const [title, setTitle] = useState(page.title)
  const [hidden, setHidden] = useState(!!page.hidden)
  const [theme, setTheme] = useState<ThemeSpec>(page.settings?.theme || {})
  const [useTheme, setUseTheme] = useState(!!page.settings?.theme)
  useEffect(() => {
    if (open) {
      setTitle(page.title)
      setHidden(!!page.hidden)
      setTheme(page.settings?.theme || {})
      setUseTheme(!!page.settings?.theme)
    }
  }, [open, page])
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Seiteneinstellungen"
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              await onSave({ title, hidden, settings: { ...page.settings, theme: useTheme ? theme : undefined } })
              onClose()
            }}
          >
            Speichern
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Seitentitel">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Switch checked={hidden} onChange={setHidden} label="In der Navigation ausblenden" />
        <Switch checked={useTheme} onChange={setUseTheme} label="Eigenes Design für diese Seite" />
        {useTheme && <ThemeEditor value={theme} onChange={setTheme} />}
      </div>
    </Modal>
  )
}
