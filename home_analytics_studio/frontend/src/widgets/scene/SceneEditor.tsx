import { ChevronDown, ChevronRight, Code2, Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Source } from '../../api/types'
import { SingleSource } from '../../components/SourcePicker'
import { Button, ColorInput, Field, IconButton, Input, NumberInput, Select, Switch, Textarea } from '../../components/ui'
import { useThemeTokens } from '../../theme/context'
import { uid } from '../../utils/format'
import { useWidgetData } from '../useWidgetData'
import { KEY_RE, TEMPLATE_OPTIONS, sceneCode, sceneRequests, sceneVars, type SceneLabel, type SceneVar, type VarFormat } from './engine'
import { exprError } from './expr'
import { SceneFrame, sceneRangeLabel, useSceneValues } from './SceneWidget'
import { templateById } from './templates'

const FORMAT_OPTIONS: { value: VarFormat; label: string }[] = [
  { value: 'number', label: 'Zahl (Einheit vom Sensor)' },
  { value: 'power', label: 'Leistung (W / kW)' },
  { value: 'energy', label: 'Energie (kWh)' },
  { value: 'temp', label: 'Temperatur (°C)' },
  { value: 'percent', label: 'Prozent' },
  { value: 'text', label: 'Text (Zustand, z. B. Betriebsart)' },
]

export interface DataEditorProps {
  cfg: Record<string, any>
  set: (key: string, v: any) => void
  patch: (p: Record<string, any>) => void
}

function Preview({ cfg, onMove }: { cfg: Record<string, any>; onMove: (id: string, x: number, y: number) => void }) {
  const theme = useThemeTokens()
  const code = sceneCode(cfg)
  const { results } = useWidgetData(sceneRequests(cfg), 60)
  const vars = useSceneValues(cfg, results)
  return (
    <div className="space-y-1">
      <div className="relative w-full overflow-hidden rounded-lg border border-line/50 bg-bg/40" style={{ paddingTop: `${(code.h / code.w) * 100}%` }}>
        <div className="absolute left-0 top-0 h-full w-full">
          <SceneFrame code={code} vars={vars} labels={cfg.labels || []} anim={cfg.animation !== false && theme.animations} range={sceneRangeLabel(cfg)} edit onLabelMove={onMove} />
        </div>
      </div>
      <p className="text-xs text-muted">Vorschau mit Live-Werten. Gestrichelte „freie Werte“ lassen sich hier mit Maus oder Finger verschieben.</p>
    </div>
  )
}

function FineTune({ v, onChange }: { v: Partial<SceneVar>; onChange: (p: Partial<SceneVar>) => void }) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg border border-line/40 p-2">
      <Field label="Animation: Wert bei 0 %">
        <NumberInput value={v.min ?? null} onChange={(x) => onChange({ min: x ?? undefined })} placeholder="Standard" />
      </Field>
      <Field label="Animation: Wert bei 100 %">
        <NumberInput value={v.max ?? null} onChange={(x) => onChange({ max: x ?? undefined })} placeholder="Standard" />
      </Field>
      <Field label="Aktiv ab (Betrag)" hint="steuert Klasse …-an">
        <NumberInput value={v.on ?? null} onChange={(x) => onChange({ on: x ?? undefined })} placeholder="Standard" />
      </Field>
      <Field label="Nachkommastellen">
        <NumberInput value={v.decimals ?? null} min={0} max={6} onChange={(x) => onChange({ decimals: x })} placeholder="auto" />
      </Field>
      <Field label="Einheit" hint="leer = automatisch, „-“ = keine">
        <Input value={v.unit || ''} onChange={(e) => onChange({ unit: e.target.value || undefined })} />
      </Field>
      <div className="flex items-end pb-2">
        <Switch checked={!!v.invert} onChange={(x) => onChange({ invert: x || undefined })} label="Vorzeichen umkehren" />
      </div>
    </div>
  )
}

