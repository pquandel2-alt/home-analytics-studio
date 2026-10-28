import {
  Activity,
  AreaChart,
  BarChart3,
  CalendarDays,
  ChartColumnStacked,
  Clock,
  Code2,
  Coins,
  Columns2,
  Factory,
  Fan,
  Gauge,
  GitCompareArrows,
  Grid3x3,
  Heading,
  History,
  Image,
  Info,
  LayoutGrid,
  LineChart,
  Lightbulb,
  PieChart,
  Percent,
  PlugZap,
  Radar,
  Sigma,
  Sun,
  Table2,
  TrendingUp,
  Type,
  UtilityPole,
  Workflow,
  Zap,
  Donut,
  SquareActivity,
} from 'lucide-react'
import type { Source } from '../api/types'
import { ICON_OPTIONS } from '../utils/icons'
import { CalendarHeatmapWidget, CompareChartWidget, GaugeWidget, HeatmapWidget, PieWidget, RadialGaugeWidget, SparklineWidget, TimeSeriesChart } from './charts'
import { CostsWidget, DistributionWidget, EnergyFlowWidget, PowerEnergyCard, SelfConsumptionWidget } from './energy'
import { ComparisonWidget, KpiWidget, MultiValueWidget, PercentWidget, TrendWidget, ValueWidget } from './kpi'
import { AnalysisWidget, ClockWidget, HeadingWidget, HistoryWidget, ImageWidget, InfoWidget, StatsWidget, TableWidget, TextWidget } from './other'
import { sceneRequests } from './scene/engine'
import SceneEditor from './scene/SceneEditor'
import { SceneWidget } from './scene/SceneWidget'
import type { DataRequest, FieldDef, SlotDef, WidgetDef } from './types'

// ------------------------------------------------------------------ request helpers

function sourcesOf(cfg: Record<string, any>): Source[] {
  return ((cfg.sources as Source[]) || []).filter((s) => s && s.id)
}

const seriesReqs = (cfg: Record<string, any>): DataRequest[] =>
  sourcesOf(cfg).map((s, i) => ({ kind: 'series', source: s, range: cfg.range, interval: cfg.interval || 'auto', key: `s${i}` }))

/** Line-like charts: entity sources without an explicit statistic follow cfg.counterMode
 *  ('state' = reading like the HA history graph, 'delta' = consumption per interval). */
const lineReqs = (cfg: Record<string, any>): DataRequest[] =>
  seriesReqs(cfg).map((r) =>
    r.source.type === 'entity' && (!r.source.stat || r.source.stat === 'auto')
      ? { ...r, source: { ...r.source, stat: cfg.counterMode === 'delta' ? 'auto' : 'state' } }
      : r,
  )

const counterModeField: FieldDef = {
  key: 'counterMode',
  label: 'Zähler (z. B. kWh) darstellen als',
  type: 'select',
  options: [
    { value: 'state', label: 'Zählerstand / Sensorwert (wie HA-Verlauf)' },
    { value: 'delta', label: 'Verbrauch je Intervall' },
  ],
}

const axisField: FieldDef = { key: 'axisToData', label: 'Y-Achse endet am höchsten / niedrigsten Wert', type: 'bool' }

const scalarReqs = (cfg: Record<string, any>): DataRequest[] =>
  sourcesOf(cfg).map((s, i) => ({ kind: 'scalar', source: s, range: cfg.range, key: `s${i}` }))

function slotReqs(cfg: Record<string, any>, slots: SlotDef[], range: any): DataRequest[] {
  const out: DataRequest[] = []
  for (const sl of slots) {
    const s: Source | undefined = cfg.slots?.[sl.key]
    if (!s?.id) continue
    out.push({ kind: 'scalar', source: { ...s, stat: s.stat || sl.stat }, range, key: `slot_${sl.key}` })
  }
  return out
}

const liveOf = (cfg: Record<string, any>) =>
  [...sourcesOf(cfg), ...Object.values((cfg.slots as Record<string, Source>) || {})].filter((s) => s?.type === 'entity').map((s) => s.id)

function sceneDef(type: string, label: string, category: WidgetDef['category'], icon: any, description: string, template: string): WidgetDef {
  return {
    type,
    label,
    category,
    icon,
    description,
    defaultSize: { w: 12, h: 9 },
    minSize: { w: 4, h: 3 },
    defaults: { template, range: 'today', bind: {}, labels: [] },
    sources: 'slots',
    slots: [],
    dataFields: { range: true },
    fields: [],
    requests: sceneRequests,
    DataEditor: SceneEditor,
    Component: SceneWidget,
  }
}

// ------------------------------------------------------------------ shared field sets

const chartFields: FieldDef[] = [
  { key: 'showLegend', label: 'Legende anzeigen', type: 'bool' },
  { key: 'showGrid', label: 'Gitterlinien', type: 'bool' },
  { key: 'showLabels', label: 'Werte beschriften', type: 'bool' },
  { key: 'showAverage', label: 'Durchschnittslinie', type: 'bool' },
  { key: 'zoom', label: 'Zoom (Mausrad/Touch)', type: 'bool' },
  { key: 'zeroBased', label: 'Y-Achse bei 0 beginnen', type: 'bool' },
  { key: 'yMin', label: 'Y-Minimum', type: 'number', placeholder: 'automatisch' },
  { key: 'yMax', label: 'Y-Maximum', type: 'number', placeholder: 'automatisch' },
  { key: 'thresholds', label: 'Grenzwertlinien', type: 'thresholds' },
]

