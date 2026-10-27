import clsx from 'clsx'
import { Loader2, X } from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

// ------------------------------------------------------------------ buttons

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant
  size?: 'sm' | 'md' | 'lg'
  icon?: React.ReactNode
  loading?: boolean
}

export function Button({ variant = 'secondary', size = 'md', icon, loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      className={clsx(
        'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-8 px-2.5 text-xs',
        size === 'md' && 'h-9 px-3.5 text-sm',
        size === 'lg' && 'h-11 px-5 text-base',
        variant === 'primary' && 'bg-accent text-black shadow-[0_0_20px_rgb(var(--c-accent)/0.25)] hover:brightness-110',
        variant === 'secondary' && 'border border-line/70 bg-surface/80 text-fg hover:border-accent/60 hover:bg-surface',
        variant === 'outline' && 'border border-accent/60 text-accent hover:bg-accent/10',
        variant === 'ghost' && 'text-muted hover:bg-fg/5 hover:text-fg',
        variant === 'danger' && 'bg-bad/90 text-white hover:bg-bad',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ className, title, active, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      title={title}
      aria-label={title}
      className={clsx(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted transition hover:bg-fg/10 hover:text-fg disabled:opacity-40',
        active && 'bg-accent/15 text-accent',
        className,
      )}
      {...rest}
    />
  )
}

// ------------------------------------------------------------------ form

export function Field({ label, hint, children, className }: { label?: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('min-w-0', className)}>
      {label && <label className="label">{label}</label>}
      {children}
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  )
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={clsx('input', className)} {...rest} />
})

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={clsx('input min-h-[80px] font-mono text-[13px]', className)} {...rest} />
})

