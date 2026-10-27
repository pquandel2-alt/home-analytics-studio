import type { LucideIcon } from 'lucide-react'
import type React from 'react'
import type { RangeSpec, Source, Widget } from '../api/types'

export type FieldType =
  | 'text'
  | 'textarea'
  | 'markdown'
  | 'number'
  | 'select'
  | 'bool'
  | 'color'
  | 'range'
  | 'interval'
  | 'thresholds'
  | 'image'
  | 'stat'

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  step?: number
  placeholder?: string
  hint?: string
  showIf?: (cfg: Record<string, any>) => boolean
}

export interface SlotDef {
  key: string
  label: string
  hint?: string
  required?: boolean
  /** default stat for this slot */
  stat?: Source['stat']
}

export interface DataRequest {
  kind: 'series' | 'scalar' | 'analysis' | 'compare'
  source: Source
  range?: RangeSpec
  interval?: string
  period?: string
  days?: number
  /** client side key to find the result */
  key: string
}

export interface BatchResult<T = any> {
  ok: boolean
  data?: T
  error?: string
}

export interface WidgetProps {
  widget: Widget
  cfg: Record<string, any>
  results: Record<string, BatchResult>
  loading: boolean
  width: number
  height: number
}

export type SourceMode = 'none' | 'single' | 'multi' | 'slots' | 'multi_slots'

export interface WidgetDef {
  type: string
  label: string
  category: 'kpi' | 'chart' | 'energy' | 'other'
  icon: LucideIcon
  description: string
  defaultSize: { w: number; h: number }
  minSize?: { w: number; h: number }
  defaults: Record<string, any>
  sources: SourceMode
  slots?: SlotDef[]
  /** which common data fields the editor shows */
  dataFields?: { range?: boolean; interval?: boolean; stat?: boolean }
  fields: FieldDef[]
  requests: (cfg: Record<string, any>) => DataRequest[]
  /** entity ids that should be subscribed for live updates */
  liveEntities?: (cfg: Record<string, any>) => string[]
  Component: React.FC<WidgetProps>
}

export const CATEGORY_LABELS: Record<WidgetDef['category'], string> = {
  kpi: 'Kennzahlen',
  chart: 'Diagramme',
  energy: 'Energie',
  other: 'Weitere',
}
