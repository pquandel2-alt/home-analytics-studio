import { create } from 'zustand'
import { api } from '../api/client'
import type { Constant, EntityRow, Metric } from '../api/types'

interface Catalog {
  entities: EntityRow[]
  metrics: Metric[]
  constants: Constant[]
  areas: string[]
  loaded: boolean
  loading: boolean
  load: (force?: boolean) => Promise<void>
}

let inflight: Promise<void> | null = null

export const useCatalog = create<Catalog>((set, get) => ({
  entities: [],
  metrics: [],
  constants: [],
  areas: [],
  loaded: false,
  loading: false,
  load: async (force = false) => {
    if (get().loaded && !force) return
    if (inflight) return inflight
    set({ loading: true })
    inflight = (async () => {
      try {
        const [ents, metrics, constants] = await Promise.all([
          api.get<{ entities: EntityRow[]; areas: string[] }>('entities'),
          api.get<Metric[]>('metrics'),
          api.get<Constant[]>('constants').catch(() => [] as Constant[]),
        ])
        set({ entities: ents.entities, areas: ents.areas, metrics, constants, loaded: true })
      } finally {
        set({ loading: false })
        inflight = null
      }
    })()
    return inflight
  },
}))

export function entityName(id: string): string {
  return useCatalog.getState().entities.find((e) => e.entity_id === id)?.name || id
}