function TemplateVar({ def, bind, onChange }: { def: SceneVar; bind: Partial<SceneVar>; onChange: (b: Partial<SceneVar>) => void }) {
  const [open, setOpen] = useState(false)
  const merged = { ...def, ...Object.fromEntries(Object.entries(bind).filter(([, x]) => x !== undefined && x !== null && x !== '')) }
  return (
    <Field label={def.label} hint={def.hint}>
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <SingleSource
            value={bind.source}
            defaultStat={def.stat}
            placeholder={def.expr ? 'Berechnet' : 'Nicht gesetzt'}
            onChange={(s) => onChange({ ...bind, source: s })}
          />
        </div>
        <IconButton title="Feineinstellung" onClick={() => setOpen((o) => !o)}>
          <SlidersHorizontal className="h-4 w-4" />
        </IconButton>
      </div>
      {open && <FineTune v={merged} onChange={(p) => onChange({ ...bind, ...p })} />}
    </Field>
  )
}

function Collapsible({ title, children, defaultOpen }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <div className="rounded-lg border border-line/40">
      <button className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-sm font-medium" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {title}
      </button>
      {open && <div className="space-y-3 border-t border-line/40 p-2.5">{children}</div>}
    </div>
  )
}

function CustomVar({ v, onChange, onRemove, dup }: { v: SceneVar; onChange: (v: SceneVar) => void; onRemove: () => void; dup: boolean }) {
  const [open, setOpen] = useState(false)
  const mode = v.source ? 'source' : v.expr != null ? 'expr' : 'source'
  const keyErr = !KEY_RE.test(v.key) ? 'nur a–z, 0–9, _ (beginnt mit Buchstabe)' : dup ? 'Name doppelt' : null
  const err = mode === 'expr' && v.expr ? exprError(v.expr) : null
  return (
    <div className="space-y-2 rounded-lg border border-line/50 bg-bg/40 p-2">
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
        <Field label="Name im Code" hint={keyErr ? <span className="text-bad">{keyErr}</span> : undefined}>
          <Input className="font-mono" value={v.key} onChange={(e) => onChange({ ...v, key: e.target.value.trim() })} />
        </Field>
        <Field label="Bezeichnung">
          <Input value={v.label} onChange={(e) => onChange({ ...v, label: e.target.value })} />
        </Field>
        <IconButton title="Entfernen" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={mode}
          onChange={(m) => onChange(m === 'expr' ? { ...v, source: undefined, expr: v.expr || '' } : { ...v, expr: undefined })}
          options={[
            { value: 'source', label: 'Sensor / Kennzahl' },
            { value: 'expr', label: 'Berechnet aus anderen Werten' },
          ]}
        />
        <Select value={v.format || 'number'} onChange={(f) => onChange({ ...v, format: f as VarFormat })} options={FORMAT_OPTIONS} />
      </div>
      {mode === 'source' ? (
        <SingleSource value={v.source} defaultStat="current" onChange={(s) => onChange({ ...v, source: s as Source | undefined })} />
      ) : (
        <Field label="Berechnung" hint={err ? <span className="text-bad">{err}</span> : 'z. B. heat / power · if(a > 0, a, null) · min, max, abs, round, clamp, coalesce'}>
          <Input className="font-mono" value={v.expr || ''} onChange={(e) => onChange({ ...v, expr: e.target.value })} />
        </Field>
      )}
      <button className="text-xs text-muted underline" onClick={() => setOpen((o) => !o)}>
        {open ? 'Feineinstellung ausblenden' : 'Feineinstellung'}
      </button>
      {open && <FineTune v={v} onChange={(p) => onChange({ ...v, ...p })} />}
    </div>
  )
}

