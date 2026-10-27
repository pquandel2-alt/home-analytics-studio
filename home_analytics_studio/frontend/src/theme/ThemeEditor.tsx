import clsx from 'clsx'
import { Plus, RotateCcw, Trash2, Upload } from 'lucide-react'
import { useRef } from 'react'
import { api, assetUrl } from '../api/client'
import type { ThemeSpec, ThemeTokens } from '../api/types'
import { Button, ColorInput, Field, IconButton, Input, Select, Slider, Switch, toast } from '../components/ui'
import { FONTS, PRESETS, resolveTheme, shadowFor, withAlpha } from './presets'

function PresetCard({ id, active, onClick }: { id: string; active: boolean; onClick: () => void }) {
  const p = PRESETS.find((x) => x.id === id)!
  const t = p.tokens
  return (
    <button
      onClick={onClick}
      className={clsx('group overflow-hidden rounded-xl border text-left transition', active ? 'border-accent ring-2 ring-accent/40' : 'border-line/60 hover:border-accent/60')}
    >
      <div className="relative h-20 p-2" style={{ background: t.background, backgroundImage: t.backgroundGradient || undefined }}>
        <div className="grid h-full grid-cols-3 gap-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={clsx(i === 0 && 'col-span-2')}
              style={{
                background: withAlpha(t.surface, t.surfaceOpacity),
                border: `1px solid ${withAlpha(t.border, t.borderOpacity)}`,
                borderRadius: Math.min(10, t.radius / 2),
                boxShadow: shadowFor(t.shadow, t.accent),
                backdropFilter: `blur(${t.glassBlur}px)`,
              }}
            >
              <div className="m-1.5 h-1.5 w-1/2 rounded" style={{ background: t.palette[i] }} />
            </div>
          ))}
        </div>
      </div>
      <div className="bg-surface/80 px-3 py-2">
        <div className="text-sm font-medium">{p.name}</div>
        <div className="line-clamp-1 text-[11px] text-muted">{p.description}</div>
      </div>
    </button>
  )
}

