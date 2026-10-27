import clsx from 'clsx'
import { EyeOff, Lock } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Responsive, type Layout } from 'react-grid-layout'
import type { Breakpoint, DashboardSettings, Widget } from '../api/types'
import WidgetFrame from '../widgets/WidgetFrame'
import { BREAKPOINTS, type Layouts } from './editorStore'

export const PREVIEW_WIDTH: Record<Breakpoint, number> = { xxl: 2560, xl: 1920, lg: 1440, md: 1024, sm: 768, xs: 390 }

interface Props {
  widgets: Widget[]
  layouts: Layouts
  settings: DashboardSettings
  editing?: boolean
  selected?: string[]
  previewBp?: Breakpoint | null
  onSelect?: (id: string | null, additive: boolean) => void
  onLayoutChange?: (all: Layouts) => void
  onInteractionStart?: () => void
  onBreakpoint?: (bp: Breakpoint) => void
  minHeight?: number
  fitHeight?: number | null
}

function useContainerWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver((e) => setW(Math.floor(e[0].contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return { ref, width: w }
}

export default function GridCanvas({ widgets, layouts, settings, editing, selected = [], previewBp, onSelect, onLayoutChange, onInteractionStart, onBreakpoint, minHeight, fitHeight }: Props) {
  const { ref, width: available } = useContainerWidth()
  const grid = settings.grid
  const margin = grid.margin ?? 12
  const width = previewBp ? PREVIEW_WIDTH[previewBp] : available
  const scale = previewBp && available ? Math.min(1, available / width) : 1
  const bpForWidth = (w: number): Breakpoint => (Object.entries(BREAKPOINTS) as [Breakpoint, number][]).sort((a, b) => b[1] - a[1]).find(([, min]) => w >= min)?.[0] || 'xs'
  const activeBp = bpForWidth(width)
  const cols = grid.cols[activeBp]
  const colWidth = (width - margin * (cols + 1)) / cols

  // Presentation "fit to screen": compute row height so the page fills the viewport height
  let rowHeight = grid.rowHeight || 40
  if (fitHeight) {
    const items = layouts[activeBp] || []
    const rows = Math.max(1, items.reduce((m, l) => Math.max(m, l.y + l.h), 0))
    rowHeight = Math.max(12, (fitHeight - margin * (rows + 1)) / rows)
  }

  const visible = editing ? widgets : widgets.filter((w) => !w.hidden)
  const lockedIds = new Set(widgets.filter((w) => w.locked).map((w) => w.id))
  const rglLayouts = useMemo(() => {
    const out: Record<string, Layout[]> = {}
    for (const [bp, items] of Object.entries(layouts)) {
      out[bp] = (items || []).map((l) => ({ ...l, static: editing ? lockedIds.has(l.i) : true }))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layouts, editing, widgets])

  useEffect(() => {
    onBreakpoint?.(activeBp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBp])

  const compact = grid.compact === 'none' ? null : grid.compact || null

  return (
    <div ref={ref} className="w-full" style={{ minHeight }} onMouseDown={(e) => editing && e.target === e.currentTarget && onSelect?.(null, false)}>
      {width > 0 && (
        <div
          className={clsx('relative mx-auto', editing && grid.snap !== false && 'editor-grid-bg')}
          style={{
            width,
            transform: scale !== 1 ? `scale(${scale})` : undefined,
            transformOrigin: 'top left',
            backgroundSize: editing ? `${colWidth + margin}px ${rowHeight + margin}px` : undefined,
            backgroundPosition: editing ? `${margin / 2}px ${margin / 2}px` : undefined,
            minHeight: editing ? 400 : undefined,
          }}
          onMouseDown={(e) => {
            if (editing && (e.target as HTMLElement).classList.contains('react-grid-layout')) onSelect?.(null, false)
          }}
        >
          <Responsive
            className="layout"
            width={width}
            layouts={rglLayouts}
            breakpoints={BREAKPOINTS}
            cols={grid.cols}
            rowHeight={rowHeight}
            margin={[margin, margin]}
            containerPadding={[margin, margin]}
            compactType={compact as any}
            allowOverlap={!!grid.allowOverlap}
            preventCollision={!compact && !grid.allowOverlap}
            isDraggable={!!editing}
            isResizable={!!editing}
            isBounded={false}
            transformScale={scale}
            resizeHandles={['se', 'e', 's']}
            draggableCancel=".no-drag"
            useCSSTransforms
            onDragStart={() => onInteractionStart?.()}
            onResizeStart={() => onInteractionStart?.()}
            onLayoutChange={(_cur: Layout[], all: Record<string, Layout[]>) => editing && onLayoutChange?.(all as Layouts)}
          >
            {visible.map((w) => {
              const z = widgets.indexOf(w) + 1
              return (
                <div
                  key={w.id}
                  style={{ zIndex: z }}
                  className={clsx(editing && 'cursor-move', editing && w.hidden && 'opacity-40')}
                  onMouseDown={(e) => {
                    if (!editing) return
                    e.stopPropagation()
                    onSelect?.(w.id, e.shiftKey || e.metaKey || e.ctrlKey)
                  }}
                >
                  <WidgetFrame widget={w} editing={editing} selected={editing && selected.includes(w.id)} />
                  {editing && (w.locked || w.hidden) && (
                    <div className="absolute right-2 top-2 flex gap-1 text-muted">
                      {w.locked && <Lock className="h-3.5 w-3.5" />}
                      {w.hidden && <EyeOff className="h-3.5 w-3.5" />}
                    </div>
                  )}
                </div>
              )
            })}
          </Responsive>
        </div>
      )}
    </div>
  )
}
