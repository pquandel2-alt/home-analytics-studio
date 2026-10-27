import { Bot, ClipboardCopy, Download, ExternalLink, FileJson, FileText, Send, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api, saveBlob } from '../api/client'
import type { Source } from '../api/types'
import RangePicker from '../components/RangePicker'
import { SourceList } from '../components/SourcePicker'
import { Badge, Button, Card, Field, PageHeader, Select, Switch, Tabs, Textarea, toast, useAsync } from '../components/ui'
import { useRole } from '../store/app'
import { INTERVALS, formatBytes } from '../utils/format'

interface ExportResult {
  package: any
  markdown: string
  prompt: string
  system: string
  size_bytes: number
}

const FOCUS = [
  { value: 'general', label: 'Allgemeine Auswertung' },
  { value: 'energy', label: 'Energieverbrauch & Einsparpotenzial' },
  { value: 'costs', label: 'Kostenentwicklung' },
  { value: 'climate', label: 'Raumklima & Komfort' },
  { value: 'anomalies', label: 'Auffälligkeiten & Defekte' },
]

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.ok('In die Zwischenablage kopiert')
  } catch {
    // fallback for non-secure contexts (http on LAN)
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    if (ok) toast.ok('In die Zwischenablage kopiert')
    else toast.error('Kopieren nicht möglich – bitte Datei herunterladen')
  }
}

export default function AiExportPage() {
  const loc = useLocation() as { state?: { sources?: Source[] } }
  const canEdit = useRole('editor')
  const [sources, setSources] = useState<Source[]>(loc.state?.sources || [])
  const [range, setRange] = useState<any>('last_30d')
  const [interval, setInterval] = useState('auto')
  const [focus, setFocus] = useState('general')
  const [question, setQuestion] = useState('')
  const [includeSeries, setIncludeSeries] = useState(true)
  const [res, setRes] = useState<ExportResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<'prompt' | 'markdown' | 'json'>('prompt')
  const [answer, setAnswer] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const { data: providers } = useAsync(() => api.get<{ active: { id: string; name: string; direct: boolean; description: string }; chatgpt_url: string }>('ai/providers'), [])

  useEffect(() => {
    if (loc.state?.sources) setSources(loc.state.sources)
  }, [loc.state])

  const build = async () => {
    setBusy(true)
    setAnswer(null)
    try {
      setRes(await api.post<ExportResult>('ai/export', { sources, range, interval, focus, question, include_series: includeSeries }))
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const direct = async () => {
    if (!res) return
    setAsking(true)
    try {
      const r = await api.post<{ answer: string }>('ai/analyze', { prompt: res.prompt })
      setAnswer(r.answer)
    } catch (e) {
      toast.error(e)
    } finally {
      setAsking(false)
    }
  }

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  return (
    <div>
      <PageHeader icon={<Bot className="h-5 w-5" />} title="Mit ChatGPT analysieren" subtitle="Daten und Analyse-Prompt erzeugen und selbst an ChatGPT übergeben – ohne API-Key" />
      <div className="mb-6 flex items-start gap-3 rounded-xl border border-accent/30 bg-accent/5 p-4 text-sm text-muted">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
        <div>
          Es besteht <b>keine direkte Verbindung</b> zu ChatGPT. Die Anwendung bereitet die Daten lokal auf; Sie kopieren den Prompt bzw. laden die Datei herunter und fügen sie selbst in ChatGPT ein (Ihr Abonnement, Ihre Anmeldung).
          Es werden keine Cookies oder inoffiziellen Schnittstellen verwendet. Prüfen Sie vor dem Teilen, welche Daten enthalten sind.
        </div>
      </div>
      <div className="grid gap-6 xl:grid-cols-[420px_1fr]">
        <Card title="1. Daten auswählen" bodyClass="space-y-4 p-5">
          <Field label="Analysebereich (Entitäten / Kennzahlen)">
            <SourceList value={sources} onChange={setSources} multi showStat={false} max={30} />
          </Field>
          <Field label="Zeitraum">
            <RangePicker value={range} onChange={setRange} />
          </Field>
          <Field label="Auflösung der Zeitreihen">
            <Select value={interval} onChange={setInterval} options={INTERVALS.filter((i) => !['1min', '5min'].includes(i.value))} />
          </Field>
          <Field label="Schwerpunkt">
            <Select value={focus} onChange={setFocus} options={FOCUS} />
          </Field>
          <Field label="Eigene Frage (optional)">
            <Textarea className="min-h-[70px] font-sans" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="z. B. Warum ist mein Verbrauch im Oktober gestiegen?" />
          </Field>
          <Switch checked={includeSeries} onChange={setIncludeSeries} label="Zeitreihen mitsenden" />
          <Button variant="primary" className="w-full" disabled={!sources.length} loading={busy} onClick={build}>
            2. Auswertung & Prompt erstellen
          </Button>
        </Card>
        <Card
          title="3. Exportieren & übergeben"
          actions={res && <Badge>{formatBytes(res.size_bytes)}</Badge>}
          bodyClass="space-y-4 p-5"
        >
          {!res ? (
            <p className="text-sm text-muted">Nach dem Erstellen erscheinen hier Prompt, Markdown-Bericht und JSON-Datenpaket.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" icon={<ClipboardCopy className="h-4 w-4" />} onClick={() => copyText(res.prompt)}>
                  Prompt kopieren
                </Button>
                <Button icon={<ExternalLink className="h-4 w-4" />} onClick={() => window.open(providers?.chatgpt_url || 'https://chatgpt.com/', '_blank', 'noopener')}>
                  ChatGPT öffnen
                </Button>
                <Button icon={<FileText className="h-4 w-4" />} onClick={() => saveBlob(new Blob([res.prompt], { type: 'text/plain;charset=utf-8' }), `chatgpt-prompt-${stamp}.txt`)}>
                  Prompt (.txt)
                </Button>
                <Button icon={<Download className="h-4 w-4" />} onClick={() => saveBlob(new Blob([res.markdown], { type: 'text/markdown;charset=utf-8' }), `auswertung-${stamp}.md`)}>
                  Bericht (.md)
                </Button>
                <Button icon={<FileJson className="h-4 w-4" />} onClick={() => saveBlob(new Blob([JSON.stringify(res.package, null, 2)], { type: 'application/json' }), `daten-${stamp}.json`)}>
                  Daten (.json)
                </Button>
              </div>
              {res.size_bytes > 100_000 && (
                <p className="text-xs text-warn">Der Prompt ist recht groß. Bei Bedarf eine gröbere Auflösung wählen oder die JSON-Datei als Anhang in ChatGPT hochladen.</p>
              )}
              <Tabs
                value={view}
                onChange={setView}
                tabs={[
                  { value: 'prompt', label: 'Prompt' },
                  { value: 'markdown', label: 'Bericht' },
                  { value: 'json', label: 'JSON' },
                ]}
              />
              <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap rounded-lg border border-line/40 bg-bg/60 p-3 text-xs">
                {view === 'prompt' ? res.prompt : view === 'markdown' ? res.markdown : JSON.stringify(res.package, null, 2)}
              </pre>
              {providers?.active?.direct && canEdit && (
                <div className="space-y-2 rounded-lg border border-line/40 p-3">
                  <div className="text-sm">
                    Optionaler direkter Anbieter aktiv: <b>{providers.active.name}</b> <span className="text-muted">({providers.active.description})</span>
                  </div>
                  <Button icon={<Send className="h-4 w-4" />} loading={asking} onClick={direct}>
                    Direkt analysieren lassen
                  </Button>
                  {answer && <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap text-sm">{answer}</pre>}
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