export default function ThemeEditor({ value, onChange, base }: { value: ThemeSpec; onChange: (v: ThemeSpec) => void; base?: ThemeSpec }) {
  const resolved: ThemeTokens = resolveTheme(base, value)
  const ov = value.overrides || {}
  const set = <K extends keyof ThemeTokens>(k: K, v: ThemeTokens[K] | undefined) => {
    const next = { ...ov, [k]: v }
    if (v === undefined || v === '') delete (next as any)[k]
    onChange({ ...value, overrides: next })
  }
  const fileRef = useRef<HTMLInputElement>(null)
  const upload = async (f: File) => {
    const fd = new FormData()
    fd.append('file', f)
    try {
      const res = await api.post<{ url: string }>('uploads', fd)
      set('backgroundImage', res.url)
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <div className="space-y-6">
      <div>
        <div className="label">Design-Preset</div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {PRESETS.map((p) => (
            <PresetCard key={p.id} id={p.id} active={(value.preset || base?.preset) === p.id} onClick={() => onChange({ preset: p.id, overrides: {} })} />
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">Jedes Preset lässt sich unten beliebig anpassen. Anpassungen gelten nur für dieses Ziel (global bzw. Dashboard).</p>
      </div>

      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        <Field label="Modus">
          <Select value={resolved.mode} onChange={(v) => set('mode', v as any)} options={[{ value: 'dark', label: 'Dunkel' }, { value: 'light', label: 'Hell' }]} />
        </Field>
        <Field label="Schriftart">
          <Select value={resolved.font} onChange={(v) => set('font', v)} options={FONTS} />
        </Field>
        <Field label="Akzentfarbe">
          <ColorInput value={ov.accent || resolved.accent} onChange={(v) => set('accent', v || undefined)} />
        </Field>
        <Field label="Zweite Akzentfarbe">
          <ColorInput value={ov.accent2 || resolved.accent2} onChange={(v) => set('accent2', v || undefined)} />
        </Field>
        <Field label="Hintergrundfarbe">
          <ColorInput value={ov.background || resolved.background} onChange={(v) => set('background', v || undefined)} />
        </Field>
        <Field label="Kartenfarbe">
          <ColorInput value={ov.surface || resolved.surface} onChange={(v) => set('surface', v || undefined)} />
        </Field>
        <Field label="Textfarbe">
          <ColorInput value={ov.text || resolved.text} onChange={(v) => set('text', v || undefined)} />
        </Field>
        <Field label="Sekundärtext">
          <ColorInput value={ov.muted || resolved.muted} onChange={(v) => set('muted', v || undefined)} />
        </Field>
        <Field label="Rahmenfarbe">
          <ColorInput value={ov.border || resolved.border} onChange={(v) => set('border', v || undefined)} />
        </Field>
        <Field label="Schatten">
          <Select
            value={resolved.shadow}
            onChange={(v) => set('shadow', v as any)}
            options={[
              { value: 'none', label: 'Keiner' },
              { value: 'sm', label: 'Leicht' },
              { value: 'md', label: 'Mittel' },
              { value: 'lg', label: 'Stark' },
              { value: 'glow', label: 'Neon-Leuchten' },
            ]}
          />
        </Field>
        <Field label={`Deckkraft Karten (${Math.round(resolved.surfaceOpacity * 100)} %)`}>
          <Slider value={resolved.surfaceOpacity} onChange={(v) => set('surfaceOpacity', v)} format={(v) => `${Math.round(v * 100)} %`} />
        </Field>
        <Field label="Glas-Effekt (Weichzeichner)">
          <Slider value={resolved.glassBlur} min={0} max={40} step={1} onChange={(v) => set('glassBlur', v)} format={(v) => `${v}px`} />
        </Field>
        <Field label="Eckenradius">
          <Slider value={resolved.radius} min={0} max={36} step={1} onChange={(v) => set('radius', v)} format={(v) => `${v}px`} />
        </Field>
        <Field label="Rahmenbreite">
          <Slider value={resolved.borderWidth} min={0} max={4} step={0.5} onChange={(v) => set('borderWidth', v)} format={(v) => `${v}px`} />
        </Field>
        <Field label="Deckkraft Rahmen">
          <Slider value={resolved.borderOpacity} onChange={(v) => set('borderOpacity', v)} format={(v) => `${Math.round(v * 100)} %`} />
        </Field>
        <Field label="Schriftgröße (Faktor)">
          <Slider value={resolved.fontScale} min={0.7} max={1.6} step={0.05} onChange={(v) => set('fontScale', v)} format={(v) => `${v.toFixed(2)}×`} />
        </Field>
        <Field label="Schriftstärke Titel">
          <Slider value={resolved.titleWeight} min={300} max={800} step={100} onChange={(v) => set('titleWeight', v)} format={(v) => String(v)} />
        </Field>
        <div className="flex flex-col justify-end gap-3">
          <Switch checked={resolved.animations} onChange={(v) => set('animations', v)} label="Animationen & Übergänge" />
          <Switch checked={resolved.glow} onChange={(v) => set('glow', v)} label="Leuchteffekte (Neon)" />
        </div>
      </div>

      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        <Field label="Hintergrund-Verlauf (CSS)" hint="z. B. linear-gradient(135deg, #1e3a8a, #db2777)" className="md:col-span-2">
          <Input value={ov.backgroundGradient ?? resolved.backgroundGradient} onChange={(e) => set('backgroundGradient', e.target.value)} />
        </Field>
        <Field label="Hintergrundbild" className="md:col-span-2">
          <div className="flex items-center gap-2">
            <Input value={ov.backgroundImage || ''} placeholder="URL oder hochladen" onChange={(e) => set('backgroundImage', e.target.value || undefined)} />
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>
              Upload
            </Button>
            {ov.backgroundImage && (
              <IconButton title="Entfernen" onClick={() => set('backgroundImage', undefined)}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            )}
          </div>
          {ov.backgroundImage && <img src={assetUrl(ov.backgroundImage)} alt="" className="mt-2 h-24 w-full rounded-lg object-cover" />}
        </Field>
        <Field label="Abdunklung über Bild">
          <Slider value={resolved.backgroundOverlay} onChange={(v) => set('backgroundOverlay', v)} format={(v) => `${Math.round(v * 100)} %`} />
        </Field>
        <Field label="Bild weichzeichnen">
          <Slider value={resolved.backgroundBlur} min={0} max={30} step={1} onChange={(v) => set('backgroundBlur', v)} format={(v) => `${v}px`} />
        </Field>
      </div>

      <Field label="Diagramm-Farbpalette">
        <div className="flex flex-wrap items-center gap-2">
          {resolved.palette.map((c, i) => (
            <div key={i} className="flex items-center gap-1">
              <input
                type="color"
                className="h-8 w-9 cursor-pointer rounded border border-line bg-transparent"
                value={c}
                onChange={(e) => set('palette', resolved.palette.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <button className="text-muted hover:text-bad" title="Entfernen" onClick={() => set('palette', resolved.palette.filter((_, j) => j !== i))}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <IconButton title="Farbe hinzufügen" onClick={() => set('palette', [...resolved.palette, '#ffffff'])}>
            <Plus className="h-4 w-4" />
          </IconButton>
        </div>
      </Field>

      <Button variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={() => onChange({ preset: value.preset, overrides: {} })}>
        Anpassungen zurücksetzen
      </Button>
    </div>
  )
}
