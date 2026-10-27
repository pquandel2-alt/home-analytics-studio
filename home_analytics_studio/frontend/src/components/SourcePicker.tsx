import clsx from 'clsx'
import { ArrowDown, ArrowUp, Calculator, Database, FunctionSquare, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Source, Stat } from '../api/types'
import { useCatalog } from '../store/catalog'
import { Badge, Button, ColorInput, Field, IconButton, Input, Modal, Select, Switch, Tabs, Textarea } from './ui'

export const STAT_OPTIONS: { value: Stat; label: string }[] = [
  { value: 'auto', label: 'Automatisch (Verbrauch bzw. Mittelwert)' },
  { value: 'current', label: 'Aktueller Zustand (live)' },
  { value: 'mean', label: 'Mittelwert (zeitgewichtet)' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
  { value: 'delta', label: 'Verbrauch / Differenz' },
  { value: 'last', label: 'Letzter Wert (z. B. Zählerstand)' },
  { value: 'first', label: 'Erster Wert' },
  { value: 'count', label: 'Anzahl Messwerte' },
  { value: 'coverage', label: 'Datenabdeckung (0–1)' },
]

export function PickerModal({ open, onClose, onPick, multi }: { open: boolean; onClose: () => void; onPick: (s: Source[]) => void; multi?: boolean }) {
  const { entities, metrics, load, loading } = useCatalog()
  const [tab, setTab] = useState<'entity' | 'metric' | 'formula'>('entity')
  const [q, setQ] = useState('')
  const [onlyRecorded, setOnlyRecorded] = useState(false)
  const [onlyNumeric, setOnlyNumeric] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [formula, setFormula] = useState('')
  const [formulaName, setFormulaName] = useState('')

  useEffect(() => {
    if (open) {
      load()
      setSelected([])
    }
  }, [open, load])

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return entities
      .filter((e) => (!onlyRecorded || e.recorded) && (!onlyNumeric || e.numeric || e.recorded))
      .filter((e) => terms.every((t) => `${e.entity_id} ${e.name} ${e.area || ''} ${e.device_class || ''}`.toLowerCase().includes(t)))
      .slice(0, 300)
  }, [entities, q, onlyRecorded, onlyNumeric])

  const toggle = (id: string) => {
    if (!multi) {
      onPick([{ type: tab === 'metric' ? 'metric' : 'entity', id }])
      onClose()
      return
    }
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Datenquelle wählen"
      size="lg"
      footer={
        tab === 'formula' ? (
          <Button
            variant="primary"
            disabled={!formula.trim()}
            onClick={() => {
              onPick([{ type: 'formula', id: `formula_${Date.now().toString(36)}`, formula, label: formulaName || 'Formel' }])
              onClose()
            }}
          >
            Formel übernehmen
          </Button>
        ) : multi ? (
          <Button
            variant="primary"
            disabled={!selected.length}
            onClick={() => {
              onPick(selected.map((id) => ({ type: tab === 'metric' ? 'metric' : 'entity', id })))
              onClose()
            }}
          >
            {selected.length} übernehmen
          </Button>
        ) : undefined
      }
    >
      <Tabs
        value={tab}
        onChange={(t) => {
          setTab(t)
          setSelected([])
        }}
        className="mb-4"
        tabs={[
          { value: 'entity', label: 'Entitäten', icon: <Database className="h-4 w-4" /> },
          { value: 'metric', label: 'Kennzahlen', icon: <Calculator className="h-4 w-4" /> },
          { value: 'formula', label: 'Ad-hoc-Formel', icon: <FunctionSquare className="h-4 w-4" /> },
        ]}
      />
      {tab === 'entity' && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
              <Input autoFocus className="pl-9" placeholder="Suchen (Name, ID, Bereich, Geräteklasse)…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Switch checked={onlyRecorded} onChange={setOnlyRecorded} label="Nur aufgezeichnete" />
            <Switch checked={onlyNumeric} onChange={setOnlyNumeric} label="Nur numerische" />
          </div>
          <div className="max-h-[50vh] divide-y divide-line/30 overflow-y-auto rounded-lg border border-line/40">
            {loading && !entities.length && <div className="p-4 text-sm text-muted">Lade Entitäten…</div>}
            {filtered.map((e) => (
              <button
                key={e.entity_id}
                onClick={() => toggle(e.entity_id)}
                className={clsx('flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-fg/5', selected.includes(e.entity_id) && 'bg-accent/10')}
              >
                {multi && <input type="checkbox" readOnly checked={selected.includes(e.entity_id)} className="accent-[rgb(var(--c-accent))]" />}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{e.name}</div>
                  <div className="truncate font-mono text-xs text-muted">{e.entity_id}</div>
                </div>
                {e.area && <Badge>{e.area}</Badge>}
                {e.recorded && <Badge tone="ok">aufgezeichnet</Badge>}
                <span className="w-24 truncate text-right text-xs tabular-nums text-muted">
                  {e.state} {e.unit || ''}
                </span>
              </button>
            ))}
            {!loading && !filtered.length && <div className="p-4 text-sm text-muted">Keine passenden Entitäten.</div>}
          </div>
          <p className="mt-2 text-xs text-muted">
            Nicht aufgezeichnete Entitäten werden live angezeigt; Verläufe kommen dann aus der Home-Assistant-Historie (max. 10 Tage).
          </p>
        </>
      )}
      {tab === 'metric' && (
        <div className="max-h-[55vh] divide-y divide-line/30 overflow-y-auto rounded-lg border border-line/40">
          {metrics.map((m) => (
            <button key={m.key} onClick={() => toggle(m.key)} className={clsx('flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-fg/5', selected.includes(m.key) && 'bg-accent/10')}>
              {multi && <input type="checkbox" readOnly checked={selected.includes(m.key)} className="accent-[rgb(var(--c-accent))]" />}
              <div className="min-w-0 flex-1">
                <div className="font-medium">{m.name}</div>
                <div className="truncate font-mono text-xs text-muted">{m.formula}</div>
              </div>
              {m.unit && <Badge tone="accent">{m.unit}</Badge>}
            </button>
          ))}
          {!metrics.length && <div className="p-4 text-sm text-muted">Noch keine Kennzahlen angelegt (Menü „Kennzahlen“).</div>}
        </div>
      )}
      {tab === 'formula' && (
        <div className="space-y-3">
          <Field label="Name">
            <Input value={formulaName} onChange={(e) => setFormulaName(e.target.value)} placeholder="z. B. Stromkosten heute" />
          </Field>
          <Field label="Formel" hint="Gleiche Syntax wie im Kennzahlen-Editor, z. B. sensor.strom_kwh * strompreis">
            <Textarea value={formula} onChange={(e) => setFormula(e.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  )
}

export function sourceTitle(s: Source): string {
  if (s.label) return s.label
  if (s.type === 'formula') return 'Formel'
  if (s.type === 'metric') return useCatalog.getState().metrics.find((m) => m.key === s.id)?.name || s.id
  return useCatalog.getState().entities.find((e) => e.entity_id === s.id)?.name || s.id
}

function SourceRow({ s, onChange, onRemove, onUp, onDown, showStat }: { s: Source; onChange: (s: Source) => void; onRemove: () => void; onUp?: () => void; onDown?: () => void; showStat?: boolean }) {
  useCatalog((st) => st.loaded)
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-lg border border-line/50 bg-bg/40 p-2">
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: s.color || 'rgb(var(--c-accent))' }} />
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((o) => !o)}>
          <div className="truncate text-sm font-medium">{sourceTitle(s)}</div>
          <div className="truncate font-mono text-[11px] text-muted">{s.type === 'formula' ? s.formula : `${s.type === 'metric' ? 'Kennzahl: ' : ''}${s.id}`}</div>
        </button>
        {onUp && (
          <IconButton title="Nach oben" onClick={onUp}>
            <ArrowUp className="h-3.5 w-3.5" />
          </IconButton>
        )}
        {onDown && (
          <IconButton title="Nach unten" onClick={onDown}>
            <ArrowDown className="h-3.5 w-3.5" />
          </IconButton>
        )}
        <IconButton title="Entfernen" onClick={onRemove}>
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {open && (
        <div className="mt-2 grid gap-2 border-t border-line/40 pt-2">
          <Field label="Beschriftung">
            <Input value={s.label || ''} placeholder={sourceTitle({ ...s, label: undefined })} onChange={(e) => onChange({ ...s, label: e.target.value || undefined })} />
          </Field>
          {showStat && s.type === 'entity' && (
            <Field label="Statistik">
              <Select value={s.stat || 'auto'} onChange={(v) => onChange({ ...s, stat: v as Stat })} options={STAT_OPTIONS} />
            </Field>
          )}
          {s.type === 'formula' && (
            <Field label="Formel">
              <Textarea value={s.formula || ''} onChange={(e) => onChange({ ...s, formula: e.target.value })} />
            </Field>
          )}
          <Field label="Farbe">
            <ColorInput value={s.color} onChange={(c) => onChange({ ...s, color: c || undefined })} />
          </Field>
        </div>
      )}
    </div>
  )
}

