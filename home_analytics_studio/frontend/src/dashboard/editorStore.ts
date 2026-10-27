import { create } from 'zustand'
import type { Breakpoint, LayoutItem, Widget } from '../api/types'
import { uid } from '../utils/format'

export const BREAKPOINTS: Record<Breakpoint, number> = { xxl: 2400, xl: 1800, lg: 1200, md: 900, sm: 600, xs: 0 }
export const BP_ORDER: Breakpoint[] = ['xxl', 'xl', 'lg', 'md', 'sm', 'xs']
export const BP_LABELS: Record<Breakpoint, string> = {
  xxl: 'Fernseher / 4K',
  xl: 'Großer Monitor',
  lg: 'Desktop',
  md: 'Tablet quer',
  sm: 'Tablet hoch',
  xs: 'Smartphone',
}
export const DEFAULT_COLS: Record<Breakpoint, number> = { xxl: 32, xl: 24, lg: 24, md: 16, sm: 8, xs: 4 }

export type Layouts = Partial<Record<Breakpoint, LayoutItem[]>>

interface Snapshot {
  widgets: Widget[]
  layouts: Layouts
}

export interface EditorState {
  pageId: number | null
  widgets: Widget[]
  layouts: Layouts
  cols: Record<Breakpoint, number>
  selected: string[]
  past: Snapshot[]
  future: Snapshot[]
  rev: number
  savedRev: number
  breakpoint: Breakpoint
  load: (pageId: number, widgets: Widget[], layouts: Layouts, cols?: Record<Breakpoint, number>) => void
  setBreakpoint: (bp: Breakpoint) => void
  select: (id: string | null, additive?: boolean) => void
  selectAll: () => void
  addWidget: (type: string, size: { w: number; h: number }, config?: Record<string, any>, title?: string) => string
  updateWidget: (w: Widget) => void
  removeSelected: () => void
  duplicateSelected: () => void
  copySelected: () => number
  paste: () => number
  setLayouts: (layouts: Layouts, record: boolean) => void
  checkpoint: () => void
  reorder: (id: string, dir: 'up' | 'down' | 'top' | 'bottom') => void
  toggle: (id: string, key: 'hidden' | 'locked') => void
  align: (kind: AlignKind) => void
  undo: () => void
  redo: () => void
  markSaved: (rev: number) => void
}

export type AlignKind = 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter' | 'sameWidth' | 'sameHeight' | 'distributeH' | 'distributeV'

const CLIPBOARD_KEY = 'has-widget-clipboard'
const HISTORY_LIMIT = 100

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v))
}

function maxY(items: LayoutItem[] = []): number {
  return items.reduce((m, it) => Math.max(m, it.y + it.h), 0)
}

/** Fill missing breakpoint layouts with scaled copies so every widget has a position everywhere. */
export function completeLayouts(widgets: Widget[], layouts: Layouts, cols: Record<Breakpoint, number>): Layouts {
  const out: Layouts = {}
  const ref = (layouts.lg || layouts.xl || layouts.md || Object.values(layouts)[0] || []) as LayoutItem[]
  const refCols = layouts.lg ? cols.lg : layouts.xl ? cols.xl : layouts.md ? cols.md : cols.lg
  for (const bp of BP_ORDER) {
    const existing = (layouts[bp] || []).filter((l) => widgets.some((w) => w.id === l.i))
    const items = [...existing]
    for (const w of widgets) {
      if (items.some((l) => l.i === w.id)) continue
      const r = ref.find((l) => l.i === w.id)
      const scale = cols[bp] / refCols
      if (bp === 'xs' || bp === 'sm') {
        // stack on narrow screens
        const h = r ? r.h : 4
        items.push({ i: w.id, x: 0, y: maxY(items), w: cols[bp], h })
      } else if (r) {
        const ww = Math.max(1, Math.min(cols[bp], Math.round(r.w * scale)))
        items.push({ i: w.id, x: Math.min(cols[bp] - ww, Math.round(r.x * scale)), y: r.y, w: ww, h: r.h })
      } else {
        items.push({ i: w.id, x: 0, y: maxY(items), w: Math.min(cols[bp], 6), h: 4 })
      }
    }
    out[bp] = items.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
  }
  return out
}

let pendingSnap: Snapshot | null = null

