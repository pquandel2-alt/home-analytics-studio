export type Role = 'viewer' | 'editor' | 'admin'

export interface User {
  id: number | null
  username: string
  role: Role
  kind: 'login' | 'ingress' | 'share' | 'api'
  share_dashboard_id: number | null
}

export interface AuthStatus {
  authenticated: boolean
  user: User | null
  csrf: string | null
  setup_required: boolean
  ingress: boolean
  supervisor: boolean
  direct_login_allowed: boolean
  instance_name: string
}

export type SourceType = 'entity' | 'metric' | 'formula'
export type Stat = 'auto' | 'state' | 'mean' | 'min' | 'max' | 'first' | 'last' | 'delta' | 'count' | 'coverage' | 'current'

export interface Source {
  type: SourceType
  id: string
  stat?: Stat
  label?: string
  color?: string
  formula?: string
  unit?: string
}

export type RangeSpec = string | { preset?: string; last?: string; start?: string | number; end?: string | number; offset?: string }

export interface SeriesResult {
  source: Source
  start: number
  end: number
  interval: string
  ts: number[]
  values: (number | null)[]
  min: (number | null)[] | null
  max: (number | null)[] | null
  coverage: (number | null)[] | null
  unit: string | null
  kind: string
  name: string
}

export interface ScalarResult {
  value: number | null
  unit: string | null
  start: number
  end: number
  coverage: number | null
  name: string
  ts?: number | null
  count?: number
}

export interface Insight {
  id: string
  severity: 'info' | 'up' | 'down' | 'warning'
  text: string
  data: unknown
  incomplete: boolean
}

export interface Comparison {
  period: string
  label: string
  previous_label: string
  current: number | null
  previous: number | null
  previous_same_elapsed: number | null
  change_pct: number | null
  change_abs: number | null
  current_coverage: number | null
  previous_coverage: number | null
  elapsed_fraction: number
}

export interface AnalysisResult {
  source: Source
  name: string
  unit: string | null
  comparisons: Record<string, Comparison>
  stats: Record<string, any>
  insights: Insight[]
  daily: { ts: number[]; values: (number | null)[]; coverage: (number | null)[] }
}

export interface EntityRow {
  entity_id: string
  domain: string
  name: string
  state: string | null
  numeric: boolean
  available: boolean
  unit: string | null
  device_class: string | null
  state_class: string | null
  area: string | null
  device: string | null
  last_changed: string | null
  kind_auto: string
  kind: string
  recorded: boolean
  samples: number
  bytes: number
  last_ts: number | null
  last_value: number | null
  stored_unit: string | null
  retention_days: number | null
  in_ha: boolean
  hidden: boolean
}

export interface Metric {
  id: number
  name: string
  key: string
  description: string | null
  formula: string
  unit: string | null
  aggregation: string
  decimals: number
  color: string | null
  builder: any
}

export interface Constant {
  id?: number
  key: string
  name: string | null
  value: number
  unit: string | null
  description: string | null
}

export interface LayoutItem {
  i: string
  x: number
  y: number
  w: number
  h: number
  minW?: number
  minH?: number
  static?: boolean
}

export type Breakpoint = 'xxl' | 'xl' | 'lg' | 'md' | 'sm' | 'xs'

export interface WidgetStyle {
  background?: string
  opacity?: number
  blur?: number
  borderColor?: string
  borderWidth?: number
  radius?: number
  shadow?: 'theme' | 'none' | 'sm' | 'md' | 'lg' | 'glow'
  padding?: number
  textColor?: string
  titleAlign?: 'left' | 'center' | 'right'
  titleSize?: number
  hideTitle?: boolean
  accent?: string
}

export interface Widget {
  id: string
  type: string
  title?: string
  config: Record<string, any>
  style?: WidgetStyle
  hidden?: boolean
  locked?: boolean
}

export interface Page {
  id: number
  dashboard_id: number
  title: string
  icon: string | null
  sort: number
  hidden: number | boolean
  settings: Record<string, any>
  widgets: Widget[]
  layouts: Partial<Record<Breakpoint, LayoutItem[]>>
  version: number
}

export interface DashboardSettings {
  grid: {
    cols: Record<Breakpoint, number>
    rowHeight: number
    margin: number
    compact: 'none' | 'vertical' | 'horizontal'
    allowOverlap: boolean
    snap: boolean
  }
  navigation: { position: 'top' | 'side' | 'bottom' | 'hidden'; style: 'tabs' | 'pills' | 'minimal'; showTitle: boolean }
  presentation: { interval: number; refresh: number; transition: 'fade' | 'slide' | 'zoom' | 'none'; pages: 'all' | number[]; showClock: boolean }
}

export interface Dashboard {
  id: number
  name: string
  description: string | null
  icon: string | null
  sort: number
  theme: ThemeSpec
  settings: DashboardSettings
  pages: Page[]
  page_count?: number
  updated_at?: number
}

export interface ThemeSpec {
  preset?: string
  overrides?: Partial<ThemeTokens>
}

export interface ThemeTokens {
  mode: 'dark' | 'light'
  accent: string
  accent2: string
  background: string
  backgroundGradient: string
  backgroundImage: string
  backgroundOverlay: number
  backgroundBlur: number
  surface: string
  surfaceOpacity: number
  glassBlur: number
  text: string
  muted: string
  border: string
  borderWidth: number
  borderOpacity: number
  radius: number
  shadow: 'none' | 'sm' | 'md' | 'lg' | 'glow'
  font: string
  fontScale: number
  titleWeight: number
  palette: string[]
  animations: boolean
  glow: boolean
  gridLines: boolean
}

export interface Job {
  id: number
  type: string
  status: string
  progress: number
  message: string | null
  params: any
  result: any
  created_at: number
  updated_at: number
}

export interface HAStatus {
  state: string
  error: string | null
  ha_version: string | null
  connected_since: number | null
  reconnects: number
  endpoint: string | null
  entity_count?: number
}
