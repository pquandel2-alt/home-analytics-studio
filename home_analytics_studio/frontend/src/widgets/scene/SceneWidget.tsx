import { useEffect, useMemo, useRef } from 'react'
import { useLiveEntities } from '../../api/live'
import type { ScalarResult } from '../../api/types'
import { useThemeTokens } from '../../theme/context'
import { withAlpha } from '../../theme/presets'
import { rangeLabel } from '../../utils/format'
import { NeedsConfig } from '../common'
import type { BatchResult, WidgetProps } from '../types'
import { buildSrcdoc, computeScene, isLiveVar, labelKey, sceneCode, sceneVars, stateNumber, type RawValue, type SceneCode, type SceneLabel, type VarPayload } from './engine'

/** Current values of all scene variables: live entities via websocket, everything else from the batch results. */
export function useSceneValues(cfg: Record<string, any>, results: Record<string, BatchResult>): Record<string, VarPayload> {
  const vars = useMemo(() => sceneVars(cfg), [cfg])
  const liveIds = vars.filter(isLiveVar).map((v) => v.source!.id)
  const states = useLiveEntities(liveIds)
  const raw: Record<string, RawValue> = {}
  for (const v of vars) {
    if (!v.source?.id) continue
    if (isLiveVar(v)) {
      const st = states[v.source.id]
      raw[v.key] = { v: stateNumber(st?.state), s: st?.state ?? null, unit: st?.attributes?.unit_of_measurement ?? null }
    } else {
      const r = results[`v_${v.key}`]
      const d = r?.ok ? (r.data as ScalarResult) : undefined
      raw[v.key] = { v: d?.value ?? null, unit: d?.unit ?? null }
    }
  }
  const rawKey = JSON.stringify(raw)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => computeScene(vars, raw), [vars, rawKey])
}

function useThemeVars(): Record<string, string> {
  const t = useThemeTokens()
  return useMemo(() => {
    const safe = (c: string, a: number) => (/^#[0-9a-f]{6}$/i.test(c) ? withAlpha(c, a) : c)
    return {
      text: t.text,
      muted: t.muted,
      accent: t.accent,
      accent2: t.accent2,
      surface: t.surface,
      border: t.border,
      font: t.font,
      'chip-bg': safe(t.surface, Math.min(0.92, Math.max(0.7, t.surfaceOpacity))),
      line: safe(t.border, 0.55),
      wall: safe(t.text, t.mode === 'dark' ? 0.05 : 0.04),
      'wall-strong': safe(t.text, t.mode === 'dark' ? 0.1 : 0.08),
      'wall-stroke': safe(t.text, 0.35),
      good: '#34d399',
      bad: '#f87171',
      warn: '#fbbf24',
    }
  }, [t])
}

interface FrameProps {
  code: SceneCode
  vars: Record<string, VarPayload>
  labels: SceneLabel[]
  anim: boolean
  range: string
  edit?: boolean
  onLabelMove?: (id: string, x: number, y: number) => void
}

/** Sandboxed renderer: the document only changes when the code changes; values are pushed via postMessage. */
export function SceneFrame({ code, vars, labels, anim, range, edit, onLabelMove }: FrameProps) {
  const ref = useRef<HTMLIFrameElement>(null)
  const theme = useThemeVars()
  const srcdoc = useMemo(() => buildSrcdoc(code), [code.html, code.css, code.w, code.h, code.allowJs]) // eslint-disable-line react-hooks/exhaustive-deps
  const msg = useMemo(
    () => ({
      type: 'has-values',
      vars,
      theme,
      anim,
      edit: !!edit,
      range,
      labels: labels.map((l) => ({ id: l.id, key: labelKey(l.id), title: l.title || '', x: l.x, y: l.y, size: l.size, color: l.color })),
    }),
    [vars, theme, anim, edit, range, labels],
  )
  const msgRef = useRef(msg)
  msgRef.current = msg
  const moveRef = useRef(onLabelMove)
  moveRef.current = onLabelMove

  useEffect(() => {
    ref.current?.contentWindow?.postMessage(msg, '*')
  }, [msg])

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return
      const d = e.data
      if (d?.type === 'has-ready') ref.current.contentWindow?.postMessage(msgRef.current, '*')
      else if (d?.type === 'has-label-move' && typeof d.id === 'string' && Number.isFinite(d.x) && Number.isFinite(d.y)) {
        moveRef.current?.(d.id, Math.min(1, Math.max(0, d.x)), Math.min(1, Math.max(0, d.y)))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  return (
    <iframe
      ref={ref}
      title="Szene"
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      className="block h-full w-full border-0 bg-transparent"
      style={{ colorScheme: 'normal', pointerEvents: edit ? 'auto' : 'none' }}
    />
  )
}

export function sceneRangeLabel(cfg: Record<string, any>): string {
  const l = rangeLabel(cfg.range || 'today')
  return l ? l.charAt(0).toLowerCase() + l.slice(1) : ''
}

export function SceneWidget({ cfg, results }: WidgetProps) {
  const theme = useThemeTokens()
  const code = sceneCode(cfg)
  const vars = useSceneValues(cfg, results)
  const labels: SceneLabel[] = cfg.labels || []
  if (cfg.template === 'custom' && !code.html.trim()) return <NeedsConfig text="Eigenen HTML/SVG-Code im Editor eingeben oder eine Vorlage wählen" />
  return <SceneFrame code={code} vars={vars} labels={labels} anim={cfg.animation !== false && theme.animations} range={sceneRangeLabel(cfg)} />
}
