import clsx from 'clsx'
import { CircleDot, Database, History, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api/client'
import { useLive } from '../api/live'
import type { EntityRow, Job, SeriesResult } from '../api/types'
import { EChart } from '../charts/EChart'
import { Badge, Button, Card, Checkbox, Empty, Field, Input, Modal, NumberInput, PageHeader, Select, Spinner, Switch, confirmDialog, toast } from '../components/ui'
import RangePicker from '../components/RangePicker'
import { useRole } from '../store/app'
import { useCatalog } from '../store/catalog'
import { formatAge, formatBytes, formatNumber, formatTs, tickFormatter } from '../utils/format'

const KIND_LABELS: Record<string, string> = {
  auto: 'Automatisch',
  measurement: 'Momentanwert',
  counter: 'Zähler (steigend)',
  total: 'Summe (±)',
}

const PAGE_SIZE = 150

function KindSelect({ row, onChange, disabled }: { row: EntityRow; onChange: (k: string) => void; disabled?: boolean }) {
  return (
    <select
      className="rounded-md border border-line/60 bg-bg/60 px-1.5 py-1 text-xs"
      value={row.kind === row.kind_auto && row.recorded ? 'auto' : row.kind}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      title="Wertetyp bestimmt die Auswertung: Zähler werden als Verbrauch (resetsicher) ausgewertet, Momentanwerte zeitgewichtet gemittelt"
    >
      {Object.entries(KIND_LABELS).map(([k, l]) => (
        <option key={k} value={k}>
          {k === 'auto' ? `Auto (${KIND_LABELS[row.kind_auto] || row.kind_auto})` : l}
        </option>
      ))}
    </select>
  )
}

function ImportModal({ open, onClose, ids }: { open: boolean; onClose: () => void; ids: string[] }) {
  const [kind, setKind] = useState<'history' | 'statistics'>('statistics')
  const [range, setRange] = useState<any>({ last: '365d' })
  const [jobId, setJobId] = useState<number | null>(null)
  const job = useLive((s) => (jobId ? s.jobs[jobId] : undefined)) as Job | undefined
  useEffect(() => {
    if (open) {
      setJobId(null)
      setRange(kind === 'history' ? { last: '10d' } : { last: '365d' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const start = async () => {
    try {
      const res = await api.post<{ job_id: number }>(`import/${kind}`, { entity_ids: ids, range, record: true })
      setJobId(res.job_id)
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={`Historische Daten importieren (${ids.length} Entitäten)`} size="md">
      <div className="space-y-4">
        <Field label="Quelle">
          <Select
            value={kind}
            onChange={(v) => {
              setKind(v as any)
              setRange(v === 'history' ? { last: '10d' } : { last: '365d' })
            }}
            options={[
              { value: 'statistics', label: 'Langzeitstatistiken (stündlich, sehr lange verfügbar)' },
              { value: 'history', label: 'Rohdaten-Historie (exakt, nur Recorder-Aufbewahrung, meist 10 Tage)' },
            ]}
          />
        </Field>
        <Field label="Zeitraum">
          <RangePicker value={range} onChange={setRange} />
        </Field>
        <p className="text-xs text-muted">
          Bereits lokal aufgezeichnete Stunden werden nie überschrieben. Doppelte Messwerte werden ignoriert. Die Entitäten werden zur Aufzeichnung aktiviert.
        </p>
        {job ? (
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>{job.message}</span>
              <span className="tabular-nums">{Math.round(job.progress * 100)} %</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-line/50">
              <div className="h-full bg-accent transition-all" style={{ width: `${job.progress * 100}%` }} />
            </div>
            {job.status === 'done' && <div className="text-sm text-ok">Fertig: {JSON.stringify(job.result)}</div>}
            {job.status === 'failed' && <div className="text-sm text-bad">{job.message}</div>}
          </div>
        ) : jobId ? (
          <Spinner />
        ) : (
          <Button variant="primary" icon={<History className="h-4 w-4" />} onClick={start}>
            Import starten
          </Button>
        )}
      </div>
    </Modal>
  )
}

function EntityDetail({ row, onClose, onChanged }: { row: EntityRow; onClose: () => void; onChanged: () => void }) {
  const isAdmin = useRole('admin')
  const canEdit = useRole('editor')
  const [series, setSeries] = useState<SeriesResult | null>(null)
  const [detail, setDetail] = useState<any>(null)
  const [retention, setRetention] = useState<number | null>(row.retention_days)
  const [unit, setUnit] = useState(row.stored_unit || '')
  useEffect(() => {
    api.get(`entities/${row.entity_id}`).then(setDetail).catch(() => undefined)
    api
      .post<SeriesResult>('data/series', { source: { type: 'entity', id: row.entity_id }, range: 'last_7d', interval: 'auto' })
      .then(setSeries)
      .catch(() => setSeries(null))
  }, [row.entity_id])
  const fmt = tickFormatter(series?.interval || '1h')
  return (
    <Modal open onClose={onClose} title={row.name} size="lg">
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <div><div className="label">Entität</div><code className="text-xs">{row.entity_id}</code></div>
          <div><div className="label">Zustand</div>{row.state} {row.unit}</div>
          <div><div className="label">Bereich / Gerät</div>{row.area || '–'} / {row.device || '–'}</div>
          <div><div className="label">Geräteklasse</div>{row.device_class || '–'}</div>
          <div><div className="label">state_class</div>{row.state_class || '–'}</div>
          <div><div className="label">Wertetyp</div>{KIND_LABELS[row.kind] || row.kind}</div>
          <div><div className="label">Messwerte</div>{formatNumber(row.samples, { decimals: 0 })}</div>
          <div><div className="label">Speicher (ca.)</div>{formatBytes(row.bytes)}</div>
          <div><div className="label">Daten seit</div>{formatTs(detail?.first_ts)}</div>
        </div>
        <div className="h-56 rounded-lg border border-line/40 p-2">
          {series ? (
            <EChart
              option={{
                grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
                tooltip: { trigger: 'axis' },
                xAxis: { type: 'category', data: series.ts, axisLabel: { formatter: (v: string) => fmt(Number(v)), color: '#8b98b0' } },
                yAxis: { type: 'value', scale: true, axisLabel: { color: '#8b98b0' }, splitLine: { lineStyle: { color: 'rgba(120,130,160,0.2)' } } },
                series: [{ type: series.kind === 'measurement' ? 'line' : 'bar', data: series.values, showSymbol: false, smooth: true, itemStyle: { color: '#22d3ee' } }],
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted">Keine Daten für die letzten 7 Tage</div>
          )}
        </div>
        {canEdit && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Aufbewahrung Rohdaten (Tage)" hint="leer = globale Einstellung; verdichtete Stundenwerte bleiben erhalten">
              <NumberInput value={retention} min={1} onChange={setRetention} />
            </Field>
            <Field label="Gespeicherte Einheit" hint="Neue Werte werden in diese Einheit umgerechnet (z. B. Wh → kWh)">
              <Input value={unit} onChange={(e) => setUnit(e.target.value)} />
            </Field>
            <div className="md:col-span-2">
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await api.patch(`entities/${row.entity_id}`, { retention_days: retention, unit })
                    toast.ok('Gespeichert')
                    onChanged()
                  } catch (e) {
                    toast.error(e)
                  }
                }}
              >
                Speichern
              </Button>
            </div>
          </div>
        )}
        {isAdmin && (
          <div className="rounded-lg border border-bad/30 p-3">
            <div className="mb-2 text-sm font-medium text-bad">Gefahrenzone</div>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={async () => {
                if (!(await confirmDialog('Daten löschen', `Alle gespeicherten Messwerte von ${row.entity_id} löschen?`, { danger: true, confirmLabel: 'Löschen' }))) return
                await api.del(`entities/${row.entity_id}/data`).catch(toast.error)
                toast.ok('Daten gelöscht')
                onChanged()
                onClose()
              }}
            >
              Gespeicherte Daten löschen
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

export default function EntitiesPage() {
  const canEdit = useRole('editor')
  const [rows, setRows] = useState<EntityRow[] | null>(null)
  const [areas, setAreas] = useState<string[]>([])
  const [haConnected, setHaConnected] = useState(true)
  const [q, setQ] = useState('')
  const [domain, setDomain] = useState('')
  const [area, setArea] = useState('')
  const [recordedFilter, setRecordedFilter] = useState('')
  const [numericOnly, setNumericOnly] = useState(true)
  const [group, setGroup] = useState<'none' | 'area' | 'device' | 'domain'>('none')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const [detail, setDetail] = useState<EntityRow | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const reloadCatalog = useCatalog((s) => s.load)

  const load = async () => {
    try {
      const res = await api.get<{ entities: EntityRow[]; areas: string[]; ha_connected: boolean }>('entities')
      setRows(res.entities)
      setAreas(res.areas)
      setHaConnected(res.ha_connected)
    } catch (e) {
      toast.error(e)
    }
  }
  useEffect(() => {
    load()
  }, [])

  const domains = useMemo(() => [...new Set((rows || []).map((r) => r.domain))].sort(), [rows])
  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return (rows || []).filter(
      (r) =>
        (!numericOnly || r.numeric || r.recorded) &&
        (!domain || r.domain === domain) &&
        (!area || r.area === area) &&
        (!recordedFilter || (recordedFilter === 'yes' ? r.recorded : !r.recorded)) &&
        terms.every((t) => `${r.entity_id} ${r.name} ${r.area || ''} ${r.device || ''} ${r.device_class || ''}`.toLowerCase().includes(t)),
    )
  }, [rows, q, domain, area, recordedFilter, numericOnly])

  useEffect(() => setPage(0), [q, domain, area, recordedFilter, numericOnly, group])

  const grouped = useMemo(() => {
    const slice = group === 'none' ? filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : filtered
    if (group === 'none') return [{ key: '', items: slice }]
    const map = new Map<string, EntityRow[]>()
    for (const r of slice) {
      const k = (group === 'area' ? r.area : group === 'device' ? r.device : r.domain) || '— ohne Zuordnung —'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(r)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, items]) => ({ key, items }))
  }, [filtered, group, page])

  const totalStorage = (rows || []).reduce((a, r) => a + (r.bytes || 0), 0)
  const recordedCount = (rows || []).filter((r) => r.recorded).length

  const setRecording = async (ids: string[], recorded: boolean) => {
    setBusy(true)
    try {
      const res = await api.post<{ import_job: number | null }>('entities/record', { entity_ids: ids, recorded })
      toast.ok(`${ids.length} Entität(en) ${recorded ? 'werden aufgezeichnet' : 'nicht mehr aufgezeichnet'}`)
      if (res.import_job) toast.info('Vorhandene Historie aus Home Assistant wird im Hintergrund importiert (Einstellungen → Historischer Import).')
      await load()
      reloadCatalog(true)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const setKind = async (id: string, kind: string) => {
    try {
      await api.patch(`entities/${id}`, { kind })
      toast.ok('Wertetyp geändert – Verdichtungen werden neu berechnet')
      load()
    } catch (e) {
      toast.error(e)
    }
  }

  const toggleSel = (id: string, v: boolean) =>
    setSelected((s) => {
      const n = new Set(s)
      if (v) n.add(id)
      else n.delete(id)
      return n
    })

  const visibleIds = grouped.flatMap((g) => g.items.map((r) => r.entity_id))
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))

  return (
    <div>
      <PageHeader
        icon={<Database className="h-5 w-5" />}
        title="Entitäten"
        subtitle={`${recordedCount} aufgezeichnet · ${formatBytes(totalStorage)} belegt · ${(rows || []).length} Entitäten in Home Assistant`}
        actions={
          <Button icon={<RefreshCw className="h-4 w-4" />} onClick={load}>
            Aktualisieren
          </Button>
        }
      />
      {!haConnected && <div className="mb-4 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-warn">Keine Verbindung zu Home Assistant – es werden nur bereits bekannte Entitäten angezeigt.</div>}
      <Card bodyClass="p-0">
        <div className="flex flex-wrap items-center gap-3 border-b border-line/40 p-4">
          <div className="relative min-w-[240px] flex-1">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
            <Input className="pl-9" placeholder="Suche nach Name, ID, Bereich, Gerät…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select className="w-auto" value={domain} onChange={setDomain} placeholder="Alle Domänen" options={domains.map((d) => ({ value: d, label: d }))} />
          <Select className="w-auto" value={area} onChange={setArea} placeholder="Alle Bereiche" options={areas.map((a) => ({ value: a, label: a }))} />
          <Select
            className="w-auto"
            value={recordedFilter}
            onChange={setRecordedFilter}
            placeholder="Alle"
            options={[
              { value: 'yes', label: 'Aufgezeichnet' },
              { value: 'no', label: 'Nicht aufgezeichnet' },
            ]}
          />
          <Select
            className="w-auto"
            value={group}
            onChange={(v) => setGroup(v as any)}
            options={[
              { value: 'none', label: 'Keine Gruppierung' },
              { value: 'area', label: 'Nach Bereich' },
              { value: 'device', label: 'Nach Gerät' },
              { value: 'domain', label: 'Nach Domäne' },
            ]}
          />
          <Switch checked={numericOnly} onChange={setNumericOnly} label="Nur numerische" />
        </div>
        {canEdit && selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line/40 bg-accent/5 px-4 py-2 text-sm">
            <b>{selected.size} ausgewählt</b>
            <Button size="sm" variant="primary" loading={busy} onClick={() => setRecording([...selected], true)}>
              Aufzeichnung aktivieren
            </Button>
            <Button size="sm" loading={busy} onClick={() => setRecording([...selected], false)}>
              Aufzeichnung deaktivieren
            </Button>
            <Button size="sm" icon={<History className="h-4 w-4" />} onClick={() => setImportOpen(true)}>
              Historie importieren
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Auswahl aufheben
            </Button>
          </div>
        )}
        {!rows ? (
          <div className="p-8"><Spinner /></div>
        ) : filtered.length === 0 ? (
          <Empty title="Keine Entitäten gefunden" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-muted">
                  <th className="w-10 px-4 py-2">
                    {canEdit && (
                      <Checkbox
                        checked={allVisibleSelected}
                        indeterminate={!allVisibleSelected && visibleIds.some((id) => selected.has(id))}
                        onChange={(v) => setSelected((s) => {
                          const n = new Set(s)
                          visibleIds.forEach((id) => (v ? n.add(id) : n.delete(id)))
                          return n
                        })}
                        label="Alle auswählen"
                      />
                    )}
                  </th>
                  <th className="px-2 py-2">Entität</th>
                  <th className="px-2 py-2">Zustand</th>
                  <th className="px-2 py-2">Aufzeichnung</th>
                  <th className="px-2 py-2">Wertetyp</th>
                  <th className="px-2 py-2 text-right">Speicher</th>
                  <th className="px-2 py-2">Letzter Datenpunkt</th>
                </tr>
              </thead>
              <tbody>
                {grouped.map((g) => (
                  <GroupRows key={g.key} title={g.key} rows={g.items} selected={selected} toggleSel={toggleSel} canEdit={canEdit} onRecord={(id, v) => setRecording([id], v)} onKind={setKind} onOpen={setDetail} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {group === 'none' && filtered.length > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-line/40 px-4 py-2 text-sm text-muted">
            <span>
              {page * PAGE_SIZE + 1}–{Math.min(filtered.length, (page + 1) * PAGE_SIZE)} von {filtered.length}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Zurück</Button>
              <Button size="sm" disabled={(page + 1) * PAGE_SIZE >= filtered.length} onClick={() => setPage((p) => p + 1)}>Weiter</Button>
            </div>
          </div>
        )}
      </Card>
      {detail && <EntityDetail row={detail} onClose={() => setDetail(null)} onChanged={load} />}
      <ImportModal open={importOpen} onClose={() => { setImportOpen(false); load() }} ids={[...selected]} />
    </div>
  )
}

function GroupRows({ title, rows, selected, toggleSel, canEdit, onRecord, onKind, onOpen }: {
  title: string
  rows: EntityRow[]
  selected: Set<string>
  toggleSel: (id: string, v: boolean) => void
  canEdit: boolean
  onRecord: (id: string, v: boolean) => void
  onKind: (id: string, k: string) => void
  onOpen: (r: EntityRow) => void
}) {
  return (
    <>
      {title && (
        <tr>
          <td colSpan={7} className="bg-fg/[0.03] px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
            {title} <span className="font-normal">({rows.length})</span>
          </td>
        </tr>
      )}
      {rows.map((r) => (
        <tr key={r.entity_id} className={clsx('border-t border-line/25 hover:bg-fg/[0.03]', selected.has(r.entity_id) && 'bg-accent/5')}>
          <td className="px-4 py-2">{canEdit && <Checkbox checked={selected.has(r.entity_id)} onChange={(v) => toggleSel(r.entity_id, v)} label={r.entity_id} />}</td>
          <td className="max-w-[340px] px-2 py-2">
            <button className="block max-w-full truncate text-left font-medium hover:text-accent" onClick={() => onOpen(r)}>
              {r.name}
            </button>
            <div className="flex items-center gap-1.5 truncate text-xs text-muted">
              <code>{r.entity_id}</code>
              {r.area && <Badge>{r.area}</Badge>}
              {r.device_class && <Badge tone="accent">{r.device_class}</Badge>}
            </div>
          </td>
          <td className="whitespace-nowrap px-2 py-2 tabular-nums">
            <span className={clsx(!r.available && 'text-warn')}>{r.state ?? '–'}</span> <span className="text-xs text-muted">{r.unit}</span>
          </td>
          <td className="px-2 py-2">
            {canEdit ? (
              <Switch checked={r.recorded} onChange={(v) => onRecord(r.entity_id, v)} />
            ) : r.recorded ? (
              <Badge tone="ok">aktiv</Badge>
            ) : (
              <span className="text-xs text-muted">nur live</span>
            )}
          </td>
          <td className="px-2 py-2">
            <KindSelect row={r} onChange={(k) => onKind(r.entity_id, k)} disabled={!canEdit} />
          </td>
          <td className="whitespace-nowrap px-2 py-2 text-right text-xs tabular-nums text-muted">
            {r.samples ? (
              <>
                {formatBytes(r.bytes)}
                <div>{formatNumber(r.samples, { decimals: 0 })} Werte</div>
              </>
            ) : (
              '–'
            )}
          </td>
          <td className="whitespace-nowrap px-2 py-2 text-xs text-muted">
            {r.last_ts ? (
              <span title={formatTs(r.last_ts)}>
                <CircleDot className={clsx('mr-1 inline h-3 w-3', Date.now() - r.last_ts < 3600_000 ? 'text-ok' : 'text-warn')} />
                {formatNumber(r.last_value, {})} · {formatAge(r.last_ts)}
              </span>
            ) : (
              '–'
            )}
          </td>
        </tr>
      ))}
    </>
  )
}