const HELP = (
  <div className="space-y-2 text-xs leading-relaxed text-muted">
    <p>
      Die Szene ist eine feste Bühne (Breite × Höhe in px), die automatisch auf die Kachelgröße skaliert wird. Werte einbauen:
    </p>
    <ul className="list-disc space-y-1 pl-4">
      <li>
        <code>{'{{name}}'}</code> im Text oder <code>{'<span data-value="name"></span>'}</code> → Wert mit Einheit; <code>{'{{name.number}}'}</code> / <code>data-number</code> → nur Zahl
      </li>
      <li>
        CSS-Variablen: <code>var(--name)</code> = 0…1 (zwischen Min und Max), <code>--name-pct</code>, <code>--name-dur</code> (2,6 s → 0,4 s je höher der Wert),{' '}
        <code>--name-play</code> (running/paused) – z. B. <code>animation-duration: var(--pv-dur)</code>
      </li>
      <li>
        Klassen am <code>html</code>-Element: <code>has-name</code> (Wert vorhanden), <code>name-an</code> (aktiv), <code>name-neg</code> (negativ) – z. B.{' '}
        <code>html.pumpe-an .rad {'{…}'}</code>
      </li>
      <li>
        <code>data-show-if="pv &gt; 100"</code> zeigt ein Element nur bei erfüllter Bedingung, <code>data-class-if="warm: temp &gt;= 21"</code> setzt eine Klasse
      </li>
      <li>
        Theme-Farben: <code>var(--text)</code>, <code>--muted</code>, <code>--accent</code>, <code>--chip-bg</code>, <code>--line</code>, <code>--wall</code>; <code>{'<span data-range></span>'}</code> = gewählter Zeitraum
      </li>
    </ul>
    <p>
      Sicherheit: Der Code läuft abgeschottet (eigener Sandbox-Ursprung, keine Netzwerkzugriffe, kein Zugriff auf Anmeldung, Home Assistant oder die Add-on-API). Er sieht nur die hier
      zugeordneten Werte. JavaScript ist standardmäßig blockiert; wenn erlaubt, erhält es die Werte über <code>window.HAS</code> und das Ereignis <code>has:values</code>.
    </p>
  </div>
)

