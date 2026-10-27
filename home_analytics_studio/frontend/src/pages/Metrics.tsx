import clsx from 'clsx'
import { AlertTriangle, Calculator, CheckCircle2, Code2, Copy, Pencil, Plus, Puzzle, Trash2, Wand2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api/client'
import type { Constant, Metric, SeriesResult, Source } from '../api/types'
import { EChart } from '../charts/EChart'
import RangePicker from '../components/RangePicker'
import { SingleSource } from '../components/SourcePicker'
import { Badge, Button, Card, Empty, Field, IconButton, Input, Modal, NumberInput, PageHeader, Select, Tabs, Textarea, confirmDialog, toast, useAsync } from '../components/ui'
import { useRole } from '../store/app'
import { useCatalog } from '../store/catalog'
import { INTERVALS, formatNumber, tickFormatter } from '../utils/format'

// ------------------------------------------------------------------ visual builder model

type OperandKind = 'entity' | 'metric' | 'constant' | 'number'
interface Operand {
  kind: OperandKind
  id?: string
  value?: number
  fn?: string // '' | MIN | MAX | AVG | LAST | DELTA | FIRST | COUNT | SUM(window) ...
  window?: string
}
interface Step {
  op: '+' | '-' | '*' | '/'
  operand: Operand
}
export interface BuilderState {
  first: Operand
  steps: Step[]
  wrap: '' | 'PERCENT' | 'ROUND' | 'ABS' | 'NONNEG' | 'AVG' | 'SUM' | 'MIN' | 'MAX' | 'MOVING_AVG' | 'CUMSUM' | 'CHANGE_PCT' | 'DIFFERENCE'
  wrapArg?: string
  condition?: { enabled: boolean; left: Operand; cmp: string; right: Operand; elseValue: number }
}

const ENTITY_FNS = [
  { value: '', label: 'Standard (Verbrauch bzw. Mittelwert)' },
  { value: 'MIN', label: 'Minimum im Abschnitt' },
  { value: 'MAX', label: 'Maximum im Abschnitt' },
  { value: 'LAST', label: 'Letzter Wert (Zählerstand)' },
  { value: 'FIRST', label: 'Erster Wert' },
  { value: 'DELTA', label: 'Differenz / Verbrauch' },
  { value: 'COUNT', label: 'Anzahl Messwerte' },
  { value: 'INTEGRAL', label: 'Zeitintegral (W → Wh)' },
  { value: 'AVG_W', label: 'Gleitender Mittelwert über …' },
  { value: 'SUM_W', label: 'Gleitende Summe über …' },
]

export function operandToFormula(o: Operand): string {
  let base = ''
  if (o.kind === 'number') return String(o.value ?? 0)
  if (o.kind === 'entity') base = o.id || '0'
  else base = o.id || '0'
  if (o.kind !== 'entity' || !o.fn) return base
  if (o.fn === 'AVG_W') return `AVG(${base}, ${o.window || '7d'})`
  if (o.fn === 'SUM_W') return `SUM(${base}, ${o.window || '7d'})`
  return `${o.fn}(${base})`
}

export function builderToFormula(b: BuilderState): string {
  let expr = operandToFormula(b.first)
  b.steps.forEach((s, i) => {
    const rhs = operandToFormula(s.operand)
    const needParens = (s.op === '*' || s.op === '/') && i >= 0 && b.steps.slice(0, i + 1).some((x, j) => j < i + 1 && (x.op === '+' || x.op === '-'))
    expr = needParens ? `(${expr}) ${s.op} ${rhs}` : `${expr} ${s.op} ${rhs}`
  })
  if (b.condition?.enabled) {
    expr = `IF(${operandToFormula(b.condition.left)} ${b.condition.cmp} ${operandToFormula(b.condition.right)}, ${expr}, ${b.condition.elseValue ?? 0})`
  }
  switch (b.wrap) {
    case '':
      return expr
    case 'PERCENT':
      return `(${expr}) * 100`
    case 'ROUND':
      return `ROUND(${expr}, ${b.wrapArg || 2})`
    case 'AVG':
    case 'SUM':
    case 'MIN':
    case 'MAX':
    case 'MOVING_AVG':
    case 'CHANGE_PCT':
    case 'DIFFERENCE':
      return b.wrapArg ? `${b.wrap}(${expr}, ${b.wrapArg})` : `${b.wrap}(${expr})`
    default:
      return `${b.wrap}(${expr})`
  }
}

const emptyBuilder = (): BuilderState => ({ first: { kind: 'entity' }, steps: [], wrap: '' })

function OperandEditor({ value, onChange }: { value: Operand; onChange: (o: Operand) => void }) {
  const { metrics, constants } = useCatalog()
  return (
    <div className="grid gap-2 md:grid-cols-[150px_1fr]">
      <Select
        value={value.kind}
        onChange={(k) => onChange({ kind: k as OperandKind })}
        options={[
          { value: 'entity', label: 'Entität' },
          { value: 'metric', label: 'Kennzahl' },
          { value: 'constant', label: 'Konstante' },
          { value: 'number', label: 'Zahl' },
        ]}
      />
      {value.kind === 'entity' && (
        <div className="grid gap-2 md:grid-cols-2">
          <SingleSource value={value.id ? ({ type: 'entity', id: value.id } as Source) : undefined} onChange={(s) => onChange({ ...value, id: s?.id })} placeholder="Entität wählen…" />
          <div className="flex gap-2">
            <Select value={value.fn || ''} onChange={(fn) => onChange({ ...value, fn })} options={ENTITY_FNS} />
            {(value.fn === 'AVG_W' || value.fn === 'SUM_W') && <Input className="w-20" value={value.window || '7d'} onChange={(e) => onChange({ ...value, window: e.target.value })} />}
          </div>
        </div>
      )}
      {value.kind === 'metric' && <Select value={value.id || ''} placeholder="Kennzahl wählen…" onChange={(id) => onChange({ ...value, id })} options={metrics.map((m) => ({ value: m.key, label: `${m.name} (${m.key})` }))} />}
      {value.kind === 'constant' && (
        <Select value={value.id || ''} placeholder="Konstante wählen…" onChange={(id) => onChange({ ...value, id })} options={constants.map((c) => ({ value: c.key, label: `${c.name || c.key} = ${c.value} ${c.unit || ''}` }))} />
      )}
      {value.kind === 'number' && <NumberInput value={value.value ?? 0} onChange={(v) => onChange({ ...value, value: v ?? 0 })} />}
    </div>
  )
}

function VisualBuilder({ value, onChange }: { value: BuilderState; onChange: (b: BuilderState) => void }) {
  const cond = value.condition || { enabled: false, left: { kind: 'entity' as OperandKind }, cmp: '>', right: { kind: 'number' as OperandKind, value: 0 }, elseValue: 0 }
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-line/50 bg-bg/40 p-3">
        <div className="label">Wert</div>
        <OperandEditor value={value.first} onChange={(o) => onChange({ ...value, first: o })} />
      </div>
      {value.steps.map((s, i) => (
        <div key={i} className="rounded-lg border border-line/50 bg-bg/40 p-3">
          <div className="mb-2 flex items-center gap-2">
            <Select
              className="w-44"
              value={s.op}
              onChange={(op) => onChange({ ...value, steps: value.steps.map((x, j) => (j === i ? { ...x, op: op as Step['op'] } : x)) })}
              options={[
                { value: '+', label: '+ plus' },
                { value: '-', label: '− minus' },
                { value: '*', label: '× multipliziert mit' },
                { value: '/', label: '÷ geteilt durch' },
              ]}
            />
            <IconButton className="ml-auto" title="Schritt entfernen" onClick={() => onChange({ ...value, steps: value.steps.filter((_, j) => j !== i) })}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
          <OperandEditor value={s.operand} onChange={(o) => onChange({ ...value, steps: value.steps.map((x, j) => (j === i ? { ...x, operand: o } : x)) })} />
        </div>
      ))}
      <Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => onChange({ ...value, steps: [...value.steps, { op: '*', operand: { kind: 'constant' } }] })}>
        Rechenschritt hinzufügen
      </Button>
      <div className="grid gap-3 rounded-lg border border-line/50 bg-bg/40 p-3 md:grid-cols-2">
        <Field label="Ergebnis umwandeln">
          <Select
            value={value.wrap}
            onChange={(w) => onChange({ ...value, wrap: w as BuilderState['wrap'], wrapArg: ['AVG', 'SUM', 'MIN', 'MAX', 'MOVING_AVG'].includes(w) ? value.wrapArg || '7d' : w === 'ROUND' ? '2' : undefined })}
            options={[
              { value: '', label: 'Keine' },
              { value: 'PERCENT', label: 'In Prozent (× 100)' },
              { value: 'ROUND', label: 'Runden' },
              { value: 'ABS', label: 'Betrag' },
              { value: 'NONNEG', label: 'Negative Werte → 0' },
              { value: 'AVG', label: 'Gleitender Durchschnitt (AVG)' },
              { value: 'SUM', label: 'Gleitende Summe (SUM)' },
              { value: 'MIN', label: 'Gleitendes Minimum' },
              { value: 'MAX', label: 'Gleitendes Maximum' },
              { value: 'MOVING_AVG', label: 'Gleitender Mittelwert (MOVING_AVG)' },
              { value: 'CUMSUM', label: 'Laufende Summe' },
              { value: 'CHANGE_PCT', label: 'Prozentänderung zum Vorabschnitt' },
              { value: 'DIFFERENCE', label: 'Differenz zum Vorabschnitt' },
            ]}
          />
        </Field>
        {value.wrapArg !== undefined && (
          <Field label={value.wrap === 'ROUND' ? 'Nachkommastellen' : 'Zeitraum (z. B. 7d, 24h, 4w)'}>
            <Input value={value.wrapArg} onChange={(e) => onChange({ ...value, wrapArg: e.target.value })} />
          </Field>
        )}
      </div>
      <div className="space-y-2 rounded-lg border border-line/50 bg-bg/40 p-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-[rgb(var(--c-accent))]" checked={cond.enabled} onChange={(e) => onChange({ ...value, condition: { ...cond, enabled: e.target.checked } })} />
          Bedingte Berechnung (nur wenn …, sonst fester Wert)
        </label>
        {cond.enabled && (
          <div className="space-y-2">
            <OperandEditor value={cond.left} onChange={(o) => onChange({ ...value, condition: { ...cond, left: o } })} />
            <Select className="w-32" value={cond.cmp} onChange={(c) => onChange({ ...value, condition: { ...cond, cmp: c } })} options={['>', '>=', '<', '<=', '==', '!='].map((x) => ({ value: x, label: x }))} />
            <OperandEditor value={cond.right} onChange={(o) => onChange({ ...value, condition: { ...cond, right: o } })} />
            <Field label="Sonst-Wert">
              <NumberInput value={cond.elseValue} onChange={(v) => onChange({ ...value, condition: { ...cond, elseValue: v ?? 0 } })} />
            </Field>
          </div>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ metric editor modal

interface Validation {
  ok: boolean
  error: { message: string; pos: number | null } | null
  unit: string | null
  warnings: string[]
  entities: string[]
  names: string[]
  time_dependent: boolean
}

const TEMPLATES: { label: string; name: string; key: string; formula: string; unit: string; hint: string }[] = [
  { label: 'Stromkosten', name: 'Stromkosten', key: 'stromkosten', formula: 'sensor.STROMZAEHLER * strompreis', unit: '€', hint: 'Zähler-Entität und Konstante „strompreis“ ersetzen' },
  { label: 'Heizkosten', name: 'Heizkosten', key: 'heizkosten', formula: 'sensor.HEIZENERGIE * energiepreis', unit: '€', hint: 'Heizenergie (kWh) × Energiepreis' },
  { label: 'Eigenverbrauchsquote', name: 'Eigenverbrauchsquote', key: 'eigenverbrauchsquote', formula: 'PERCENT(sensor.PV_ERTRAG - sensor.EINSPEISUNG, sensor.PV_ERTRAG)', unit: '%', hint: 'Eigenverbrauch / Solarproduktion × 100' },
  { label: 'Ø Temperatur 7 Tage', name: 'Durchschnittstemperatur 7 Tage', key: 'temp_avg_7d', formula: 'AVG(sensor.TEMPERATUR, 7d)', unit: '°C', hint: 'gleitender Mittelwert' },
  { label: 'Leistung → Energie', name: 'Energie aus Leistung', key: 'energie_aus_leistung', formula: 'INTEGRAL(sensor.LEISTUNG) / 1000', unit: 'kWh', hint: 'Integral einer W-Entität in kWh' },
  { label: 'Veränderung zur Vorwoche', name: 'Veränderung Vorwoche', key: 'aenderung_vorwoche', formula: 'CHANGE_PCT(sensor.ZAEHLER, 7d)', unit: '%', hint: 'Prozentänderung gegenüber 7 Tage vorher' },
]

function MetricEditor({ metric, onClose, onSaved }: { metric: Partial<Metric> | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(metric?.name || '')
  const [key, setKey] = useState(metric?.key || '')
  const [formula, setFormula] = useState(metric?.formula || '')
  const [unit, setUnit] = useState(metric?.unit || '')
  const [description, setDescription] = useState(metric?.description || '')
  const [aggregation, setAggregation] = useState(metric?.aggregation || 'auto')
  const [decimals, setDecimals] = useState<number | null>(metric?.decimals ?? 2)
  const [mode, setMode] = useState<'visual' | 'advanced'>(metric?.builder || !metric?.id ? 'visual' : 'advanced')
  const [builder, setBuilder] = useState<BuilderState>(metric?.builder || emptyBuilder())
  const [validation, setValidation] = useState<Validation | null>(null)
  const [range, setRange] = useState<any>('last_7d')
  const [interval, setInterval] = useState('auto')
  const [preview, setPreview] = useState<{ series?: SeriesResult; total?: { value: number | null } } | null>(null)
  const [busy, setBusy] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const { entities, constants, metrics, load } = useCatalog()
  const { data: functions } = useAsync(() => api.get<{ name: string; signature: string; description: string; category: string }[]>('metrics/functions'), [])

  useEffect(() => {
    load()
  }, [load])

  // visual builder drives the formula
  useEffect(() => {
    if (mode === 'visual') setFormula(builderToFormula(builder))
  }, [builder, mode])

  // auto key from name
  useEffect(() => {
    if (!metric?.id && name && (!key || key === slug(name.slice(0, -1)))) setKey(slug(name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  // live validation (debounced)
  useEffect(() => {
    if (!formula.trim()) {
      setValidation(null)
      return
    }
    const t = window.setTimeout(() => {
      api.post<Validation>('metrics/validate', { formula, key: metric?.key || key }).then(setValidation).catch(() => undefined)
    }, 350)
    return () => window.clearTimeout(t)
  }, [formula, key, metric?.key])

  const runPreview = async () => {
    try {
      const res = await api.post<any>('metrics/preview', { formula, range, interval, unit, aggregation, key: metric?.key || key })
      if (res.validation && !res.validation.ok) {
        setValidation(res.validation)
        setPreview(null)
        return
      }
      setPreview(res)
    } catch (e) {
      toast.error(e)
    }
  }

  const insert = (text: string) => {
    const ta = taRef.current
    if (!ta) {
      setFormula((f) => f + text)
      return
    }
    const s = ta.selectionStart
    const e = ta.selectionEnd
    const next = formula.slice(0, s) + text + formula.slice(e)
    setFormula(next)
    requestAnimationFrame(() => {
      ta.focus()
      ta.selectionStart = ta.selectionEnd = s + text.length
    })
  }

  const save = async () => {
    setBusy(true)
    try {
      const body = { name, key, formula, unit: unit || validation?.unit || null, description, aggregation, decimals: decimals ?? 2, builder: mode === 'visual' ? builder : null }
      if (metric?.id) await api.put(`metrics/${metric.id}`, body)
      else await api.post('metrics', body)
      toast.ok('Kennzahl gespeichert')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const tick = tickFormatter(preview?.series?.interval || '1h')
  const errPos = validation?.error?.pos

  return (
    <Modal
      open
      onClose={onClose}
      title={metric?.id ? `Kennzahl bearbeiten: ${metric.name}` : 'Neue Kennzahl'}
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button variant="primary" loading={busy} disabled={!validation?.ok || !name || !key} onClick={save}>
            Speichern
          </Button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Stromkosten" />
            </Field>
            <Field label="Schlüssel (für Formeln)" hint="Kleinbuchstaben, Ziffern, _">
              <Input value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} className="font-mono" />
            </Field>
          </div>
          {!metric?.id && (
            <div>
              <div className="label">Vorlagen</div>
              <div className="flex flex-wrap gap-2">
                {TEMPLATES.map((t) => (
                  <Button
                    key={t.key}
                    size="sm"
                    variant="ghost"
                    title={t.hint}
                    icon={<Wand2 className="h-3.5 w-3.5" />}
                    onClick={() => {
                      setName(t.name)
                      setKey(t.key)
                      setUnit(t.unit)
                      setMode('advanced')
                      setFormula(t.formula)
                    }}
                  >
                    {t.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <Tabs
            value={mode}
            onChange={(m) => {
              if (m === 'visual' && mode === 'advanced' && formula && formula !== builderToFormula(builder)) {
                confirmDialog('Visueller Builder', 'Die manuell bearbeitete Formel wird durch den Builder ersetzt. Fortfahren?').then((ok) => ok && setMode('visual'))
                return
              }
              setMode(m)
            }}
            tabs={[
              { value: 'visual', label: 'Visueller Formel-Builder', icon: <Puzzle className="h-4 w-4" /> },
              { value: 'advanced', label: 'Erweiterter Formel-Editor', icon: <Code2 className="h-4 w-4" /> },
            ]}
          />
          {mode === 'visual' ? (
            <>
              <VisualBuilder value={builder} onChange={setBuilder} />
              <Field label="Erzeugte Formel">
                <code className="block rounded-lg bg-bg/60 p-2 text-xs">{formula || '–'}</code>
              </Field>
            </>
          ) : (
            <div className="space-y-2">
              <Textarea ref={taRef} className={clsx('min-h-[120px]', validation && !validation.ok && 'border-bad')} value={formula} onChange={(e) => setFormula(e.target.value)} spellCheck={false} placeholder="z. B. sensor.stromzaehler * strompreis" />
              {errPos != null && validation && !validation.ok && (
                <pre className="overflow-x-auto rounded bg-bad/10 p-2 text-xs text-bad">
                  {formula}
                  {'\n'}
                  {' '.repeat(Math.max(0, errPos))}^
                </pre>
              )}
              <div className="flex flex-wrap gap-2">
                <InsertMenu label="Entität" items={entities.filter((e) => e.recorded || e.numeric).slice(0, 500).map((e) => ({ value: e.entity_id, label: `${e.name} (${e.entity_id})` }))} onPick={insert} />
                <InsertMenu label="Konstante" items={constants.map((c) => ({ value: c.key, label: `${c.key} = ${c.value} ${c.unit || ''}` }))} onPick={insert} />
                <InsertMenu label="Kennzahl" items={metrics.filter((m) => m.key !== metric?.key).map((m) => ({ value: m.key, label: m.name }))} onPick={insert} />
                <InsertMenu label="Funktion" items={(functions || []).map((f) => ({ value: `${f.name}(`, label: `${f.signature} – ${f.description}` }))} onPick={(v) => insert(v)} />
              </div>
            </div>
          )}
          <div className={clsx('rounded-lg border p-3 text-sm', !validation ? 'border-line/40 text-muted' : validation.ok ? 'border-ok/40 bg-ok/5' : 'border-bad/40 bg-bad/5')}>
            {!validation && 'Formel eingeben – sie wird automatisch geprüft.'}
            {validation && !validation.ok && (
              <span className="flex items-start gap-2 text-bad">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                {validation.error?.message}
              </span>
            )}
            {validation?.ok && (
              <div className="space-y-1">
                <span className="flex items-center gap-2 text-ok">
                  <CheckCircle2 className="h-4 w-4" /> Formel gültig
                  {validation.unit != null && validation.unit !== '' && <Badge tone="accent">Einheit: {validation.unit}</Badge>}
                  {validation.time_dependent && <Badge>zeitabhängig</Badge>}
                </span>
                {validation.warnings.map((w) => (
                  <div key={w} className="flex items-center gap-2 text-warn">
                    <AlertTriangle className="h-4 w-4" /> {w}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="Einheit" hint={validation?.unit ? `abgeleitet: ${validation.unit}` : undefined}>
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={validation?.unit || ''} />
            </Field>
            <Field label="Aggregation über Zeitraum" hint="Auto: Formel über den Gesamtzeitraum (korrekt für Quoten)">
              <Select
                value={aggregation}
                onChange={setAggregation}
                options={[
                  { value: 'auto', label: 'Automatisch' },
                  { value: 'sum', label: 'Summe' },
                  { value: 'mean', label: 'Durchschnitt' },
                  { value: 'last', label: 'Letzter Wert' },
                  { value: 'min', label: 'Minimum' },
                  { value: 'max', label: 'Maximum' },
                ]}
              />
            </Field>
            <Field label="Nachkommastellen">
              <NumberInput value={decimals} min={0} max={6} onChange={setDecimals} />
            </Field>
          </div>
          <Field label="Beschreibung">
            <Textarea className="min-h-[60px] font-sans" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <div className="space-y-4">
          <Card title="Vorschau (rückwirkend berechnet)" bodyClass="space-y-3 p-4">
            <RangePicker value={range} onChange={setRange} />
            <Select value={interval} onChange={setInterval} options={INTERVALS} />
            <Button variant="outline" className="w-full" disabled={!validation?.ok} onClick={runPreview}>
              Berechnen
            </Button>
            {preview?.series && (
              <>
                <div className="text-center">
                  <div className="text-xs text-muted">Wert im Zeitraum</div>
                  <div className="text-2xl font-semibold tabular-nums">
                    {formatNumber(preview.total?.value ?? null, { decimals: decimals ?? 2 })} {unit || validation?.unit}
                  </div>
                </div>
                <div className="h-48">
                  <EChart
                    option={{
                      grid: { left: 4, right: 4, top: 10, bottom: 4, containLabel: true },
                      tooltip: { trigger: 'axis' },
                      xAxis: { type: 'category', data: preview.series.ts, axisLabel: { formatter: (v: string) => tick(Number(v)), color: '#8b98b0', fontSize: 10 } },
                      yAxis: { type: 'value', scale: true, axisLabel: { color: '#8b98b0', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(120,130,160,0.2)' } } },
                      series: [{ type: 'bar', data: preview.series.values, itemStyle: { color: '#22d3ee', borderRadius: [3, 3, 0, 0] } }],
                    }}
                  />
                </div>
              </>
            )}
          </Card>
          <Card title="Kurzreferenz" bodyClass="p-4 text-xs text-muted space-y-1.5">
            <p><code>sensor.x</code> – Verbrauch (Zähler) bzw. Ø (Momentanwert) je Abschnitt</p>
            <p><code>strompreis</code> – Konstante oder andere Kennzahl</p>
            <p><code>AVG(x, 7d)</code>, <code>SUM(x, 30d)</code> – gleitend</p>
            <p><code>IF(a &gt; b, x, y)</code> – Bedingung</p>
            <p><code>PERCENT(a, b)</code>, <code>CHANGE_PCT(x, 7d)</code></p>
            <p>Division durch 0 und fehlende Werte ergeben „–“ statt eines Fehlers.</p>
          </Card>
        </div>
      </div>
    </Modal>
  )
}

function InsertMenu({ label, items, onPick }: { label: string; items: { value: string; label: string }[]; onPick: (v: string) => void }) {
  return (
    <select className="input w-auto py-1 text-xs" value="" onChange={(e) => e.target.value && onPick(e.target.value)}>
      <option value="">+ {label} einfügen…</option>
      {items.map((i) => (
        <option key={i.value + i.label} value={i.value}>
          {i.label}
        </option>
      ))}
    </select>
  )
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'k_$1')
    .slice(0, 60)
}

// ------------------------------------------------------------------ constants

function ConstantsCard() {
  const canEdit = useRole('editor')
  const { data, reload } = useAsync(() => api.get<Constant[]>('constants'), [])
  const reloadCatalog = useCatalog((s) => s.load)
  const [edit, setEdit] = useState<Partial<Constant> | null>(null)
  const save = async () => {
    try {
      await api.post('constants', edit)
      setEdit(null)
      reload()
      reloadCatalog(true)
      toast.ok('Konstante gespeichert')
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <Card
      title="Konstanten (Preise, Faktoren)"
      actions={canEdit && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ key: '', value: 0, unit: '', name: '' })}>Neu</Button>}
      bodyClass="p-0"
    >
      {!data?.length ? (
        <p className="p-5 text-sm text-muted">Noch keine Konstanten. Beispiel: <code>strompreis</code> = 0,32 €/kWh</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {data.map((c) => (
              <tr key={c.key} className="border-t border-line/30 first:border-t-0">
                <td className="px-5 py-2">
                  <div className="font-mono text-xs">{c.key}</div>
                  <div className="text-muted">{c.name}</div>
                </td>
                <td className="px-2 py-2 text-right font-semibold tabular-nums">
                  {formatNumber(c.value, { decimals: 4 }).replace(/0+$/, '').replace(/,$/, '')} <span className="text-xs text-muted">{c.unit}</span>
                </td>
                <td className="w-24 px-3 py-2 text-right">
                  {canEdit && (
                    <>
                      <IconButton title="Bearbeiten" onClick={() => setEdit(c)}><Pencil className="h-4 w-4" /></IconButton>
                      <IconButton
                        title="Löschen"
                        onClick={async () => {
                          if (!(await confirmDialog('Konstante löschen', `„${c.key}“ löschen?`, { danger: true }))) return
                          try {
                            await api.del(`constants/${c.key}`)
                            reload()
                          } catch (e) {
                            toast.error(e)
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
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Konstante" size="sm" footer={<Button variant="primary" onClick={save}>Speichern</Button>}>
        {edit && (
          <div className="space-y-3">
            <Field label="Schlüssel">
              <Input className="font-mono" value={edit.key || ''} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, key: e.target.value.toLowerCase() })} />
            </Field>
            <Field label="Bezeichnung">
              <Input value={edit.name || ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Wert">
                <NumberInput value={edit.value ?? 0} onChange={(v) => setEdit({ ...edit, value: v ?? 0 })} />
              </Field>
              <Field label="Einheit">
                <Input value={edit.unit || ''} placeholder="€/kWh" onChange={(e) => setEdit({ ...edit, unit: e.target.value })} />
              </Field>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  )
}

// ------------------------------------------------------------------ page

export default function MetricsPage() {
  const canEdit = useRole('editor')
  const { data, reload } = useAsync(() => api.get<Metric[]>('metrics'), [])
  const reloadCatalog = useCatalog((s) => s.load)
  const [editing, setEditing] = useState<Partial<Metric> | null>(null)
  const metrics = useMemo(() => data || [], [data])
  const refresh = () => {
    reload()
    reloadCatalog(true)
  }
  return (
    <div>
      <PageHeader
        icon={<Calculator className="h-5 w-5" />}
        title="Berechnete Kennzahlen"
        subtitle="Eigene Formeln aus Entitäten, Konstanten und anderen Kennzahlen – vollständig im Add-on berechnet"
        actions={canEdit && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({})}>Neue Kennzahl</Button>}
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card bodyClass="p-0">
          {!metrics.length ? (
            <Empty icon={<Calculator className="h-10 w-10" />} title="Noch keine Kennzahlen">
              Erstellen Sie z. B. „Stromkosten = Stromverbrauch × Strompreis“. Kennzahlen werden bei jeder Abfrage aus den gespeicherten Rohdaten berechnet – Formeländerungen wirken daher auch rückwirkend.
            </Empty>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="px-5 py-2">Kennzahl</th>
                  <th className="px-2 py-2">Formel</th>
                  <th className="px-2 py-2">Einheit</th>
                  <th className="w-32 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => (
                  <tr key={m.id} className="border-t border-line/30">
                    <td className="px-5 py-2.5">
                      <div className="font-medium">{m.name}</div>
                      <div className="font-mono text-xs text-muted">{m.key}</div>
                    </td>
                    <td className="max-w-[420px] px-2 py-2.5">
                      <code className="line-clamp-2 text-xs">{m.formula}</code>
                    </td>
                    <td className="px-2 py-2.5">{m.unit && <Badge tone="accent">{m.unit}</Badge>}</td>
                    <td className="px-3 py-2.5 text-right">
                      {canEdit && (
                        <>
                          <IconButton title="Bearbeiten" onClick={() => setEditing(m)}><Pencil className="h-4 w-4" /></IconButton>
                          <IconButton title="Duplizieren" onClick={() => setEditing({ ...m, id: undefined, key: `${m.key}_kopie`, name: `${m.name} (Kopie)` })}><Copy className="h-4 w-4" /></IconButton>
                          <IconButton
                            title="Löschen"
                            onClick={async () => {
                              if (!(await confirmDialog('Kennzahl löschen', `„${m.name}“ löschen? Widgets, die sie verwenden, zeigen danach einen Fehler.`, { danger: true }))) return
                              try {
                                await api.del(`metrics/${m.id}`)
                                refresh()
                              } catch (e) {
                                toast.error(e)
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
        </Card>
        <ConstantsCard />
      </div>
      {editing && <MetricEditor metric={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  )
}
