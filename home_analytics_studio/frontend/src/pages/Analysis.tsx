import clsx from 'clsx'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Bot, Info, Play } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import type { AnalysisResult, Insight, Source } from '../api/types'
import { EChart } from '../charts/EChart'
import RangePicker from '../components/RangePicker'
import { SingleSource } from '../components/SourcePicker'
import { Badge, Button, Card, Empty, Field, NumberInput, PageHeader, Spinner, Tabs, toast } from '../components/ui'
import { useApp } from '../store/app'
import { formatNumber, formatPct, labelFormatter, tickFormatter } from '../utils/format'

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

export function InsightList({ items }: { items: Insight[] }) {
  if (!items.length) return <p className="text-sm text-muted">Keine Erkenntnisse – zu wenige Daten im Zeitraum.</p>
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.id} className="flex gap-3 text-sm leading-relaxed">
          <span className={clsx('mt-0.5 shrink-0', i.severity === 'up' && 'text-warn', i.severity === 'down' && 'text-ok', i.severity === 'warning' && 'text-bad', i.severity === 'info' && 'text-accent')}>
            {i.severity === 'up' ? <ArrowUpRight className="h-4 w-4" /> : i.severity === 'down' ? <ArrowDownRight className="h-4 w-4" /> : i.severity === 'warning' ? <AlertTriangle className="h-4 w-4" /> : <Info className="h-4 w-4" />}
          </span>
          <span>
            {i.text}
            {i.incomplete && <Badge tone="warn" className="ml-2">unvollständig</Badge>}
          </span>
        </li>
      ))}
    </ul>
  )
}

