import { Plus, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../api/client'
import type { Source, Widget, WidgetStyle } from '../api/types'
import RangePicker from '../components/RangePicker'
import { SingleSource, SourceList } from '../components/SourcePicker'
import { Button, ColorInput, Field, IconButton, Input, NumberInput, Select, Slider, Switch, Tabs, Textarea, toast } from '../components/ui'
import { INTERVALS } from '../utils/format'
import { widgetDef } from './registry'
import type { FieldDef } from './types'

type Tab = 'data' | 'display' | 'format' | 'style'

function Thresholds({ value, onChange }: { value: { value: number; color: string; label?: string }[] | undefined; onChange: (v: any[]) => void }) {
  const list = value || []
  return (
    <div className="space-y-2">
      {list.map((t, i) => (
        <div key={i} className="grid grid-cols-[90px_1fr_auto] items-center gap-2">
          <NumberInput value={t.value} onChange={(v) => onChange(list.map((x, j) => (j === i ? { ...x, value: v ?? 0 } : x)))} />
          <ColorInput value={t.color} allowEmpty={false} onChange={(c) => onChange(list.map((x, j) => (j === i ? { ...x, color: c } : x)))} />
          <IconButton title="Entfernen" onClick={() => onChange(list.filter((_, j) => j !== i))}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => onChange([...list, { value: 0, color: '#fbbf24' }])}>
        Schwelle hinzufügen
      </Button>
    </div>
  )
}

function ImageField({ value, onChange }: { value: string | undefined; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const upload = async (f: File) => {
    const fd = new FormData()
    fd.append('file', f)
    setBusy(true)
    try {
      const res = await api.post<{ url: string }>('uploads', fd)
      onChange(res.url)
      toast.ok('Bild hochgeladen')
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-2">
      <Input value={value || ''} placeholder="https://… oder Upload" onChange={(e) => onChange(e.target.value)} />
      <input ref={ref} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      <Button size="sm" variant="secondary" loading={busy} icon={<Upload className="h-4 w-4" />} onClick={() => ref.current?.click()}>
        Bild hochladen
      </Button>
    </div>
  )
}

export function FieldInput({ f, value, onChange }: { f: FieldDef; value: any; onChange: (v: any) => void }) {
  switch (f.type) {
    case 'bool':
      return <Switch checked={!!value} onChange={onChange} label={f.label} />
    case 'number':
      return <NumberInput value={value} onChange={onChange} min={f.min} max={f.max} step={f.step} placeholder={f.placeholder} />
    case 'select':
      return <Select value={value ?? f.options?.[0]?.value} onChange={onChange} options={f.options || []} />
    case 'color':
      return <ColorInput value={value} onChange={onChange} />
    case 'textarea':
      return <Textarea value={value || ''} onChange={(e) => onChange(e.target.value)} />
    case 'markdown':
      return <Textarea className="min-h-[160px]" value={value || ''} onChange={(e) => onChange(e.target.value)} />
    case 'range':
      return <RangePicker value={value} onChange={onChange} />
    case 'interval':
      return <Select value={value || 'auto'} onChange={onChange} options={INTERVALS} />
    case 'thresholds':
      return <Thresholds value={value} onChange={onChange} />
    case 'image':
      return <ImageField value={value} onChange={onChange} />
    default:
      return <Input value={value ?? ''} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />
  }
}

export default function WidgetEditor({ widget, onChange }: { widget: Widget; onChange: (w: Widget) => void }) {
  const def = widgetDef(widget.type)
  const [tab, setTab] = useState<Tab>(def && def.sources !== 'none' ? 'data' : 'display')
  if (!def) return null
  const cfg = { ...def.defaults, ...widget.config }
  const set = (key: string, v: any) => onChange({ ...widget, config: { ...widget.config, [key]: v } })
  const patch = (p: Record<string, any>) => onChange({ ...widget, config: { ...widget.config, ...p } })
  const setStyle = (key: keyof WidgetStyle, v: any) => onChange({ ...widget, style: { ...(widget.style || {}), [key]: v === '' ? undefined : v } })
  const st = widget.style || {}
  const hasData = def.sources !== 'none'
  const tabs: { value: Tab; label: string }[] = [
    ...(hasData ? [{ value: 'data' as Tab, label: 'Daten' }] : []),
    { value: 'display', label: 'Darstellung' },
    ...(hasData ? [{ value: 'format' as Tab, label: 'Format' }] : []),
    { value: 'style', label: 'Stil' },
  ]
  const fieldVisible = (f: FieldDef) => !f.showIf || f.showIf(cfg)

  return (
    <div className="space-y-4">
      <Field label="Titel">
        <Input value={widget.title || ''} placeholder={def.label} onChange={(e) => onChange({ ...widget, title: e.target.value })} />
      </Field>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />

      {tab === 'data' && (
        <div className="space-y-4">
          {def.DataEditor && <def.DataEditor cfg={cfg} set={set} patch={patch} />}
          {(def.sources === 'single' || def.sources === 'multi' || def.sources === 'multi_slots') && (
            <Field label={def.sources === 'single' ? 'Datenquelle' : 'Datenquellen'}>
              <SourceList value={(cfg.sources as Source[]) || []} onChange={(v) => set('sources', v)} multi={def.sources !== 'single'} showStat={!!def.dataFields?.stat} />
            </Field>
          )}
          {(def.sources === 'slots' || def.sources === 'multi_slots') &&
            def.slots?.map((sl) => (
              <Field key={sl.key} label={sl.label} hint={sl.hint}>
                <SingleSource
                  value={cfg.slots?.[sl.key]}
                  defaultStat={sl.stat}
                  onChange={(s) => set('slots', { ...(cfg.slots || {}), [sl.key]: s })}
                />
              </Field>
            ))}
          {def.dataFields?.range && (
            <Field label="Zeitraum">
              <RangePicker value={cfg.range} onChange={(v) => set('range', v)} />
            </Field>
          )}
          {def.dataFields?.interval && (
            <Field label="Intervall (Aggregation)">
              <Select value={cfg.interval || 'auto'} onChange={(v) => set('interval', v)} options={INTERVALS} />
            </Field>
          )}
          <Switch checked={cfg.liveRefresh !== false} onChange={(v) => set('liveRefresh', v)} label="Sofort neu berechnen, wenn sich ein beteiligter Sensor ändert" />
          <Field label="Zusätzlich spätestens alle … Sekunden" hint="Live-Werte (Statistik „aktueller Zustand“) aktualisieren ohnehin sofort">
            <NumberInput value={cfg.refresh ?? 60} min={5} max={86400} onChange={(v) => set('refresh', v ?? 60)} />
          </Field>
        </div>
      )}

      {tab === 'display' && (
        <div className="space-y-3">
          {def.fields.filter(fieldVisible).map((f) =>
            f.type === 'bool' ? (
              <div key={f.key}>
                <FieldInput f={f} value={cfg[f.key]} onChange={(v) => set(f.key, v)} />
                {f.hint && <p className="ml-11 text-xs text-muted">{f.hint}</p>}
              </div>
            ) : (
              <Field key={f.key} label={f.label} hint={f.hint}>
                <FieldInput f={f} value={cfg[f.key]} onChange={(v) => set(f.key, v)} />
              </Field>
            ),
          )}
          <Switch checked={cfg.animation !== false} onChange={(v) => set('animation', v)} label="Animationen" />
          {!def.fields.length && <p className="text-sm text-muted">Keine weiteren Optionen.</p>}
        </div>
      )}

      {tab === 'format' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Einheit" hint="leer = automatisch, „-“ = ausblenden">
            <Input value={cfg.unit || ''} onChange={(e) => set('unit', e.target.value)} />
          </Field>
          <Field label="Nachkommastellen" hint="leer = automatisch">
            <NumberInput value={cfg.decimals === '' ? null : cfg.decimals} min={0} max={6} onChange={(v) => set('decimals', v)} />
          </Field>
          <Field label="Präfix">
            <Input value={cfg.prefix || ''} onChange={(e) => set('prefix', e.target.value)} />
          </Field>
          <Field label="Suffix">
            <Input value={cfg.suffix || ''} onChange={(e) => set('suffix', e.target.value)} />
          </Field>
          <div className="col-span-2 flex flex-wrap gap-4">
            <Switch checked={cfg.thousands !== false} onChange={(v) => set('thousands', v)} label="Tausendertrennzeichen" />
            <Switch checked={!!cfg.compact} onChange={(v) => set('compact', v)} label="Kompakt (1,2 Tsd.)" />
          </div>
          <Field label="Farbpalette (überschreibt Theme)" className="col-span-2">
            <div className="space-y-2">
              {((cfg.colors as string[]) || []).map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <ColorInput value={c} allowEmpty={false} onChange={(v) => set('colors', (cfg.colors as string[]).map((x, j) => (j === i ? v : x)))} />
                  <IconButton title="Entfernen" onClick={() => set('colors', (cfg.colors as string[]).filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              ))}
              <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => set('colors', [...((cfg.colors as string[]) || []), '#22d3ee'])}>
                Farbe hinzufügen
              </Button>
            </div>
          </Field>
        </div>
      )}

      {tab === 'style' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4">
            <Switch checked={!!st.hideTitle} onChange={(v) => setStyle('hideTitle', v)} label="Titel ausblenden" />
            <Switch checked={st.background === 'transparent'} onChange={(v) => setStyle('background', v ? 'transparent' : undefined)} label="Ohne Kartenhintergrund" />
          </div>
          {st.background !== 'transparent' && (
            <Field label="Hintergrundfarbe">
              <ColorInput value={st.background} onChange={(v) => setStyle('background', v)} />
            </Field>
          )}
          <Field label={`Deckkraft Hintergrund (${st.opacity != null ? Math.round(st.opacity * 100) + ' %' : 'Theme'})`}>
            <Slider value={st.opacity ?? 0.9} onChange={(v) => setStyle('opacity', v)} format={(v) => `${Math.round(v * 100)} %`} />
          </Field>
          <Field label="Weichzeichner (Glas-Effekt, px)">
            <Slider value={st.blur ?? 0} min={0} max={40} step={1} onChange={(v) => setStyle('blur', v)} format={(v) => `${v}px`} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Rahmenfarbe">
              <ColorInput value={st.borderColor} onChange={(v) => setStyle('borderColor', v)} />
            </Field>
            <Field label="Rahmenbreite (px)">
              <NumberInput value={st.borderWidth} min={0} max={10} onChange={(v) => setStyle('borderWidth', v ?? undefined)} placeholder="Theme" />
            </Field>
            <Field label="Eckenradius (px)">
              <NumberInput value={st.radius} min={0} max={60} onChange={(v) => setStyle('radius', v ?? undefined)} placeholder="Theme" />
            </Field>
            <Field label="Innenabstand (px)">
              <NumberInput value={st.padding} min={0} max={60} onChange={(v) => setStyle('padding', v ?? undefined)} placeholder="14" />
            </Field>
            <Field label="Schatten">
              <Select
                value={st.shadow || 'theme'}
                onChange={(v) => setStyle('shadow', v)}
                options={[
                  { value: 'theme', label: 'Theme' },
                  { value: 'none', label: 'Keiner' },
                  { value: 'sm', label: 'Leicht' },
                  { value: 'md', label: 'Mittel' },
                  { value: 'lg', label: 'Stark' },
                  { value: 'glow', label: 'Leuchten' },
                ]}
              />
            </Field>
            <Field label="Textfarbe">
              <ColorInput value={st.textColor} onChange={(v) => setStyle('textColor', v)} />
            </Field>
            <Field label="Titel-Ausrichtung">
              <Select
                value={st.titleAlign || 'left'}
                onChange={(v) => setStyle('titleAlign', v)}
                options={[
                  { value: 'left', label: 'Links' },
                  { value: 'center', label: 'Mitte' },
                  { value: 'right', label: 'Rechts' },
                ]}
              />
            </Field>
            <Field label="Titelgröße (px)">
              <NumberInput value={st.titleSize} min={8} max={40} onChange={(v) => setStyle('titleSize', v ?? undefined)} placeholder="13" />
            </Field>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onChange({ ...widget, style: {} })}>
            Stil zurücksetzen
          </Button>
        </div>
      )}
    </div>
  )
}
