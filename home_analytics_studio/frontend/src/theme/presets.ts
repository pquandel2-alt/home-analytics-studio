import type { ThemeSpec, ThemeTokens } from '../api/types'

export const FONTS: { value: string; label: string }[] = [
  { value: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif", label: 'System (modern)' },
  { value: "'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif", label: 'Inter / Sans' },
  { value: "'Eurostile', 'Bank Gothic', 'Orbitron', 'Rajdhani', 'Segoe UI', sans-serif", label: 'Futuristisch' },
  { value: "'JetBrains Mono', 'Fira Code', 'SFMono-Regular', Menlo, Consolas, monospace", label: 'Monospace' },
  { value: "'Avenir Next', 'Avenir', 'Nunito', 'Segoe UI', sans-serif", label: 'Rund / Freundlich' },
  { value: "Georgia, 'Times New Roman', serif", label: 'Serif' },
]

const base: ThemeTokens = {
  mode: 'dark',
  accent: '#22d3ee',
  accent2: '#a855f7',
  background: '#0b1020',
  backgroundGradient: '',
  backgroundImage: '',
  backgroundOverlay: 0.4,
  backgroundBlur: 0,
  surface: '#121a2e',
  surfaceOpacity: 0.9,
  glassBlur: 0,
  text: '#e6edf7',
  muted: '#8b98b0',
  border: '#2a3550',
  borderWidth: 1,
  borderOpacity: 0.7,
  radius: 16,
  shadow: 'md',
  font: FONTS[0].value,
  fontScale: 1,
  titleWeight: 600,
  palette: ['#22d3ee', '#a855f7', '#34d399', '#fbbf24', '#f472b6', '#60a5fa', '#fb7185', '#a3e635'],
  animations: true,
  glow: false,
  gridLines: true,
}

export interface Preset {
  id: string
  name: string
  description: string
  tokens: ThemeTokens
}

export const PRESETS: Preset[] = [
  {
    id: 'dark-analytics',
    name: 'Dark Analytics',
    description: 'Ruhiges Dunkelblau mit klaren Cyan/Violett-Akzenten',
    tokens: { ...base, backgroundGradient: 'radial-gradient(1200px 600px at 10% -10%, rgba(34,211,238,0.10), transparent), radial-gradient(900px 500px at 110% 10%, rgba(168,85,247,0.10), transparent)' },
  },
  {
    id: 'modern-minimal',
    name: 'Modern Minimal',
    description: 'Hell, viel Weißraum, dezente Schatten',
    tokens: {
      ...base,
      mode: 'light',
      accent: '#2563eb',
      accent2: '#0ea5e9',
      background: '#f4f6fa',
      backgroundGradient: '',
      surface: '#ffffff',
      surfaceOpacity: 1,
      text: '#0f172a',
      muted: '#64748b',
      border: '#e2e8f0',
      borderOpacity: 1,
      radius: 14,
      shadow: 'sm',
      palette: ['#2563eb', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#64748b'],
    },
  },
  {
    id: 'futuristic-neon',
    name: 'Futuristic Neon',
    description: 'Sci-Fi-Look mit Neon-Leuchten und kantigen Formen',
    tokens: {
      ...base,
      accent: '#00f5d4',
      accent2: '#f15bb5',
      background: '#05010f',
      backgroundGradient: 'linear-gradient(135deg, rgba(0,245,212,0.08) 0%, transparent 40%), linear-gradient(315deg, rgba(241,91,181,0.10) 0%, transparent 45%), repeating-linear-gradient(0deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 40px), repeating-linear-gradient(90deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 40px)',
      surface: '#0d0b1f',
      surfaceOpacity: 0.78,
      glassBlur: 6,
      text: '#e8fffb',
      muted: '#8a86b5',
      border: '#00f5d4',
      borderOpacity: 0.35,
      radius: 6,
      shadow: 'glow',
      font: FONTS[2].value,
      palette: ['#00f5d4', '#f15bb5', '#fee440', '#00bbf9', '#9b5de5', '#ff6b6b', '#7bf1a8', '#ffa62b'],
      glow: true,
    },
  },
  {
    id: 'glass-dashboard',
    name: 'Glass Dashboard',
    description: 'Glassmorphism mit Farbverlauf-Hintergrund',
    tokens: {
      ...base,
      accent: '#93c5fd',
      accent2: '#f0abfc',
      background: '#1e1b4b',
      backgroundGradient: 'linear-gradient(135deg, #1e3a8a 0%, #6d28d9 45%, #db2777 100%)',
      surface: '#ffffff',
      surfaceOpacity: 0.12,
      glassBlur: 18,
      text: '#ffffff',
      muted: '#dbe4ff',
      border: '#ffffff',
      borderOpacity: 0.25,
      radius: 22,
      shadow: 'lg',
      palette: ['#93c5fd', '#f0abfc', '#86efac', '#fde68a', '#fca5a5', '#c4b5fd', '#67e8f9', '#fdba74'],
    },
  },
  {
    id: 'energy-control-center',
    name: 'Energy Control Center',
    description: 'Leitstand-Optik in Grün/Amber für Energiedaten',
    tokens: {
      ...base,
      accent: '#4ade80',
      accent2: '#fbbf24',
      background: '#07110d',
      backgroundGradient: 'radial-gradient(1000px 500px at 50% -20%, rgba(74,222,128,0.12), transparent), radial-gradient(800px 400px at 100% 120%, rgba(251,191,36,0.08), transparent)',
      surface: '#0c1a14',
      surfaceOpacity: 0.92,
      text: '#e7f7ee',
      muted: '#86a596',
      border: '#1f3b2e',
      radius: 12,
      shadow: 'md',
      font: FONTS[3].value,
      palette: ['#4ade80', '#fbbf24', '#38bdf8', '#f87171', '#a78bfa', '#2dd4bf', '#facc15', '#fb923c'],
    },
  },
  {
    id: 'nordic-light',
    name: 'Nordic Light',
    description: 'Helle Pastelltöne, weich und freundlich',
    tokens: {
      ...base,
      mode: 'light',
      accent: '#0f766e',
      accent2: '#c2410c',
      background: '#eef2ef',
      backgroundGradient: 'linear-gradient(180deg, #f5f7f4 0%, #e8eee9 100%)',
      surface: '#fbfcfa',
      surfaceOpacity: 1,
      text: '#1f2a24',
      muted: '#6b7a71',
      border: '#d5ddd7',
      borderOpacity: 1,
      radius: 20,
      shadow: 'sm',
      font: FONTS[4].value,
      palette: ['#0f766e', '#c2410c', '#4d7c0f', '#b45309', '#1d4ed8', '#be185d', '#0e7490', '#57534e'],
    },
  },
  {
    id: 'midnight-oled',
    name: 'Midnight OLED',
    description: 'Tiefschwarz für Wanddisplays und Fernseher',
    tokens: {
      ...base,
      accent: '#f97316',
      accent2: '#38bdf8',
      background: '#000000',
      backgroundGradient: '',
      surface: '#0a0a0a',
      surfaceOpacity: 1,
      text: '#f5f5f5',
      muted: '#8a8a8a',
      border: '#1f1f1f',
      radius: 18,
      shadow: 'none',
      palette: ['#f97316', '#38bdf8', '#a3e635', '#e879f9', '#facc15', '#f43f5e', '#2dd4bf', '#94a3b8'],
    },
  },
]

export function presetById(id?: string | null): Preset {
  return PRESETS.find((p) => p.id === id) || PRESETS[0]
}

export function resolveTheme(...specs: (ThemeSpec | undefined | null)[]): ThemeTokens {
  let tokens: ThemeTokens = { ...presetById(undefined).tokens }
  for (const spec of specs) {
    if (!spec) continue
    if (spec.preset) tokens = { ...presetById(spec.preset).tokens }
    if (spec.overrides) {
      for (const [k, v] of Object.entries(spec.overrides)) {
        if (v !== undefined && v !== null && v !== '') (tokens as any)[k] = v
      }
    }
  }
  return tokens
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = (hex || '').trim().replace('#', '')
  if (h.startsWith('rgb')) {
    const m = h.match(/\d+(\.\d+)?/g) || []
    return [Number(m[0] || 0), Number(m[1] || 0), Number(m[2] || 0)]
  }
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h.slice(0, 6) || '0', 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbVar(hex: string): string {
  return hexToRgb(hex).join(' ')
}

export function withAlpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

const SHADOWS: Record<string, string> = {
  none: 'none',
  sm: '0 1px 2px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.08)',
  md: '0 4px 14px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.12)',
  lg: '0 12px 40px rgba(0,0,0,0.28), 0 2px 8px rgba(0,0,0,0.12)',
}

export function shadowFor(kind: string, accent: string): string {
  if (kind === 'glow') return `0 0 0 1px ${withAlpha(accent, 0.25)}, 0 0 18px ${withAlpha(accent, 0.25)}, inset 0 0 24px ${withAlpha(accent, 0.05)}`
  return SHADOWS[kind] ?? SHADOWS.md
}

/** CSS custom properties for a resolved theme. */
export function themeVars(t: ThemeTokens): Record<string, string> {
  const ok = t.mode === 'light' ? '#16a34a' : '#4ade80'
  const warn = t.mode === 'light' ? '#d97706' : '#fbbf24'
  const bad = t.mode === 'light' ? '#dc2626' : '#f87171'
  const elevated = t.mode === 'light' ? '#ffffff' : t.surface
  return {
    '--c-accent': rgbVar(t.accent),
    '--c-accent2': rgbVar(t.accent2),
    '--c-bg': rgbVar(t.background),
    '--c-surface': rgbVar(t.surface),
    '--c-elevated': rgbVar(elevated),
    '--c-text': rgbVar(t.text),
    '--c-muted': rgbVar(t.muted),
    '--c-border': rgbVar(t.border),
    '--c-ok': rgbVar(ok),
    '--c-warn': rgbVar(warn),
    '--c-bad': rgbVar(bad),
    '--surface-alpha': String(t.surfaceOpacity),
    '--border-alpha': String(t.borderOpacity),
    '--border-width': `${t.borderWidth}px`,
    '--glass-blur': `${t.glassBlur}px`,
    '--radius': `${t.radius}px`,
    '--shadow': shadowFor(t.shadow, t.accent),
    '--font': t.font,
    '--font-scale': String(t.fontScale),
    '--title-weight': String(t.titleWeight),
    '--bg-gradient': t.backgroundGradient || 'none',
  }
}

export function applyThemeToElement(el: HTMLElement, t: ThemeTokens) {
  const vars = themeVars(t)
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
  el.classList.toggle('dark', t.mode === 'dark')
  el.classList.toggle('no-anim', !t.animations)
}