export function SourceList({ value, onChange, multi, showStat = true, max }: { value: Source[]; onChange: (s: Source[]) => void; multi: boolean; showStat?: boolean; max?: number }) {
  const [open, setOpen] = useState(false)
  const list = value || []
  const move = (i: number, d: number) => {
    const next = [...list]
    const [x] = next.splice(i, 1)
    next.splice(i + d, 0, x)
    onChange(next)
  }
  return (
    <div className="space-y-2">
      {list.map((s, i) => (
        <SourceRow
          key={`${s.type}:${s.id}:${i}`}
          s={s}
          showStat={showStat}
          onChange={(ns) => onChange(list.map((x, j) => (j === i ? ns : x)))}
          onRemove={() => onChange(list.filter((_, j) => j !== i))}
          onUp={multi && i > 0 ? () => move(i, -1) : undefined}
          onDown={multi && i < list.length - 1 ? () => move(i, 1) : undefined}
        />
      ))}
      {(multi ? !max || list.length < max : list.length === 0) && (
        <Button size="sm" variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)} className="w-full">
          {multi ? 'Quelle hinzufügen' : 'Quelle wählen'}
        </Button>
      )}
      {!multi && list.length > 0 && (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)} className="w-full">
          Quelle ändern
        </Button>
      )}
      <PickerModal
        open={open}
        onClose={() => setOpen(false)}
        multi={multi}
        onPick={(picked) => onChange(multi ? [...list, ...picked] : [{ ...picked[0], stat: list[0]?.stat }])}
      />
    </div>
  )
}

export function SingleSource({ value, onChange, placeholder, defaultStat }: { value: Source | undefined; onChange: (s: Source | undefined) => void; placeholder?: string; defaultStat?: Stat }) {
  const [open, setOpen] = useState(false)
  useCatalog((st) => st.loaded)
  return (
    <div className="flex items-center gap-2">
      <button className="input flex min-w-0 flex-1 items-center text-left" onClick={() => setOpen(true)}>
        <span className={clsx('truncate', !value && 'text-muted')}>{value ? `${sourceTitle(value)} (${value.id})` : placeholder || 'Nicht gesetzt'}</span>
      </button>
      {value && (
        <IconButton title="Entfernen" onClick={() => onChange(undefined)}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      )}
      <PickerModal open={open} onClose={() => setOpen(false)} onPick={(p) => onChange({ ...p[0], stat: value?.stat || defaultStat })} />
    </div>
  )
}