const lineFields: FieldDef[] = [
  { key: 'smooth', label: 'Geglättete Linie', type: 'bool' },
  { key: 'showPoints', label: 'Datenpunkte zeigen', type: 'bool' },
  { key: 'connectNulls', label: 'Lücken verbinden', type: 'bool' },
  { key: 'showMinMax', label: 'Min/Max-Band', type: 'bool' },
  { key: 'lineWidth', label: 'Linienstärke', type: 'number', min: 1, max: 6, step: 0.5 },
]

const thresholdField: FieldDef = { key: 'thresholds', label: 'Farbschwellen (ab Wert → Farbe)', type: 'thresholds' }
const invertField: FieldDef = { key: 'invertColors', label: 'Anstieg ist gut (Farben umkehren)', type: 'bool', hint: 'Standard: Anstieg = rot (Verbrauch)' }

const PERIOD_OPTIONS = [
  { value: 'day', label: 'Heute vs. gestern' },
  { value: 'week', label: 'Diese vs. letzte Woche' },
  { value: 'month', label: 'Dieser vs. letzter Monat' },
  { value: 'year', label: 'Dieses vs. letztes Jahr' },
]

const powerSlots: SlotDef[] = [
  { key: 'power', label: 'Leistung (W, live)', stat: 'current' },
  { key: 'energy', label: 'Energiezähler (kWh)', stat: 'auto' },
]

function powerCard(type: string, label: string, icon: any, description: string): WidgetDef {
  return {
    type,
    label,
    category: 'energy',
    icon,
    description,
    defaultSize: { w: 6, h: 5 },
    defaults: { range: 'today', barsRange: 'today', barsInterval: '1h', showChart: true },
    sources: 'slots',
    slots: powerSlots,
    fields: [
      { key: 'range', label: 'Zeitraum Energiewert', type: 'range' },
      { key: 'energyLabel', label: 'Beschriftung Energiewert', type: 'text', placeholder: 'Heute' },
      { key: 'showChart', label: 'Balkendiagramm', type: 'bool' },
      { key: 'barsRange', label: 'Zeitraum Diagramm', type: 'range', showIf: (c) => c.showChart !== false },
      { key: 'barsInterval', label: 'Intervall Diagramm', type: 'interval', showIf: (c) => c.showChart !== false },
      { key: 'color', label: 'Akzentfarbe', type: 'color' },
    ],
    requests: (cfg) => {
      const reqs = slotReqs(cfg, powerSlots, cfg.range || 'today')
      const energy: Source | undefined = cfg.slots?.energy
      const power: Source | undefined = cfg.slots?.power
      const barSrc = energy?.id ? energy : power?.id ? { ...power, stat: 'mean' as const } : null
      if (barSrc && cfg.showChart !== false) reqs.push({ kind: 'series', source: { ...barSrc, stat: energy?.id ? 'auto' : 'mean' }, range: cfg.barsRange || 'today', interval: cfg.barsInterval || '1h', key: 'bars' })
      return reqs
    },
    liveEntities: liveOf,
    Component: PowerEnergyCard,
  }
}

// ------------------------------------------------------------------ definitions

