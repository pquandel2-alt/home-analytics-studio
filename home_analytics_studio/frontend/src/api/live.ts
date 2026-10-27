import { create } from 'zustand'
import { useEffect } from 'react'
import { wsUrl } from './client'
import type { HAStatus, Job } from './types'

export interface LiveState {
  entity_id: string
  state: string | null
  last_changed: string | null
  last_updated: string | null
  attributes: Record<string, any>
}

interface LiveStore {
  connected: boolean
  states: Record<string, LiveState | null>
  haStatus: HAStatus | null
  jobs: Record<number, Job>
  setStates: (s: Record<string, LiveState | null>) => void
}

export const useLive = create<LiveStore>((set) => ({
  connected: false,
  states: {},
  haStatus: null,
  jobs: {},
  setStates: (s) => set((st) => ({ states: { ...st.states, ...s } })),
}))

class LiveConnection {
  private ws: WebSocket | null = null
  private refs = new Map<string, number>()
  private retry = 0
  private timer: number | null = null
  private stopped = true
  private pending: Record<string, LiveState | null> = {}
  private flushScheduled = false

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.connect()
  }

  stop() {
    this.stopped = true
    if (this.timer) window.clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
  }

  restart() {
    this.stop()
    this.start()
  }

  private connect() {
    if (this.stopped) return
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      useLive.setState({ connected: true })
      const ids = [...this.refs.keys()]
      if (ids.length) ws.send(JSON.stringify({ type: 'subscribe', entities: ids }))
    }
    ws.onmessage = (ev) => {
      let data: any
      try {
        data = JSON.parse(ev.data)
      } catch {
        return
      }
      for (const msg of Array.isArray(data) ? data : [data]) this.handle(msg)
    }
    ws.onclose = () => {
      useLive.setState({ connected: false })
      this.ws = null
      this.scheduleReconnect()
    }
    ws.onerror = () => ws.close()
  }

  private scheduleReconnect() {
    if (this.stopped) return
    const delay = Math.min(30000, 1000 * 2 ** this.retry++)
    this.timer = window.setTimeout(() => this.connect(), delay)
  }

  private handle(msg: any) {
    switch (msg.type) {
      case 'hello':
        useLive.setState({ haStatus: msg.ha_status })
        break
      case 'ha_status':
        useLive.setState({ haStatus: msg.status })
        break
      case 'states':
        Object.assign(this.pending, msg.states)
        this.scheduleFlush()
        break
      case 'state':
        this.pending[msg.entity_id] = msg.state
        this.scheduleFlush()
        break
      case 'job':
        useLive.setState((s) => ({ jobs: { ...s.jobs, [msg.job.id]: msg.job } }))
        break
    }
  }

  // batch many state updates into one render
  private scheduleFlush() {
    if (this.flushScheduled) return
    this.flushScheduled = true
    window.setTimeout(() => {
      this.flushScheduled = false
      const batch = this.pending
      this.pending = {}
      useLive.getState().setStates(batch)
    }, 150)
  }

  subscribe(ids: string[]) {
    const fresh: string[] = []
    for (const id of ids) {
      const n = this.refs.get(id) || 0
      this.refs.set(id, n + 1)
      if (n === 0) fresh.push(id)
    }
    if (fresh.length && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe', entities: fresh }))
    }
  }

  unsubscribe(ids: string[]) {
    const gone: string[] = []
    for (const id of ids) {
      const n = (this.refs.get(id) || 0) - 1
      if (n <= 0) {
        this.refs.delete(id)
        gone.push(id)
      } else this.refs.set(id, n)
    }
    if (gone.length && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', entities: gone }))
    }
  }
}

export const live = new LiveConnection()

/** Subscribe to live states of entities while the component is mounted. */
export function useLiveEntities(ids: string[]) {
  const key = [...new Set(ids.filter(Boolean))].sort().join(',')
  useEffect(() => {
    if (!key) return
    const list = key.split(',')
    live.subscribe(list)
    return () => live.unsubscribe(list)
  }, [key])
  return useLive((s) => s.states)
}

export function numericState(s: LiveState | null | undefined): number | null {
  if (!s || s.state == null) return null
  const v = Number(s.state)
  return Number.isFinite(v) ? v : null
}