export default function SceneEditor({ cfg, set, patch }: DataEditorProps) {
  const isCustom = cfg.template === 'custom' || !templateById(cfg.template)
  const tpl = templateById(cfg.template)
  const custom = cfg.custom || { html: '', css: '', w: 960, h: 540, vars: [] }
  const setCustom = (p: Record<string, any>) => set('custom', { ...custom, ...p })
  const vars: SceneVar[] = custom.vars || []
  const labels: SceneLabel[] = cfg.labels || []
  const setLabels = (l: SceneLabel[]) => set('labels', l)
  const bind: Record<string, Partial<SceneVar>> = cfg.bind || {}

  const toCustom = () => {
    if (!tpl) return
    const effective = sceneVars({ ...cfg, labels: [] }).map(({ hint: _h, advanced: _a, ...v }) => v)
    patch({ template: 'custom', custom: { html: tpl.html, css: tpl.css, w: tpl.w, h: tpl.h, vars: effective, allowJs: false } })
  }

  return (
    <div className="space-y-4">
      <Preview cfg={cfg} onMove={(id, x, y) => setLabels(labels.map((l) => (l.id === id ? { ...l, x, y } : l)))} />

      <Field label="Szene">
        <Select value={isCustom ? 'custom' : cfg.template} onChange={(v) => patch({ template: v })} options={TEMPLATE_OPTIONS} />
      </Field>

      {tpl && (
        <>
          <p className="text-xs text-muted">{tpl.description}. Nicht zugeordnete Teile (z. B. Batterie) werden ausgeblendet.</p>
          {tpl.vars
            .filter((v) => !v.advanced)
            .map((v) => (
              <TemplateVar key={v.key} def={v} bind={bind[v.key] || {}} onChange={(b) => set('bind', { ...bind, [v.key]: b })} />
            ))}
          <Collapsible title="Weitere Zuordnungen">
            {tpl.vars
              .filter((v) => v.advanced)
              .map((v) => (
                <TemplateVar key={v.key} def={v} bind={bind[v.key] || {}} onChange={(b) => set('bind', { ...bind, [v.key]: b })} />
              ))}
          </Collapsible>
          <Button size="sm" variant="ghost" icon={<Code2 className="h-4 w-4" />} onClick={toCustom}>
            Als eigenen Code bearbeiten (Kopie)
          </Button>
        </>
      )}

      {isCustom && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Bühne Breite (px)">
              <NumberInput value={custom.w ?? 960} min={100} max={4000} onChange={(v) => setCustom({ w: v ?? 960 })} />
            </Field>
            <Field label="Bühne Höhe (px)">
              <NumberInput value={custom.h ?? 540} min={100} max={4000} onChange={(v) => setCustom({ h: v ?? 540 })} />
            </Field>
          </div>
          <Field label="HTML / SVG">
            <Textarea className="min-h-[220px] font-mono text-xs" spellCheck={false} value={custom.html || ''} onChange={(e) => setCustom({ html: e.target.value })} />
          </Field>
          <Field label="CSS">
            <Textarea className="min-h-[160px] font-mono text-xs" spellCheck={false} value={custom.css || ''} onChange={(e) => setCustom({ css: e.target.value })} />
          </Field>
          <div>
            <Switch checked={!!custom.allowJs} onChange={(v) => setCustom({ allowJs: v })} label="Eigenes JavaScript erlauben" />
            <p className="ml-11 text-xs text-muted">bleibt abgeschottet und ohne Netzwerkzugriff; für reine Animationen nicht nötig</p>
          </div>
          <Field label="Werte (Variablen)">
            <div className="space-y-2">
              {vars.map((v, i) => (
                <CustomVar
                  key={i}
                  v={v}
                  dup={vars.some((o, j) => j !== i && o.key === v.key)}
                  onChange={(nv) => setCustom({ vars: vars.map((o, j) => (j === i ? nv : o)) })}
                  onRemove={() => setCustom({ vars: vars.filter((_, j) => j !== i) })}
                />
              ))}
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => setCustom({ vars: [...vars, { key: `wert${vars.length + 1}`, label: '', format: 'number' }] })}
              >
                Wert hinzufügen
              </Button>
            </div>
          </Field>
          <Collapsible title="Hilfe: Werte und Animationen im Code">{HELP}</Collapsible>
        </>
      )}

      <Field label="Freie Werte auf der Szene" hint="z. B. ein zusätzlicher Sensor an einer beliebigen Stelle – in der Vorschau verschieben">
        <div className="space-y-2">
          {labels.map((l) => (
            <div key={l.id} className="space-y-2 rounded-lg border border-line/50 bg-bg/40 p-2">
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Input value={l.title || ''} placeholder="Beschriftung" onChange={(e) => setLabels(labels.map((o) => (o.id === l.id ? { ...o, title: e.target.value } : o)))} />
                <IconButton title="Entfernen" onClick={() => setLabels(labels.filter((o) => o.id !== l.id))}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
              <SingleSource value={l.source} defaultStat="current" onChange={(s) => setLabels(labels.map((o) => (o.id === l.id ? { ...o, source: s } : o)))} />
              <div className="grid grid-cols-3 gap-2">
                <Select value={l.format || 'number'} onChange={(f) => setLabels(labels.map((o) => (o.id === l.id ? { ...o, format: f as VarFormat } : o)))} options={FORMAT_OPTIONS} />
                <NumberInput value={l.size ?? 26} min={8} max={120} onChange={(v) => setLabels(labels.map((o) => (o.id === l.id ? { ...o, size: v ?? 26 } : o)))} />
                <ColorInput value={l.color} onChange={(c) => setLabels(labels.map((o) => (o.id === l.id ? { ...o, color: c || undefined } : o)))} />
              </div>
            </div>
          ))}
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            icon={<Plus className="h-4 w-4" />}
            onClick={() => setLabels([...labels, { id: uid('l'), title: 'Wert', x: 0.5, y: 0.5, format: 'number' }])}
          >
            Freien Wert hinzufügen
          </Button>
        </div>
      </Field>
    </div>
  )
}