function SingleAnalysis() {
  const navigate = useNavigate()
  const tz = useApp((s) => s.appearance?.timezone)
  const [source, setSource] = useState<Source | undefined>()
  const [days, setDays] = useState<number | null>(90)
  const [res, setRes] = useState<AnalysisResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [rangeA, setRangeA] = useState<any>('this_month')
  const [rangeB, setRangeB] = useState<any>('last_month')
  const [cmp, setCmp] = useState<any>(null)

  const run = async () => {
    if (!source) return
    setBusy(true)
    try {
      setRes(await api.post<AnalysisResult>('analysis/run', { source, days: days || 90 }))
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  const compare = async () => {
    if (!source) return
    try {
      setCmp(await api.post('analysis/compare', { source, a: rangeA, b: rangeB }))
    } catch (e) {
      toast.error(e)
    }
  }
  const tick = tickFormatter('1d', tz)
  const lab = labelFormatter('1d', tz)
  return (
    <div className="space-y-6">
      <Card>
        <div className="grid items-end gap-4 md:grid-cols-[1fr_160px_auto_auto]">
          <Field label="Entität oder Kennzahl">
            <SingleSource value={source} onChange={setSource} placeholder="Datenquelle wählen…" />
          </Field>
          <Field label="Analysezeitraum (Tage)">
            <NumberInput value={days} min={7} max={1095} onChange={setDays} />
          </Field>
          <Button variant="primary" icon={<Play className="h-4 w-4" />} disabled={!source} loading={busy} onClick={run}>
            Analysieren
          </Button>
          <Button icon={<Bot className="h-4 w-4" />} disabled={!source} onClick={() => navigate('/ai', { state: { sources: source ? [source] : [] } })}>
            Mit ChatGPT analysieren
          </Button>
        </div>
      </Card>
      {busy && <Spinner />}
      {res && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {(['day', 'week', 'month', 'year'] as const).map((p) => {
              const c = res.comparisons[p]
              return (
                <div key={p} className="panel p-4">
                  <div className="text-xs uppercase tracking-wider text-muted">{c.label}</div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums">
                    {formatNumber(c.current, {})} <span className="text-sm text-muted">{res.unit}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted">
                    <span className={clsx('whitespace-nowrap font-semibold', (c.change_pct ?? 0) > 0 ? 'text-warn' : 'text-ok')}>{formatPct(c.change_pct)}</span>
                    vs. {c.previous_label} (gleicher Abschnitt: {formatNumber(c.previous_same_elapsed, {})})
                  </div>
                  {c.current_coverage != null && c.current_coverage < 0.8 && <Badge tone="warn" className="mt-2">Datenabdeckung {Math.round(c.current_coverage * 100)} %</Badge>}
                </div>
              )
            })}
          </div>
          <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
            <Card title={`Tageswerte – ${res.name}`}>
              <div className="h-72">
                <EChart
                  option={{
                    grid: { left: 8, right: 8, top: 20, bottom: 4, containLabel: true },
                    tooltip: {
                      trigger: 'axis',
                      formatter: (ps: any[]) => `${lab(res.daily.ts[ps[0].dataIndex])}<br/><b>${formatNumber(ps[0].value, {})} ${res.unit || ''}</b><br/>Abdeckung ${Math.round((res.daily.coverage[ps[0].dataIndex] ?? 0) * 100)} %`,
                    },
                    xAxis: { type: 'category', data: res.daily.ts, axisLabel: { formatter: (v: string) => tick(Number(v)), color: '#8b98b0' } },
                    yAxis: { type: 'value', axisLabel: { color: '#8b98b0' }, splitLine: { lineStyle: { color: 'rgba(120,130,160,0.2)' } } },
                    series: [
                      {
                        type: 'bar',
                        data: res.daily.values.map((v, i) => ({ value: v, itemStyle: { color: (res.daily.coverage[i] ?? 1) < 0.8 ? 'rgba(251,191,36,0.6)' : '#22d3ee', borderRadius: [3, 3, 0, 0] } })),
                      },
                    ],
                  }}
                />
              </div>
              <p className="mt-2 text-xs text-muted">Gelb: Tage mit unvollständigen Daten (&lt; 80 % Abdeckung).</p>
            </Card>
            <Card title="Automatische Erkenntnisse">
              <InsightList items={res.insights} />
            </Card>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Tagesprofil (Ø je Stunde, letzte 7 Tage)">
              <div className="h-56">
                <EChart
                  option={{
                    grid: { left: 8, right: 8, top: 10, bottom: 4, containLabel: true },
                    tooltip: { trigger: 'axis' },
                    xAxis: { type: 'category', data: Array.from({ length: 24 }, (_, i) => `${i}`), axisLabel: { color: '#8b98b0' } },
                    yAxis: { type: 'value', axisLabel: { color: '#8b98b0' }, splitLine: { lineStyle: { color: 'rgba(120,130,160,0.2)' } } },
                    series: [{ type: 'bar', data: res.stats.hour_profile || [], itemStyle: { color: '#a855f7', borderRadius: [3, 3, 0, 0] } }],
                  }}
                />
              </div>
            </Card>
            <Card title="Wochenprofil (Ø je Wochentag)">
              <div className="h-56">
                <EChart
                  option={{
                    grid: { left: 8, right: 8, top: 10, bottom: 4, containLabel: true },
                    tooltip: { trigger: 'axis' },
                    xAxis: { type: 'category', data: WEEKDAYS, axisLabel: { color: '#8b98b0' } },
                    yAxis: { type: 'value', axisLabel: { color: '#8b98b0' }, splitLine: { lineStyle: { color: 'rgba(120,130,160,0.2)' } } },
                    series: [{ type: 'bar', data: res.stats.weekday_profile || [], itemStyle: { color: '#34d399', borderRadius: [3, 3, 0, 0] } }],
                  }}
                />
              </div>
            </Card>
          </div>
        </>
      )}
      {source && (
        <Card title="Freier Zeitraumvergleich">
          <div className="grid items-end gap-4 md:grid-cols-[1fr_1fr_auto]">
            <Field label="Zeitraum A">
              <RangePicker value={rangeA} onChange={setRangeA} />
            </Field>
            <Field label="Zeitraum B">
              <RangePicker value={rangeB} onChange={setRangeB} />
            </Field>
            <Button onClick={compare}>Vergleichen</Button>
          </div>
          {cmp && (
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div className="rounded-lg bg-fg/[0.04] p-3">
                <div className="text-xs text-muted">A</div>
                <div className="text-xl font-semibold tabular-nums">{formatNumber(cmp.a.value, {})} {cmp.a.unit}</div>
              </div>
              <div className="rounded-lg bg-fg/[0.04] p-3">
                <div className="text-xs text-muted">B</div>
                <div className="text-xl font-semibold tabular-nums">{formatNumber(cmp.b.value, {})} {cmp.b.unit}</div>
              </div>
              <div className="rounded-lg bg-fg/[0.04] p-3">
                <div className="text-xs text-muted">Veränderung</div>
                <div className="text-xl font-semibold tabular-nums">{formatPct(cmp.change_pct)}</div>
              </div>
              {cmp.text && <p className="text-sm md:col-span-3">{cmp.text}</p>}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

function Overview() {
  const [data, setData] = useState<{ name?: string; unit?: string; source: Source; insights: Insight[]; error?: string }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      setData(await api.post('analysis/overview', {}))
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted">Analysiert alle aufgezeichneten Entitäten und Kennzahlen (max. je 20) der letzten 60 Tage.</p>
          <Button variant="primary" loading={busy} icon={<Play className="h-4 w-4" />} onClick={run}>
            Übersicht erstellen
          </Button>
        </div>
      </Card>
      {data && data.length === 0 && <Empty title="Keine aufgezeichneten Daten">Aktivieren Sie zuerst unter „Entitäten“ die Aufzeichnung.</Empty>}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.map((d) => (
          <Card key={`${d.source.type}:${d.source.id}`} title={d.name || d.source.id} actions={d.unit && <Badge tone="accent">{d.unit}</Badge>}>
            {d.error ? <p className="text-sm text-bad">{d.error}</p> : <InsightList items={d.insights.filter((i) => i.severity !== 'info').concat(d.insights.filter((i) => i.severity === 'info').slice(0, 2))} />}
          </Card>
        ))}
      </div>
    </div>
  )
}

export default function AnalysisPage() {
  const [tab, setTab] = useState<'single' | 'overview'>('single')
  return (
    <div>
      <PageHeader icon={<BarChart3 className="h-5 w-5" />} title="Automatische Analysen" subtitle="Statistische Auswertung aus echten Messwerten – ohne KI, ohne Cloud" />
      <Tabs
        value={tab}
        onChange={setTab}
        className="mb-6 w-fit"
        tabs={[
          { value: 'single', label: 'Einzelanalyse' },
          { value: 'overview', label: 'Gesamtübersicht' },
        ]}
      />
      {tab === 'single' ? <SingleAnalysis /> : <Overview />}
    </div>
  )
}
