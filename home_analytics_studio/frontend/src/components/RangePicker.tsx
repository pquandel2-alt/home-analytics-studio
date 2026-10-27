import type { RangeSpec } from '../api/types'
import { RANGE_PRESETS } from '../utils/format'
import { Input, Select } from './ui'

type Mode = 'preset' | 'last' | 'custom'

function modeOf(v: RangeSpec | undefined): Mode {
  if (!v || typeof v === 'string') return 'preset'
  if (v.last) return 'last'
  if (v.start) return 'custom'
  return 'preset'
}

export default function RangePicker({ value, onChange }: { value: RangeSpec | undefined; onChange: (v: RangeSpec) => void }) {
  const mode = modeOf(value)
  const preset = typeof value === 'string' ? value : (value as any)?.preset || 'today'
  const obj = (typeof value === 'object' && value) || {}
  return (
    <div className="space-y-2">
      <Select
        value={mode}
        onChange={(m) => {
          if (m === 'preset') onChange('today')
          else if (m === 'last') onChange({ last: '7d' })
          else {
            const end = new Date()
            const start = new Date(end.getTime() - 7 * 86400000)
            const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
            onChange({ start: iso(start), end: iso(end) })
          }
        }}
        options={[
          { value: 'preset', label: 'Vordefinierter Zeitraum' },
          { value: 'last', label: 'Letzte … (gleitend)' },
          { value: 'custom', label: 'Fester Zeitraum' },
        ]}
      />
      {mode === 'preset' && (
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Select value={preset} onChange={(p) => onChange(obj.offset ? { preset: p, offset: obj.offset } : p)} options={RANGE_PRESETS} />
          <Input
            className="w-24"
            placeholder="Versatz"
            title="Optionaler Versatz, z. B. -7d (gleicher Zeitraum eine Woche früher)"
            value={obj.offset || ''}
            onChange={(e) => onChange(e.target.value ? { preset, offset: e.target.value } : preset)}
          />
        </div>
      )}
      {mode === 'last' && <Input value={obj.last || ''} placeholder="z. B. 6h, 3d, 2w" onChange={(e) => onChange({ last: e.target.value })} />}
      {mode === 'custom' && (
        <div className="grid grid-cols-2 gap-2">
          <Input type="datetime-local" value={String(obj.start || '')} onChange={(e) => onChange({ ...obj, start: e.target.value })} />
          <Input type="datetime-local" value={String(obj.end || '')} onChange={(e) => onChange({ ...obj, end: e.target.value })} />
        </div>
      )}
    </div>
  )
}