export const WIDGETS: WidgetDef[] = [
  // ---------------- KPI
  {
    type: 'value',
    label: 'Einzelwert',
    category: 'kpi',
    icon: SquareActivity,
    description: 'Ein großer Wert – live oder für einen Zeitraum',
    defaultSize: { w: 4, h: 3 },
    defaults: { range: 'today', sources: [] },
    sources: 'single',
    dataFields: { range: true, stat: true },
    fields: [
      { key: 'subtitle', label: 'Untertitel', type: 'text', placeholder: 'automatisch' },
      { key: 'align', label: 'Ausrichtung', type: 'select', options: [{ value: 'left', label: 'Links' }, { value: 'center', label: 'Mitte' }, { value: 'right', label: 'Rechts' }] },
      { key: 'fontScale', label: 'Schriftgröße (Faktor)', type: 'number', min: 0.4, max: 3, step: 0.1 },
      { key: 'valueColor', label: 'Wertfarbe', type: 'color' },
      { key: 'sparkline', label: 'Verlaufslinie anzeigen', type: 'bool' },
      { key: 'sparkRange', label: 'Zeitraum Verlauf', type: 'range', showIf: (c) => !!c.sparkline },
      thresholdField,
    ],
    requests: (cfg) => {
      const r = scalarReqs(cfg).slice(0, 1)
      const s = sourcesOf(cfg)[0]
      if (s && cfg.sparkline) r.push({ kind: 'series', source: { ...s, stat: s.stat === 'current' ? 'auto' : s.stat }, range: cfg.sparkRange || 'last_24h', interval: 'auto', key: 'spark' })
      return r
    },
    liveEntities: liveOf,
    Component: ValueWidget,
  },
  {
    type: 'multi_value',
    label: 'Mehrere Kennzahlen',
    category: 'kpi',
    icon: LayoutGrid,
    description: 'Mehrere Werte kompakt in einem Raster',
    defaultSize: { w: 8, h: 4 },
    defaults: { range: 'today', sources: [] },
    sources: 'multi',
    dataFields: { range: true, stat: true },
    fields: [{ key: 'columns', label: 'Spalten', type: 'number', min: 1, max: 8, placeholder: 'automatisch' }, thresholdField],
    requests: scalarReqs,
    liveEntities: liveOf,
    Component: MultiValueWidget,
  },
  {
    type: 'kpi',
    label: 'KPI-Karte',
    category: 'kpi',
    icon: Activity,
    description: 'Wert mit Vergleich zur Vorperiode, Ziel und Verlauf',
    defaultSize: { w: 6, h: 4 },
    defaults: { period: 'day', sparkline: true, sources: [] },
    sources: 'single',
    fields: [
      { key: 'period', label: 'Vergleich', type: 'select', options: PERIOD_OPTIONS },
      { key: 'target', label: 'Zielwert (optional)', type: 'number' },
      { key: 'sparkline', label: 'Verlauf anzeigen', type: 'bool' },
      invertField,
    ],
    requests: (cfg) => {
      const s = sourcesOf(cfg)[0]
      if (!s) return []
      const range = { day: 'today', week: 'this_week', month: 'this_month', year: 'this_year' }[cfg.period as string] || 'today'
      const interval = { day: '1h', week: '1h', month: '1d', year: '1mo' }[cfg.period as string] || '1h'
      const reqs: DataRequest[] = [{ kind: 'compare', source: s, period: cfg.period || 'day', key: 'cmp' }]
      if (cfg.sparkline !== false) reqs.push({ kind: 'series', source: s, range, interval, key: 'spark' })
      return reqs
    },
    Component: KpiWidget,
  },
  {
    type: 'comparison',
    label: 'Vergleichskarte',
    category: 'kpi',
    icon: Columns2,
    description: 'Zwei Zeiträume direkt gegenübergestellt',
    defaultSize: { w: 6, h: 4 },
    defaults: { rangeA: 'this_month', rangeB: 'last_month', sources: [] },
    sources: 'single',
    fields: [
      { key: 'rangeA', label: 'Zeitraum A', type: 'range' },
      { key: 'labelA', label: 'Beschriftung A', type: 'text', placeholder: 'automatisch' },
      { key: 'rangeB', label: 'Zeitraum B', type: 'range' },
      { key: 'labelB', label: 'Beschriftung B', type: 'text', placeholder: 'automatisch' },
      invertField,
    ],
    requests: (cfg) => {
      const s = sourcesOf(cfg)[0]
      return s
        ? [
            { kind: 'scalar', source: s, range: cfg.rangeA || 'this_month', key: 'a' },
            { kind: 'scalar', source: s, range: cfg.rangeB || 'last_month', key: 'b' },
          ]
        : []
    },
    Component: ComparisonWidget,
  },
  {
    type: 'percent',
    label: 'Prozentanzeige',
    category: 'kpi',
    icon: Percent,
    description: 'Prozentwert als Ring oder Balken (z. B. Batterie, Quote)',
    defaultSize: { w: 4, h: 4 },
    defaults: { mode: 'value', display: 'ring', range: 'today', sources: [] },
    sources: 'multi',
    dataFields: { range: true, stat: true },
    fields: [
      {
        key: 'mode',
        label: 'Berechnung',
        type: 'select',
        options: [
          { value: 'value', label: 'Wert ist bereits Prozent' },
          { value: 'ratio', label: 'Quelle 1 / Quelle 2 × 100' },
          { value: 'range', label: 'Position zwischen Min und Max' },
        ],
      },
      { key: 'min', label: 'Minimum', type: 'number', showIf: (c) => c.mode === 'range' },
      { key: 'max', label: 'Maximum', type: 'number', showIf: (c) => c.mode === 'range' },
      { key: 'display', label: 'Darstellung', type: 'select', options: [{ value: 'ring', label: 'Ring' }, { value: 'bar', label: 'Balken' }] },
      { key: 'subtitle', label: 'Beschriftung', type: 'text' },
      thresholdField,
    ],
    requests: (cfg) => scalarReqs(cfg).slice(0, 2),
    liveEntities: liveOf,
    Component: PercentWidget,
  },
  {
    type: 'trend',
    label: 'Trendanzeige',
    category: 'kpi',
    icon: TrendingUp,
    description: 'Trendrichtung (lineare Regression) über einen Zeitraum',
    defaultSize: { w: 5, h: 4 },
    defaults: { range: 'last_30d', interval: '1d', sources: [] },
    sources: 'single',
    dataFields: { range: true, interval: true, stat: true },
    fields: [invertField],
    requests: (cfg) => seriesReqs(cfg).slice(0, 1),
    Component: TrendWidget,
  },
  // ---------------- charts
  {
    type: 'line',
    label: 'Liniendiagramm',
    category: 'chart',
    icon: LineChart,
    description: 'Zeitverlauf einer oder mehrerer Quellen',
    defaultSize: { w: 12, h: 7 },
    defaults: { range: 'last_24h', interval: 'auto', smooth: true, showLegend: true, showGrid: true, counterMode: 'state', axisToData: true, sources: [] },
    sources: 'multi',
    dataFields: { range: true, interval: true, stat: true },
    fields: [counterModeField, axisField, ...lineFields, { key: 'fill', label: 'Fläche füllen', type: 'bool' }, ...chartFields],
    requests: lineReqs,
    Component: TimeSeriesChart,
  },
  {
    type: 'area',
    label: 'Flächendiagramm',
    category: 'chart',
    icon: AreaChart,
    description: 'Verlauf mit gefüllter Fläche, optional gestapelt',
    defaultSize: { w: 12, h: 7 },
    defaults: { range: 'last_24h', interval: 'auto', smooth: true, showLegend: true, showGrid: true, counterMode: 'state', axisToData: true, sources: [] },
    sources: 'multi',
    dataFields: { range: true, interval: true, stat: true },
    fields: [counterModeField, axisField, ...lineFields, { key: 'stack', label: 'Gestapelt', type: 'bool' }, { key: 'fillOpacity', label: 'Deckkraft Fläche', type: 'number', min: 0, max: 1, step: 0.05 }, ...chartFields],
    requests: lineReqs,
    Component: TimeSeriesChart,
  },
  {
    type: 'bar',
    label: 'Balkendiagramm',
    category: 'chart',
    icon: BarChart3,
    description: 'Verbrauch oder Werte je Zeitabschnitt',
    defaultSize: { w: 12, h: 7 },
    defaults: { range: 'last_7d', interval: '1d', showLegend: true, showGrid: true, sources: [] },
    sources: 'multi',
    dataFields: { range: true, interval: true, stat: true },
    fields: chartFields,
    requests: seriesReqs,
    Component: TimeSeriesChart,
  },
  {
    type: 'stacked_bar',
    label: 'Gestapeltes Balkendiagramm',
    category: 'chart',
    icon: ChartColumnStacked,
    description: 'Anteile mehrerer Quellen je Zeitabschnitt',
    defaultSize: { w: 12, h: 7 },
    defaults: { range: 'last_7d', interval: '1d', showLegend: true, showGrid: true, sources: [] },
    sources: 'multi',
    dataFields: { range: true, interval: true, stat: true },
    fields: chartFields,
    requests: seriesReqs,
    Component: TimeSeriesChart,
  },
  {
    type: 'pie',
    label: 'Kreisdiagramm',
    category: 'chart',
    icon: PieChart,
    description: 'Anteile im Zeitraum',
    defaultSize: { w: 6, h: 7 },
    defaults: { range: 'today', showLegend: true, showLabels: true, sources: [] },
    sources: 'multi',
    dataFields: { range: true, stat: true },
    fields: [
      { key: 'showLegend', label: 'Legende', type: 'bool' },
      { key: 'showLabels', label: 'Beschriftungen', type: 'bool' },
      { key: 'rose', label: 'Rosendiagramm (Radius nach Wert)', type: 'bool' },
    ],
    requests: scalarReqs,
    Component: PieWidget,
  },
  {
    type: 'donut',
    label: 'Donutdiagramm',
    category: 'chart',
    icon: Donut,
    description: 'Anteile mit Gesamtsumme in der Mitte',
    defaultSize: { w: 6, h: 7 },
    defaults: { range: 'today', showLegend: true, showLabels: false, showTotal: true, sources: [] },
    sources: 'multi',
    dataFields: { range: true, stat: true },
    fields: [
      { key: 'showLegend', label: 'Legende', type: 'bool' },
      { key: 'showLabels', label: 'Beschriftungen', type: 'bool' },
      { key: 'showTotal', label: 'Summe in der Mitte', type: 'bool' },
    ],
    requests: scalarReqs,
    Component: PieWidget,
  },
  {
    type: 'gauge',
    label: 'Gauge',
    category: 'chart',
    icon: Gauge,
    description: 'Tachoanzeige mit Bereichen',
    defaultSize: { w: 5, h: 6 },
    defaults: { min: 0, max: 100, range: 'today', sources: [], showZones: true },
    sources: 'single',
    dataFields: { range: true, stat: true },
    fields: [
      { key: 'min', label: 'Minimum', type: 'number' },
      { key: 'max', label: 'Maximum', type: 'number' },
      { key: 'subtitle', label: 'Beschriftung', type: 'text' },
      { key: 'pointer', label: 'Zeiger', type: 'bool' },
      { key: 'showTicks', label: 'Skala', type: 'bool' },
      { key: 'showZones', label: 'Farbzonen auf der Skala', type: 'bool' },
      thresholdField,
    ],
    requests: (cfg) => scalarReqs(cfg).slice(0, 1),
    liveEntities: liveOf,
    Component: GaugeWidget,
  },
  {
    type: 'radial_gauge',
    label: 'Radial Gauge',
    category: 'chart',
    icon: Radar,
    description: 'Konzentrische Ringe für mehrere Werte',
    defaultSize: { w: 6, h: 6 },
    defaults: { max: 100, range: 'today', sources: [], showLabels: true },
    sources: 'multi',
    dataFields: { range: true, stat: true },
    fields: [
      { key: 'max', label: 'Maximum (100 % Ring)', type: 'number' },
      { key: 'showLabels', label: 'Beschriftungen', type: 'bool' },
    ],
    requests: scalarReqs,
    Component: RadialGaugeWidget,
  },
  {
    type: 'heatmap',
    label: 'Heatmap',
    category: 'chart',
    icon: Grid3x3,
    description: 'Stunde × Tag – Muster im Tagesverlauf',
    defaultSize: { w: 12, h: 8 },
    defaults: { range: 'last_7d', sources: [] },
    sources: 'single',
    dataFields: { range: true, stat: true },
    fields: [{ key: 'hotColor', label: 'Farbe Höchstwerte', type: 'color' }],
    requests: (cfg) => sourcesOf(cfg).slice(0, 1).map((s) => ({ kind: 'series', source: s, range: cfg.range || 'last_7d', interval: '1h', key: 's0' })),
    Component: HeatmapWidget,
  },
  {
    type: 'calendar_heatmap',
    label: 'Kalender-Heatmap',
    category: 'chart',
    icon: CalendarDays,
    description: 'Tageswerte im Kalender (z. B. Verbrauch je Tag)',
    defaultSize: { w: 14, h: 6 },
    defaults: { range: 'last_90d', sources: [], showLegend: true },
    sources: 'single',
    dataFields: { range: true, stat: true },
    fields: [{ key: 'showLegend', label: 'Farbskala anzeigen', type: 'bool' }],
    requests: (cfg) => sourcesOf(cfg).slice(0, 1).map((s) => ({ kind: 'series', source: s, range: cfg.range || 'last_90d', interval: '1d', key: 's0' })),
    Component: CalendarHeatmapWidget,
  },
  {
    type: 'sparkline',
    label: 'Verlaufskurve',
    category: 'chart',
    icon: Activity,
    description: 'Aktueller Wert mit kompakter Verlaufskurve',
    defaultSize: { w: 5, h: 4 },
    defaults: { range: 'last_24h', interval: 'auto', sources: [], valueMode: 'current' },
    sources: 'single',
    dataFields: { range: true, interval: true, stat: true },
    fields: [{ key: 'valueMode', label: 'Angezeigter Wert', type: 'select', options: [{ value: 'current', label: 'Aktueller Zustand (live)' }, { value: 'last', label: 'Letzter Abschnitt der Kurve' }] }],
    requests: (cfg) => {
      const s = sourcesOf(cfg)[0]
      if (!s) return []
      return [
        { kind: 'series', source: !s.stat || s.stat === 'auto' ? { ...s, stat: 'state' } : s, range: cfg.range, interval: cfg.interval || 'auto', key: 's0' },
        { kind: 'scalar', source: { ...s, stat: 'current' }, range: 'today', key: 'cur' },
      ]
    },
    liveEntities: liveOf,
    Component: SparklineWidget,
  },
  {
    type: 'compare_chart',
    label: 'Vergleichsdiagramm',
    category: 'chart',
    icon: GitCompareArrows,
    description: 'Verlauf aktueller Zeitraum vs. Vergleichszeitraum',
    defaultSize: { w: 12, h: 7 },
    defaults: { rangeA: 'this_week', rangeB: 'last_week', interval: '1d', chartType: 'bar', labelA: 'Diese Woche', labelB: 'Letzte Woche', sources: [] },
    sources: 'single',
    dataFields: { interval: true, stat: true },
    fields: [
      { key: 'rangeA', label: 'Zeitraum A', type: 'range' },
      { key: 'labelA', label: 'Beschriftung A', type: 'text' },
      { key: 'rangeB', label: 'Zeitraum B', type: 'range' },
      { key: 'labelB', label: 'Beschriftung B', type: 'text' },
      { key: 'chartType', label: 'Darstellung', type: 'select', options: [{ value: 'bar', label: 'Balken' }, { value: 'line', label: 'Linien' }] },
      { key: 'compareColor', label: 'Farbe Vergleich', type: 'color' },
      { key: 'showLegend', label: 'Legende', type: 'bool' },
    ],
    requests: (cfg) => {
      const s = sourcesOf(cfg)[0]
      if (!s) return []
      return [
        { kind: 'series', source: s, range: cfg.rangeA || 'this_week', interval: cfg.interval || '1d', key: 'a' },
        { kind: 'series', source: s, range: cfg.rangeB || 'last_week', interval: cfg.interval || '1d', key: 'b' },
      ]
    },
    Component: CompareChartWidget,
  },
  // ---------------- energy
  {
    type: 'energy_flow',
    label: 'Energieflussdiagramm',
    category: 'energy',
    icon: Workflow,
    description: 'Live-Energiefluss zwischen Solar, Netz, Batterie und Haus',
    defaultSize: { w: 8, h: 9 },
    defaults: { showFlowLabels: true },
    sources: 'slots',
    slots: [
      { key: 'solar', label: 'Solarleistung (W)', stat: 'current' },
      { key: 'grid', label: 'Netzleistung (W, + Bezug / − Einspeisung)', hint: 'alternativ getrennte Entitäten unten', stat: 'current' },
      { key: 'grid_import', label: 'Netzbezug (W)', stat: 'current' },
      { key: 'grid_export', label: 'Netzeinspeisung (W)', stat: 'current' },
      { key: 'battery', label: 'Batterieleistung (W, + Laden / − Entladen)', stat: 'current' },
      { key: 'battery_soc', label: 'Batterie-Ladestand (%)', stat: 'current' },
      { key: 'home', label: 'Hausverbrauch (W, optional – sonst berechnet)', stat: 'current' },
    ],
    fields: [
      { key: 'invert_grid', label: 'Vorzeichen Netz umkehren', type: 'bool' },
      { key: 'invert_battery', label: 'Vorzeichen Batterie umkehren', type: 'bool' },
      { key: 'showFlowLabels', label: 'Werte an den Flüssen', type: 'bool' },
      { key: 'colorSolar', label: 'Farbe Solar', type: 'color' },
      { key: 'colorGrid', label: 'Farbe Netz', type: 'color' },
      { key: 'colorBattery', label: 'Farbe Batterie', type: 'color' },
      { key: 'colorHome', label: 'Farbe Haus', type: 'color' },
      { key: 'colorExport', label: 'Farbe Einspeisung', type: 'color' },
    ],
    requests: (cfg) =>
      slotReqs(
        cfg,
        ['solar', 'grid', 'grid_import', 'grid_export', 'battery', 'battery_soc', 'home'].map((k) => ({ key: k, label: k, stat: 'current' as const })),
        'today',
      ),
    liveEntities: liveOf,
    Component: EnergyFlowWidget,
  },
  sceneDef('scene_solar', 'Haus mit Solaranlage (animiert)', 'energy', Sun, 'Animierte Szene: Sonne, PV, Netz, Batterie, E-Auto mit Live-Werten', 'house_solar'),
  sceneDef('scene_heatpump', 'Wärmepumpe (animiert)', 'energy', Fan, 'Animierte Anlage: Lüfter, Vorlauf/Rücklauf, Puffer, Warmwasser, COP', 'heat_pump'),
  sceneDef('scene', 'Eigene animierte Szene (HTML/CSS)', 'other', Code2, 'Eigene Grafik mit HTML, SVG und CSS-Animationen, Werte per Platzhalter', 'custom'),
  powerCard('power', 'Stromverbrauch', PlugZap, 'Aktuelle Leistung, Tagesverbrauch und Verlauf'),
  {
    type: 'costs',
    label: 'Kostenübersicht',
    category: 'energy',
    icon: Coins,
    description: 'Kosten heute, Woche, Monat, Jahr',
    defaultSize: { w: 8, h: 5 },
    defaults: { decimals: 2, sources: [], periods: ['today', 'this_week', 'this_month', 'this_year'] },
    sources: 'multi',
    fields: [
      { key: 'price', label: 'Preis je Einheit (optional)', type: 'number', hint: 'Leer lassen, wenn die Quelle bereits Kosten liefert (z. B. Kennzahl „Stromkosten“)', step: 0.0001 },
    ],
    requests: (cfg) => {
      const periods: string[] = cfg.periods || ['today', 'this_week', 'this_month', 'this_year']
      const out: DataRequest[] = []
      sourcesOf(cfg).forEach((s, i) => periods.forEach((p) => out.push({ kind: 'scalar', source: s, range: p, key: `s${i}_${p}` })))
      return out
    },
    Component: CostsWidget,
  },
  {
    type: 'distribution',
    label: 'Verbrauchsverteilung',
    category: 'energy',
    icon: PieChart,
    description: 'Anteile einzelner Verbraucher am Gesamtverbrauch',
    defaultSize: { w: 10, h: 6 },
    defaults: { range: 'today', sources: [] },
    sources: 'multi_slots',
    slots: [{ key: 'total', label: 'Gesamtverbrauch (optional, für „Sonstige“)' }],
    dataFields: { range: true },
    fields: [],
    requests: (cfg) => {
      const r = scalarReqs(cfg)
      const t: Source | undefined = cfg.slots?.total
      if (t?.id) r.push({ kind: 'scalar', source: t, range: cfg.range, key: 'total' })
      return r
    },
    Component: DistributionWidget,
  },
  powerCard('solar', 'Solarproduktion', Sun, 'PV-Leistung live, Ertrag und Verlauf'),
  {
    type: 'self_consumption',
    label: 'Eigenverbrauch',
    category: 'energy',
    icon: Factory,
    description: 'Eigenverbrauchsquote und Autarkiegrad',
    defaultSize: { w: 8, h: 6 },
    defaults: { range: 'today' },
    sources: 'slots',
    slots: [
      { key: 'solar_energy', label: 'Solarertrag (kWh-Zähler)', required: true },
      { key: 'export_energy', label: 'Netzeinspeisung (kWh-Zähler)', required: true },
      { key: 'import_energy', label: 'Netzbezug (kWh-Zähler, für Autarkie)' },
      { key: 'home_energy', label: 'Hausverbrauch (kWh, optional)' },
    ],
    dataFields: { range: true },
    fields: [
      { key: 'color', label: 'Farbe Eigenverbrauch', type: 'color' },
      { key: 'color2', label: 'Farbe Autarkie', type: 'color' },
    ],
    requests: (cfg) =>
      slotReqs(cfg, ['solar_energy', 'export_energy', 'import_energy', 'home_energy'].map((k) => ({ key: k, label: k })), cfg.range || 'today'),
    Component: SelfConsumptionWidget,
  },
  powerCard('grid_import', 'Netzbezug', UtilityPole, 'Bezug aus dem Netz – live und kumuliert'),
  powerCard('grid_export', 'Netzeinspeisung', Zap, 'Einspeisung ins Netz – live und kumuliert'),
  // ---------------- other
  {
    type: 'table',
    label: 'Tabelle',
    category: 'other',
    icon: Table2,
    description: 'Aktuell, Min, Ø, Max und Summe mehrerer Quellen',
    defaultSize: { w: 10, h: 6 },
    defaults: { range: 'today', columns: ['current', 'min', 'mean', 'max', 'total'], sources: [] },
    sources: 'multi',
    dataFields: { range: true },
    fields: [],
    requests: (cfg) => {
      const cols: string[] = cfg.columns || ['current', 'min', 'mean', 'max', 'total']
      const out: DataRequest[] = []
      sourcesOf(cfg).forEach((s, i) =>
        cols.forEach((c) =>
          out.push({ kind: 'scalar', source: { ...s, stat: ({ current: 'current', min: 'min', mean: 'mean', max: 'max', total: 'auto', last: 'last' } as any)[c] }, range: cfg.range, key: `s${i}_${c}` }),
        ),
      )
      return out
    },
    liveEntities: liveOf,
    Component: TableWidget,
  },
  {
    type: 'history',
    label: 'Historische Daten',
    category: 'other',
    icon: History,
    description: 'Werte je Zeitabschnitt als Tabelle',
    defaultSize: { w: 8, h: 8 },
    defaults: { range: 'last_7d', interval: '1d', newestFirst: true, sources: [] },
    sources: 'multi',
    dataFields: { range: true, interval: true, stat: true },
    fields: [{ key: 'newestFirst', label: 'Neueste zuerst', type: 'bool' }],
    requests: seriesReqs,
    Component: HistoryWidget,
  },
  {
    type: 'stats',
    label: 'Statistikübersicht',
    category: 'other',
    icon: Sigma,
    description: 'Summe, Ø, Min, Max, Abdeckung eines Zeitraums',
    defaultSize: { w: 8, h: 6 },
    defaults: { range: 'this_month', sources: [] },
    sources: 'single',
    dataFields: { range: true },
    fields: [],
    requests: (cfg) => {
      const s = sourcesOf(cfg)[0]
      if (!s) return []
      const stats: [string, any][] = [['total', 'auto'], ['mean', 'mean'], ['min', 'min'], ['max', 'max'], ['last', 'last'], ['coverage', 'coverage']]
      return [
        ...stats.map(([k, st]) => ({ kind: 'scalar' as const, source: { ...s, stat: st }, range: cfg.range, key: k })),
        { kind: 'series' as const, source: { ...s, stat: 'auto' as const }, range: cfg.range, interval: '1d', key: 'daily' },
      ]
    },
    Component: StatsWidget,
  },
  {
    type: 'text',
    label: 'Text',
    category: 'other',
    icon: Type,
    description: 'Freitext mit Markdown und Live-Werten {{sensor.x}}',
    defaultSize: { w: 6, h: 4 },
    defaults: { text: '## Notiz\nText mit **Hervorhebung** und Live-Wert: {{sensor.example}}' },
    sources: 'none',
    fields: [
      { key: 'text', label: 'Inhalt (Markdown: # Überschrift, **fett**, *kursiv*, - Liste, [Link](https://…), {{entity_id}})', type: 'markdown' },
      { key: 'fontSize', label: 'Schriftgröße (px)', type: 'number', min: 8, max: 64 },
      { key: 'align', label: 'Ausrichtung', type: 'select', options: [{ value: 'left', label: 'Links' }, { value: 'center', label: 'Mitte' }, { value: 'right', label: 'Rechts' }] },
    ],
    requests: () => [],
    liveEntities: (cfg) => [...String(cfg.text || '').matchAll(/\{\{\s*([a-z_]+\.[a-z0-9_]+)\s*\}\}/g)].map((m) => m[1]),
    Component: TextWidget,
  },
  {
    type: 'heading',
    label: 'Überschrift',
    category: 'other',
    icon: Heading,
    description: 'Abschnittsüberschrift',
    defaultSize: { w: 12, h: 2 },
    defaults: { text: 'Abschnitt', underline: true },
    sources: 'none',
    fields: [
      { key: 'text', label: 'Text', type: 'text' },
      { key: 'subtitle', label: 'Untertitel', type: 'text' },
      { key: 'fontSize', label: 'Schriftgröße (px)', type: 'number', min: 10, max: 120, placeholder: 'automatisch' },
      { key: 'align', label: 'Ausrichtung', type: 'select', options: [{ value: 'left', label: 'Links' }, { value: 'center', label: 'Mitte' }, { value: 'right', label: 'Rechts' }] },
      { key: 'color', label: 'Farbe', type: 'color' },
      { key: 'uppercase', label: 'Großbuchstaben', type: 'bool' },
      { key: 'underline', label: 'Akzentlinie', type: 'bool' },
    ],
    requests: () => [],
    Component: HeadingWidget,
  },
  {
    type: 'image',
    label: 'Bild',
    category: 'other',
    icon: Image,
    description: 'Bild oder Grundriss (URL oder Upload)',
    defaultSize: { w: 6, h: 6 },
    defaults: { fit: 'cover' },
    sources: 'none',
    fields: [
      { key: 'url', label: 'Bild', type: 'image' },
      { key: 'fit', label: 'Einpassen', type: 'select', options: [{ value: 'cover', label: 'Füllen' }, { value: 'contain', label: 'Einpassen' }, { value: 'fill', label: 'Strecken' }] },
      { key: 'alt', label: 'Alternativtext', type: 'text' },
      { key: 'rounded', label: 'Abgerundete Ecken', type: 'bool' },
      { key: 'imageOpacity', label: 'Deckkraft', type: 'number', min: 0, max: 1, step: 0.05 },
    ],
    requests: () => [],
    Component: ImageWidget,
  },
  {
    type: 'clock',
    label: 'Datum/Uhrzeit',
    category: 'other',
    icon: Clock,
    description: 'Uhr und Datum',
    defaultSize: { w: 5, h: 3 },
    defaults: { mode: 'both', seconds: false },
    sources: 'none',
    fields: [
      { key: 'mode', label: 'Anzeige', type: 'select', options: [{ value: 'both', label: 'Uhrzeit und Datum' }, { value: 'time', label: 'Nur Uhrzeit' }, { value: 'date', label: 'Nur Datum' }] },
      { key: 'seconds', label: 'Sekunden', type: 'bool' },
      { key: 'year', label: 'Jahr anzeigen', type: 'bool' },
      { key: 'align', label: 'Ausrichtung', type: 'select', options: [{ value: 'center', label: 'Mitte' }, { value: 'left', label: 'Links' }] },
      { key: 'timezone', label: 'Zeitzone (optional)', type: 'text', placeholder: 'z. B. Europe/Berlin' },
    ],
    requests: () => [],
    Component: ClockWidget,
  },
  {
    type: 'info',
    label: 'Info-Karte',
    category: 'other',
    icon: Info,
    description: 'Hinweis mit Symbol, Text und optionalem Live-Wert',
    defaultSize: { w: 6, h: 3 },
    defaults: { icon: 'Info', tone: 'accent', headline: 'Hinweis', text: '' },
    sources: 'single',
    fields: [
      { key: 'icon', label: 'Symbol', type: 'select', options: ICON_OPTIONS },
      { key: 'tone', label: 'Farbton', type: 'select', options: [{ value: 'accent', label: 'Akzent' }, { value: 'ok', label: 'Grün' }, { value: 'warn', label: 'Gelb' }, { value: 'bad', label: 'Rot' }, { value: 'muted', label: 'Neutral' }] },
      { key: 'headline', label: 'Überschrift', type: 'text' },
      { key: 'text', label: 'Text', type: 'textarea' },
    ],
    requests: () => [],
    liveEntities: liveOf,
    Component: InfoWidget,
  },
  {
    type: 'analysis',
    label: 'Analyse-Ergebnis',
    category: 'other',
    icon: Lightbulb,
    description: 'Automatische Erkenntnisse aus den Messwerten',
    defaultSize: { w: 10, h: 6 },
    defaults: { maxItems: 6, days: 60, showSummary: true, sources: [] },
    sources: 'single',
    fields: [
      { key: 'days', label: 'Analysezeitraum (Tage)', type: 'number', min: 7, max: 730 },
      { key: 'maxItems', label: 'Max. Einträge', type: 'number', min: 1, max: 30 },
      { key: 'showSummary', label: 'Wochenzusammenfassung', type: 'bool' },
    ],
    requests: (cfg) => {
      const s = sourcesOf(cfg)[0]
      return s ? [{ kind: 'analysis', source: s, days: Number(cfg.days) || 60, key: 'analysis' }] : []
    },
    Component: AnalysisWidget,
  },
]

export const WIDGET_MAP: Record<string, WidgetDef> = Object.fromEntries(WIDGETS.map((w) => [w.type, w]))

export function widgetDef(type: string): WidgetDef | undefined {
  return WIDGET_MAP[type]
}