export function Select({
  value,
  onChange,
  options,
  className,
  placeholder,
  ...rest
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> & {
  value: string | number | undefined | null
  onChange: (v: string) => void
  options: { value: string | number; label: string }[]
  placeholder?: string
}) {
  return (
    <select className={clsx('input pr-8', className)} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={String(o.value)} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  className,
}: {
  value: number | null | undefined
  onChange: (v: number | null) => void
  min?: number
  max?: number
  step?: number
  placeholder?: string
  className?: string
}) {
  const [text, setText] = useState(value == null ? '' : String(value))
  useEffect(() => {
    setText(value == null ? '' : String(value))
  }, [value])
  return (
    <input
      className={clsx('input', className)}
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value)
        const raw = e.target.value.replace(',', '.').trim()
        if (raw === '') return onChange(null)
        const n = Number(raw)
        if (Number.isFinite(n)) onChange(min != null && n < min ? min : max != null && n > max ? max : n)
      }}
      step={step}
    />
  )
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: React.ReactNode; disabled?: boolean }) {
  return (
    <label className={clsx('inline-flex cursor-pointer select-none items-center gap-2.5 text-sm', disabled && 'opacity-50')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx('relative h-5 w-9 shrink-0 rounded-full transition', checked ? 'bg-accent' : 'bg-line')}
      >
        <span className={clsx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      {label && <span>{label}</span>}
    </label>
  )
}

export function Checkbox({ checked, onChange, indeterminate, label }: { checked: boolean; onChange: (v: boolean) => void; indeterminate?: boolean; label?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      className="h-4 w-4 cursor-pointer rounded border-line accent-[rgb(var(--c-accent))]"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

export function Slider({ value, onChange, min = 0, max = 1, step = 0.01, format }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; format?: (v: number) => string }) {
  return (
    <div className="flex items-center gap-3">
      <input type="range" className="w-full accent-[rgb(var(--c-accent))]" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="w-14 text-right text-xs tabular-nums text-muted">{format ? format(value) : value}</span>
    </div>
  )
}

export function ColorInput({ value, onChange, allowEmpty = true }: { value: string | undefined; onChange: (v: string) => void; allowEmpty?: boolean }) {
  const isHex = /^#[0-9a-f]{6}$/i.test(value || '')
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        className="h-9 w-10 shrink-0 cursor-pointer rounded-md border border-line bg-transparent p-0.5"
        value={isHex ? value : '#22d3ee'}
        onChange={(e) => onChange(e.target.value)}
      />
      <input className="input font-mono" value={value || ''} placeholder={allowEmpty ? 'Standard' : ''} onChange={(e) => onChange(e.target.value)} />
      {allowEmpty && value && (
        <IconButton title="Zurücksetzen" onClick={() => onChange('')}>
          <X className="h-4 w-4" />
        </IconButton>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ layout

export function Card({ title, actions, children, className, bodyClass }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={clsx('panel', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line/50 px-5 py-3.5">
          <h3 className="text-sm font-semibold tracking-wide">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={clsx('p-5', bodyClass)}>{children}</div>
    </section>
  )
}

export function PageHeader({ title, subtitle, actions, icon }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-center gap-3">
        {icon && <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent">{icon}</div>}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Badge({ children, tone = 'default', className }: { children: React.ReactNode; tone?: 'default' | 'accent' | 'ok' | 'warn' | 'bad'; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        tone === 'default' && 'bg-fg/10 text-muted',
        tone === 'accent' && 'bg-accent/15 text-accent',
        tone === 'ok' && 'bg-ok/15 text-ok',
        tone === 'warn' && 'bg-warn/15 text-warn',
        tone === 'bad' && 'bg-bad/15 text-bad',
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-5 w-5 animate-spin text-accent', className)} />
}

export function Empty({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      {icon && <div className="text-muted/60">{icon}</div>}
      <div className="text-base font-medium">{title}</div>
      {children && <div className="max-w-md text-sm text-muted">{children}</div>}
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: React.ReactNode; icon?: React.ReactNode }[]; className?: string }) {
  return (
    <div className={clsx('flex flex-wrap gap-1 rounded-xl border border-line/60 bg-bg/40 p-1', className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition',
            value === t.value ? 'bg-accent/15 text-accent shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={clsx(
          'panel anim-fade flex max-h-[92vh] w-full flex-col !bg-[rgb(var(--c-elevated))]',
          size === 'sm' && 'max-w-md',
          size === 'md' && 'max-w-xl',
          size === 'lg' && 'max-w-3xl',
          size === 'xl' && 'max-w-6xl',
        )}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line/50 px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <IconButton title="Schließen" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </header>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line/50 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ toasts & confirm

interface Toast {
  id: number
  tone: 'ok' | 'bad' | 'info'
  text: string
}

interface ToastStore {
  toasts: Toast[]
  push: (tone: Toast['tone'], text: string) => void
  remove: (id: number) => void
}

let toastId = 0
export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (tone, text) => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, tone, text }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'bad' ? 7000 : 3500)
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const toast = {
  ok: (t: string) => useToasts.getState().push('ok', t),
  error: (t: unknown) => useToasts.getState().push('bad', t instanceof Error ? t.message : String(t)),
  info: (t: string) => useToasts.getState().push('info', t),
}

export function Toaster() {
  const { toasts, remove } = useToasts()
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[2000] flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={clsx(
            'panel anim-fade pointer-events-auto flex items-start gap-3 !bg-[rgb(var(--c-elevated))] px-4 py-3 text-sm',
            t.tone === 'ok' && 'border-l-4 !border-l-ok',
            t.tone === 'bad' && 'border-l-4 !border-l-bad',
            t.tone === 'info' && 'border-l-4 !border-l-accent',
          )}
        >
          <span className="flex-1">{t.text}</span>
          <button className="text-muted hover:text-fg" onClick={() => remove(t.id)} aria-label="Schließen">
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  )
}

interface ConfirmState {
  open: boolean
  title: string
  text: string
  danger: boolean
  confirmLabel: string
  resolve: ((v: boolean) => void) | null
}

const useConfirmStore = create<ConfirmState>(() => ({ open: false, title: '', text: '', danger: false, confirmLabel: 'OK', resolve: null }))

export function confirmDialog(title: string, text: string, opts: { danger?: boolean; confirmLabel?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.setState({ open: true, title, text, danger: !!opts.danger, confirmLabel: opts.confirmLabel || 'Bestätigen', resolve })
  })
}

export function ConfirmHost() {
  const s = useConfirmStore()
  const close = (v: boolean) => {
    s.resolve?.(v)
    useConfirmStore.setState({ open: false, resolve: null })
  }
  return (
    <Modal
      open={s.open}
      onClose={() => close(false)}
      title={s.title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            Abbrechen
          </Button>
          <Button variant={s.danger ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>
            {s.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="whitespace-pre-line text-sm text-muted">{s.text}</p>
    </Modal>
  )
}

interface PromptState {
  open: boolean
  title: string
  label: string
  value: string
  resolve: ((v: string | null) => void) | null
}
const usePromptStore = create<PromptState>(() => ({ open: false, title: '', label: '', value: '', resolve: null }))

export function promptDialog(title: string, label: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => usePromptStore.setState({ open: true, title, label, value: initial, resolve }))
}

export function PromptHost() {
  const s = usePromptStore()
  const close = (v: string | null) => {
    s.resolve?.(v)
    usePromptStore.setState({ open: false, resolve: null })
  }
  return (
    <Modal
      open={s.open}
      onClose={() => close(null)}
      title={s.title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => close(null)}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={() => close(s.value)}>
            OK
          </Button>
        </>
      }
    >
      <Field label={s.label}>
        <Input autoFocus value={s.value} onChange={(e) => usePromptStore.setState({ value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && close(s.value)} />
      </Field>
    </Modal>
  )
}

export function useAsync<T>(fn: () => Promise<T>, deps: React.DependencyList): { data: T | undefined; error: Error | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; loading: boolean }>({ data: undefined, error: null, loading: true })
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error) => alive && setState({ data: undefined, error, loading: false }),
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n])
  return { ...state, reload: () => setN((x) => x + 1) }
}