export const useEditor = create<EditorState>((set, get) => {
  const snapshot = (): Snapshot => clone({ widgets: get().widgets, layouts: get().layouts })
  const commit = (next: Partial<Snapshot> & Partial<EditorState>, record = true) => {
    const s = get()
    set({
      ...next,
      past: record ? [...s.past, snapshot()].slice(-HISTORY_LIMIT) : s.past,
      future: record ? [] : s.future,
      rev: s.rev + 1,
    })
  }

  return {
    pageId: null,
    widgets: [],
    layouts: {},
    cols: DEFAULT_COLS,
    selected: [],
    past: [],
    future: [],
    rev: 0,
    savedRev: 0,
    breakpoint: 'lg',

    load: (pageId, widgets, layouts, cols = DEFAULT_COLS) => {
      const w = clone(widgets || [])
      set({ pageId, widgets: w, layouts: completeLayouts(w, clone(layouts || {}), cols), cols, selected: [], past: [], future: [], rev: 0, savedRev: 0 })
    },

    setBreakpoint: (bp) => set({ breakpoint: bp }),

    select: (id, additive) => {
      if (!id) return set({ selected: [] })
      const cur = get().selected
      if (additive) set({ selected: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
      else set({ selected: [id] })
    },

    selectAll: () => set({ selected: get().widgets.map((w) => w.id) }),

    addWidget: (type, size, config = {}, title) => {
      const s = get()
      const id = uid('w')
      const widget: Widget = { id, type, title, config: clone(config), style: {} }
      const layouts: Layouts = {}
      for (const bp of BP_ORDER) {
        const items = s.layouts[bp] || []
        const c = s.cols[bp]
        const w = bp === 'xs' || bp === 'sm' ? c : Math.max(1, Math.min(c, Math.round((size.w * c) / s.cols.lg)))
        layouts[bp] = [...items, { i: id, x: 0, y: maxY(items), w, h: size.h }]
      }
      commit({ widgets: [...s.widgets, widget], layouts, selected: [id] })
      return id
    },

    updateWidget: (w) => {
      const s = get()
      commit({ widgets: s.widgets.map((x) => (x.id === w.id ? clone(w) : x)) })
    },

    removeSelected: () => {
      const s = get()
      const sel = s.selected.filter((id) => !s.widgets.find((w) => w.id === id)?.locked)
      if (!sel.length) return
      const layouts: Layouts = {}
      for (const bp of BP_ORDER) layouts[bp] = (s.layouts[bp] || []).filter((l) => !sel.includes(l.i))
      commit({ widgets: s.widgets.filter((w) => !sel.includes(w.id)), layouts, selected: [] })
    },

    duplicateSelected: () => {
      const s = get()
      if (!s.selected.length) return
      const newWidgets: Widget[] = []
      const layouts: Layouts = clone(s.layouts)
      const newIds: string[] = []
      for (const id of s.selected) {
        const w = s.widgets.find((x) => x.id === id)
        if (!w) continue
        const nid = uid('w')
        newIds.push(nid)
        newWidgets.push({ ...clone(w), id: nid, locked: false })
        for (const bp of BP_ORDER) {
          const l = (layouts[bp] || []).find((x) => x.i === id)
          if (l) layouts[bp]!.push({ ...l, i: nid, y: maxY(layouts[bp]) })
        }
      }
      commit({ widgets: [...s.widgets, ...newWidgets], layouts, selected: newIds })
    },

    copySelected: () => {
      const s = get()
      const items = s.selected
        .map((id) => {
          const w = s.widgets.find((x) => x.id === id)
          const l = (s.layouts[s.breakpoint] || s.layouts.lg || []).find((x) => x.i === id)
          return w ? { widget: w, w: l?.w ?? 6, h: l?.h ?? 4 } : null
        })
        .filter(Boolean)
      if (items.length) localStorage.setItem(CLIPBOARD_KEY, JSON.stringify({ items, cols: s.cols[s.breakpoint] }))
      return items.length
    },

    paste: () => {
      const raw = localStorage.getItem(CLIPBOARD_KEY)
      if (!raw) return 0
      let data: { items: { widget: Widget; w: number; h: number }[]; cols: number }
      try {
        data = JSON.parse(raw)
      } catch {
        return 0
      }
      const s = get()
      const layouts: Layouts = clone(s.layouts)
      const widgets = [...s.widgets]
      const ids: string[] = []
      for (const it of data.items) {
        const id = uid('w')
        ids.push(id)
        widgets.push({ ...clone(it.widget), id, locked: false, hidden: false })
        for (const bp of BP_ORDER) {
          const c = s.cols[bp]
          const w = bp === 'xs' || bp === 'sm' ? c : Math.max(1, Math.min(c, Math.round((it.w * c) / (data.cols || c))))
          layouts[bp] = [...(layouts[bp] || []), { i: id, x: 0, y: maxY(layouts[bp]), w, h: it.h }]
        }
      }
      commit({ widgets, layouts, selected: ids })
      return ids.length
    },

    setLayouts: (incoming, record) => {
      const s = get()
      // keep "static" flag in sync with locked widgets, ignore unknown items
      const layouts: Layouts = {}
      for (const bp of BP_ORDER) {
        const items = (incoming[bp] || s.layouts[bp] || []).filter((l) => s.widgets.some((w) => w.id === l.i))
        layouts[bp] = items.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))
      }
      if (JSON.stringify(layouts) === JSON.stringify(s.layouts)) return
      if (!record && pendingSnap) {
        const snap = pendingSnap
        pendingSnap = null
        set({ layouts, past: [...s.past, snap].slice(-HISTORY_LIMIT), future: [], rev: s.rev + 1 })
        return
      }
      commit({ layouts }, record)
    },

    checkpoint: () => {
      // remembered and only pushed to history if the drag/resize actually changes the layout
      pendingSnap = snapshot()
    },

    reorder: (id, dir) => {
      const s = get()
      const idx = s.widgets.findIndex((w) => w.id === id)
      if (idx < 0) return
      const list = [...s.widgets]
      const [w] = list.splice(idx, 1)
      const target = dir === 'up' ? Math.min(list.length, idx + 1) : dir === 'down' ? Math.max(0, idx - 1) : dir === 'top' ? list.length : 0
      list.splice(target, 0, w)
      commit({ widgets: list })
    },

    toggle: (id, key) => {
      const s = get()
      commit({ widgets: s.widgets.map((w) => (w.id === id ? { ...w, [key]: !w[key] } : w)) })
    },

    align: (kind) => {
      const s = get()
      const bp = s.breakpoint
      const items = (s.layouts[bp] || []).map((l) => ({ ...l }))
      const sel = items.filter((l) => s.selected.includes(l.i))
      if (sel.length < 2 && !['left', 'right', 'hcenter'].includes(kind)) return
      if (!sel.length) return
      const cols = s.cols[bp]
      const minX = Math.min(...sel.map((l) => l.x))
      const maxX = Math.max(...sel.map((l) => l.x + l.w))
      const minY = Math.min(...sel.map((l) => l.y))
      const maxYv = Math.max(...sel.map((l) => l.y + l.h))
      switch (kind) {
        case 'left':
          sel.forEach((l) => (l.x = sel.length === 1 ? 0 : minX))
          break
        case 'right':
          sel.forEach((l) => (l.x = (sel.length === 1 ? cols : maxX) - l.w))
          break
        case 'hcenter': {
          const center = sel.length === 1 ? cols / 2 : (minX + maxX) / 2
          sel.forEach((l) => (l.x = Math.max(0, Math.round(center - l.w / 2))))
          break
        }
        case 'top':
          sel.forEach((l) => (l.y = minY))
          break
        case 'bottom':
          sel.forEach((l) => (l.y = maxYv - l.h))
          break
        case 'vcenter': {
          const c = (minY + maxYv) / 2
          sel.forEach((l) => (l.y = Math.max(0, Math.round(c - l.h / 2))))
          break
        }
        case 'sameWidth': {
          const w = sel[0].w
          sel.forEach((l) => (l.w = Math.min(w, cols - l.x)))
          break
        }
        case 'sameHeight': {
          const h = sel[0].h
          sel.forEach((l) => (l.h = h))
          break
        }
        case 'distributeH': {
          const sorted = [...sel].sort((a, b) => a.x - b.x)
          const total = sorted.reduce((a, l) => a + l.w, 0)
          const gap = Math.max(0, (maxX - minX - total) / Math.max(1, sorted.length - 1))
          let x = minX
          sorted.forEach((l) => {
            l.x = Math.round(x)
            x += l.w + gap
          })
          break
        }
        case 'distributeV': {
          const sorted = [...sel].sort((a, b) => a.y - b.y)
          const total = sorted.reduce((a, l) => a + l.h, 0)
          const gap = Math.max(0, (maxYv - minY - total) / Math.max(1, sorted.length - 1))
          let y = minY
          sorted.forEach((l) => {
            l.y = Math.round(y)
            y += l.h + gap
          })
          break
        }
      }
      commit({ layouts: { ...s.layouts, [bp]: items } })
    },

    undo: () => {
      const s = get()
      const prev = s.past[s.past.length - 1]
      if (!prev) return
      set({ ...clone(prev), past: s.past.slice(0, -1), future: [snapshot(), ...s.future], rev: s.rev + 1, selected: s.selected.filter((id) => prev.widgets.some((w) => w.id === id)) })
    },

    redo: () => {
      const s = get()
      const next = s.future[0]
      if (!next) return
      set({ ...clone(next), past: [...s.past, snapshot()], future: s.future.slice(1), rev: s.rev + 1 })
    },

    markSaved: (rev) => set({ savedRev: rev }),
  }
})
