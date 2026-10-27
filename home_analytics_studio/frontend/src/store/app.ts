import { create } from 'zustand'
import { api, setCsrf } from '../api/client'
import type { AuthStatus, ThemeSpec } from '../api/types'

export interface AppearanceInfo {
  appearance: { preset: string; overrides: Record<string, any> }
  general: { instance_name: string; currency: string; language: string; default_dashboard: number | null }
  timezone: string
  presentation: { interval_seconds: number; refresh_seconds: number; show_clock: boolean }
  base_url?: string
}

interface AppStore {
  status: AuthStatus | null
  appearance: AppearanceInfo | null
  loading: boolean
  error: string | null
  loadStatus: () => Promise<AuthStatus | null>
  loadAppearance: () => Promise<void>
  setAppearanceLocal: (spec: ThemeSpec) => void
}

export const useApp = create<AppStore>((set, get) => ({
  status: null,
  appearance: null,
  loading: true,
  error: null,
  loadStatus: async () => {
    try {
      const status = await api.get<AuthStatus>('auth/status')
      setCsrf(status.csrf)
      set({ status, loading: false, error: null })
      return status
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) })
      return null
    }
  },
  loadAppearance: async () => {
    try {
      const appearance = await api.get<AppearanceInfo>('appearance')
      set({ appearance })
    } catch {
      /* not logged in */
    }
  },
  setAppearanceLocal: (spec) => {
    const a = get().appearance
    if (a) set({ appearance: { ...a, appearance: { preset: spec.preset || a.appearance.preset, overrides: spec.overrides || {} } } })
  },
}))

export function hasRole(role: 'viewer' | 'editor' | 'admin'): boolean {
  const u = useApp.getState().status?.user
  if (!u) return false
  const lv = { viewer: 0, editor: 1, admin: 2 }
  return lv[u.role] >= lv[role]
}

export function useRole(role: 'viewer' | 'editor' | 'admin'): boolean {
  const u = useApp((s) => s.status?.user)
  if (!u) return false
  const lv = { viewer: 0, editor: 1, admin: 2 }
  return lv[u.role] >= lv[role]
}
