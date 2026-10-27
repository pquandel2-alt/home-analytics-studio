import clsx from 'clsx'
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  Lock,
  Monitor,
  MoveHorizontal,
  MoveVertical,
  Redo2,
  Search,
  Smartphone,
  Tablet,
  TabletSmartphone,
  Trash2,
  Tv,
  Undo2,
  Unlock,
  Laptop,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Breakpoint } from '../api/types'
import { IconButton, Input } from '../components/ui'
import { WIDGETS } from '../widgets/registry'
import { CATEGORY_LABELS } from '../widgets/types'
import { BP_LABELS, useEditor } from './editorStore'

export function WidgetPalette({ onAdd }: { onAdd: (type: string) => void }) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const t = q.toLowerCase()
    const list = WIDGETS.filter((w) => !t || `${w.label} ${w.description}`.toLowerCase().includes(t))
    return (Object.keys(CATEGORY_LABELS) as (keyof typeof CATEGORY_LABELS)[]).map((c) => ({ cat: c, items: list.filter((w) => w.category === c) }))
  }, [q])
  return (
    <div className="flex h-full flex-col">
      <div className="relative mb-3">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted" />
        <Input className="pl-9" placeholder="Widget suchen…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {groups.map(
          (g) =>
            g.items.length > 0 && (
              <div key={g.cat}>
                <div className="label">{CATEGORY_LABELS[g.cat]}</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {g.items.map((w) => (
                    <button
                      key={w.type}
                      title={w.description}
                      onClick={() => onAdd(w.type)}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/has-widget', w.type)}
                      className="flex flex-col items-start gap-1 rounded-lg border border-line/50 bg-bg/40 p-2 text-left text-xs transition hover:border-accent/70 hover:bg-accent/10"
                    >
                      <w.icon className="h-4 w-4 text-accent" />
                      <span className="leading-tight">{w.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ),
        )}
      </div>
    </div>
  )
}

export function LayersPanel() {
  const { widgets, selected, select, reorder, toggle } = useEditor()
  const list = [...widgets].reverse() // topmost first
  if (!list.length) return <p className="text-sm text-muted">Noch keine Widgets auf dieser Seite.</p>
  return (
    <div className="space-y-1">
      {list.map((w) => {
        const def = WIDGETS.find((d) => d.type === w.type)
        const Icon = def?.icon
        return (
          <div
            key={w.id}
            className={clsx('flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm', selected.includes(w.id) ? 'bg-accent/15 text-accent' : 'hover:bg-fg/5')}
          >
            <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={(e) => select(w.id, e.shiftKey || e.metaKey || e.ctrlKey)}>
              {Icon && <Icon className="h-4 w-4 shrink-0" />}
              <span className={clsx('truncate', w.hidden && 'opacity-50')}>{w.title || def?.label || w.type}</span>
            </button>
            <IconButton title="Eine Ebene nach vorne" onClick={() => reorder(w.id, 'up')} className="h-6 w-6">
              <ChevronUp className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton title="Eine Ebene nach hinten" onClick={() => reorder(w.id, 'down')} className="h-6 w-6">
              <ChevronDown className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton title={w.hidden ? 'Einblenden' : 'Ausblenden'} onClick={() => toggle(w.id, 'hidden')} className="h-6 w-6">
              {w.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </IconButton>
            <IconButton title={w.locked ? 'Entsperren' : 'Sperren'} onClick={() => toggle(w.id, 'locked')} className="h-6 w-6">
              {w.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
            </IconButton>
          </div>
        )
      })}
    </div>
  )
}

const BP_ICONS: Record<Breakpoint, any> = { xxl: Tv, xl: Monitor, lg: Laptop, md: TabletSmartphone, sm: Tablet, xs: Smartphone }

export function EditorToolbar({ previewBp, setPreviewBp, onCopy, onPaste }: { previewBp: Breakpoint | null; setPreviewBp: (bp: Breakpoint | null) => void; onCopy: () => void; onPaste: () => void }) {
  const { undo, redo, past, future, selected, removeSelected, duplicateSelected, align, reorder } = useEditor()
  const hasSel = selected.length > 0
  const multi = selected.length > 1
  const sep = <div className="mx-1 h-6 w-px bg-line/60" />
  return (
    <div className="flex flex-wrap items-center gap-0.5">
      <IconButton title="Rückgängig (Strg+Z)" disabled={!past.length} onClick={undo}>
        <Undo2 className="h-4 w-4" />
      </IconButton>
      <IconButton title="Wiederherstellen (Strg+Y)" disabled={!future.length} onClick={redo}>
        <Redo2 className="h-4 w-4" />
      </IconButton>
      {sep}
      <IconButton title="Kopieren (Strg+C)" disabled={!hasSel} onClick={onCopy}>
        <Copy className="h-4 w-4" />
      </IconButton>
      <IconButton title="Einfügen (Strg+V)" onClick={onPaste}>
        <ClipboardPaste className="h-4 w-4" />
      </IconButton>
      <IconButton title="Duplizieren (Strg+D)" disabled={!hasSel} onClick={duplicateSelected}>
        <CopyPlus className="h-4 w-4" />
      </IconButton>
      <IconButton title="Löschen (Entf)" disabled={!hasSel} onClick={removeSelected}>
        <Trash2 className="h-4 w-4" />
      </IconButton>
      {sep}
      <IconButton title="In den Vordergrund" disabled={selected.length !== 1} onClick={() => reorder(selected[0], 'top')}>
        <ArrowUpToLine className="h-4 w-4" />
      </IconButton>
      <IconButton title="In den Hintergrund" disabled={selected.length !== 1} onClick={() => reorder(selected[0], 'bottom')}>
        <ArrowDownToLine className="h-4 w-4" />
      </IconButton>
      {sep}
      <IconButton title="Links ausrichten" disabled={!hasSel} onClick={() => align('left')}>
        <AlignStartVertical className="h-4 w-4" />
      </IconButton>
      <IconButton title="Horizontal zentrieren" disabled={!hasSel} onClick={() => align('hcenter')}>
        <AlignCenterVertical className="h-4 w-4" />
      </IconButton>
      <IconButton title="Rechts ausrichten" disabled={!hasSel} onClick={() => align('right')}>
        <AlignEndVertical className="h-4 w-4" />
      </IconButton>
      <IconButton title="Oben ausrichten" disabled={!multi} onClick={() => align('top')}>
        <AlignStartHorizontal className="h-4 w-4" />
      </IconButton>
      <IconButton title="Vertikal zentrieren" disabled={!multi} onClick={() => align('vcenter')}>
        <AlignCenterHorizontal className="h-4 w-4" />
      </IconButton>
      <IconButton title="Unten ausrichten" disabled={!multi} onClick={() => align('bottom')}>
        <AlignEndHorizontal className="h-4 w-4" />
      </IconButton>
      <IconButton title="Gleiche Breite" disabled={!multi} onClick={() => align('sameWidth')}>
        <MoveHorizontal className="h-4 w-4" />
      </IconButton>
      <IconButton title="Gleiche Höhe" disabled={!multi} onClick={() => align('sameHeight')}>
        <MoveVertical className="h-4 w-4" />
      </IconButton>
      <IconButton title="Horizontal verteilen" disabled={selected.length < 3} onClick={() => align('distributeH')}>
        <AlignHorizontalDistributeCenter className="h-4 w-4" />
      </IconButton>
      <IconButton title="Vertikal verteilen" disabled={selected.length < 3} onClick={() => align('distributeV')}>
        <AlignVerticalDistributeCenter className="h-4 w-4" />
      </IconButton>
      {sep}
      <span className="px-1 text-xs text-muted">Layout:</span>
      <IconButton title="Automatisch (Fensterbreite)" active={previewBp === null} onClick={() => setPreviewBp(null)}>
        <span className="text-[10px] font-bold">AUTO</span>
      </IconButton>
      {(Object.keys(BP_LABELS) as Breakpoint[]).map((bp) => {
        const I = BP_ICONS[bp]
        return (
          <IconButton key={bp} title={`${BP_LABELS[bp]} bearbeiten / Vorschau`} active={previewBp === bp} onClick={() => setPreviewBp(bp)}>
            <I className="h-4 w-4" />
          </IconButton>
        )
      })}
    </div>
  )
}
