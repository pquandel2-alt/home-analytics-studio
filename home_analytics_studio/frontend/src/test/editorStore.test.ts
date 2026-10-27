import { beforeEach, describe, expect, it } from 'vitest'
import { BP_ORDER, DEFAULT_COLS, completeLayouts, useEditor } from '../dashboard/editorStore'

const st = () => useEditor.getState()

describe('dashboard editor store', () => {
  beforeEach(() => {
    localStorage.clear()
    st().load(1, [], {}, DEFAULT_COLS)
  })

  it('adds widgets with a position on every breakpoint', () => {
    const id = st().addWidget('value', { w: 6, h: 3 }, { range: 'today' }, 'Strom')
    for (const bp of BP_ORDER) {
      const item = st().layouts[bp]!.find((l) => l.i === id)!
      expect(item).toBeDefined()
      expect(item.w).toBeLessThanOrEqual(DEFAULT_COLS[bp])
    }
    expect(st().layouts.xs![0].w).toBe(DEFAULT_COLS.xs) // stacked on phones
    expect(st().selected).toEqual([id])
    expect(st().rev).toBe(1)
  })

  it('stacks new widgets below existing ones', () => {
    const a = st().addWidget('value', { w: 6, h: 3 })
    const b = st().addWidget('value', { w: 6, h: 4 })
    const la = st().layouts.lg!.find((l) => l.i === a)!
    const lb = st().layouts.lg!.find((l) => l.i === b)!
    expect(lb.y).toBe(la.y + la.h)
  })

  it('undo and redo restore widgets and layouts', () => {
    const id = st().addWidget('line', { w: 12, h: 6 })
    st().updateWidget({ ...st().widgets[0], title: 'Neu' })
    expect(st().widgets[0].title).toBe('Neu')
    st().undo()
    expect(st().widgets[0].title).toBeUndefined()
    st().undo()
    expect(st().widgets).toHaveLength(0)
    st().redo()
    expect(st().widgets[0].id).toBe(id)
    st().redo()
    expect(st().widgets[0].title).toBe('Neu')
  })

  it('a new change clears the redo stack', () => {
    st().addWidget('line', { w: 12, h: 6 })
    st().undo()
    expect(st().future).toHaveLength(1)
    st().addWidget('bar', { w: 12, h: 6 })
    expect(st().future).toHaveLength(0)
  })

  it('duplicate creates independent copies', () => {
    st().addWidget('value', { w: 4, h: 3 }, { range: 'today' })
    st().duplicateSelected()
    expect(st().widgets).toHaveLength(2)
    const [a, b] = st().widgets
    expect(a.id).not.toBe(b.id)
    b.config.range = 'yesterday'
    expect(a.config.range).toBe('today')
  })

  it('copy and paste works across pages via localStorage', () => {
    st().addWidget('gauge', { w: 5, h: 6 }, { max: 50 }, 'Gauge')
    expect(st().copySelected()).toBe(1)
    st().load(2, [], {}, DEFAULT_COLS) // another page
    expect(st().paste()).toBe(1)
    expect(st().widgets[0].type).toBe('gauge')
    expect(st().widgets[0].config.max).toBe(50)
    expect(st().layouts.lg![0].h).toBe(6)
  })

  it('removes selected widgets but respects locks', () => {
    const a = st().addWidget('value', { w: 4, h: 3 })
    const b = st().addWidget('value', { w: 4, h: 3 })
    st().toggle(a, 'locked')
    st().select(a)
    st().select(b, true)
    st().removeSelected()
    expect(st().widgets.map((w) => w.id)).toEqual([a])
    expect(st().layouts.lg!.map((l) => l.i)).toEqual([a])
  })

  it('layer order changes z-order', () => {
    const a = st().addWidget('value', { w: 4, h: 3 })
    const b = st().addWidget('value', { w: 4, h: 3 })
    st().reorder(a, 'top')
    expect(st().widgets.map((w) => w.id)).toEqual([b, a])
    st().reorder(a, 'down')
    expect(st().widgets.map((w) => w.id)).toEqual([a, b])
  })

  it('aligns and distributes selected widgets', () => {
    const ids = [0, 1, 2].map(() => st().addWidget('value', { w: 4, h: 2 }))
    st().setBreakpoint('lg')
    const lay = st().layouts.lg!.map((l, i) => ({ ...l, x: [2, 8, 20][i], y: [0, 3, 6][i] }))
    st().setLayouts({ ...st().layouts, lg: lay }, true)
    ids.forEach((id, i) => st().select(id, i > 0))
    st().align('top')
    expect(new Set(st().layouts.lg!.map((l) => l.y)).size).toBe(1)
    st().align('left')
    expect(st().layouts.lg!.every((l) => l.x === 2)).toBe(true)
    const lay2 = st().layouts.lg!.map((l, i) => ({ ...l, x: [0, 5, 20][i] }))
    st().setLayouts({ ...st().layouts, lg: lay2 }, true)
    st().align('distributeH')
    const xs = st().layouts.lg!.map((l) => l.x).sort((a, b) => a - b)
    expect(xs[1] - xs[0]).toBe(xs[2] - xs[1])
  })

  it('drag checkpoint only records history when the layout changed', () => {
    st().addWidget('value', { w: 4, h: 3 })
    const past = st().past.length
    st().checkpoint()
    st().setLayouts(st().layouts, false) // click without movement
    expect(st().past.length).toBe(past)
    st().checkpoint()
    const moved = { ...st().layouts, lg: st().layouts.lg!.map((l) => ({ ...l, x: 5 })) }
    st().setLayouts(moved, false)
    expect(st().past.length).toBe(past + 1)
    st().undo()
    expect(st().layouts.lg![0].x).toBe(0)
  })

  it('completeLayouts fills missing breakpoints from the desktop layout', () => {
    const widgets = [{ id: 'a', type: 'value', config: {} }]
    const out = completeLayouts(widgets, { lg: [{ i: 'a', x: 12, y: 2, w: 12, h: 4 }] }, DEFAULT_COLS)
    expect(out.xl![0]).toMatchObject({ x: 12, w: 12 })
    expect(out.md![0]).toMatchObject({ x: 8, w: 8 })
    expect(out.xs![0]).toMatchObject({ x: 0, w: 4 })
  })
})
