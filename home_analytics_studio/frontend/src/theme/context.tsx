import { createContext, useContext } from 'react'
import type { ThemeTokens } from '../api/types'
import { presetById } from './presets'

export const ThemeContext = createContext<ThemeTokens>(presetById('dark-analytics').tokens)

export function useThemeTokens(): ThemeTokens {
  return useContext(ThemeContext)
}

export interface DashboardRuntime {
  timezone?: string
  currency: string
  editing: boolean
  refreshNonce: number
}

export const RuntimeContext = createContext<DashboardRuntime>({ currency: '€', editing: false, refreshNonce: 0 })

export function useRuntime(): DashboardRuntime {
  return useContext(RuntimeContext)
}
