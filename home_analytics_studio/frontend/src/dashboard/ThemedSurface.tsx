import clsx from 'clsx'
import React, { useLayoutEffect, useMemo, useRef } from 'react'
import { assetUrl } from '../api/client'
import type { ThemeSpec, ThemeTokens } from '../api/types'
import { useApp } from '../store/app'
import { ThemeContext } from '../theme/context'
import { resolveTheme, themeVars } from '../theme/presets'

/** Applies global appearance + dashboard theme + page overrides to a subtree. */
export default function ThemedSurface({ specs, children, className, fixedBg = false }: { specs: (ThemeSpec | undefined | null)[]; children: React.ReactNode; className?: string; fixedBg?: boolean }) {
  const global = useApp((s) => s.appearance?.appearance)
  const tokens: ThemeTokens = useMemo(() => resolveTheme(global, ...specs), [global, specs])
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    for (const [k, v] of Object.entries(themeVars(tokens))) el.style.setProperty(k, v)
  }, [tokens])
  return (
    <ThemeContext.Provider value={tokens}>
      <div
        ref={ref}
        className={clsx('relative isolate', tokens.mode === 'dark' ? 'dark' : '', !tokens.animations && 'no-anim', className)}
        style={{ fontFamily: tokens.font, color: tokens.text, fontSize: `${tokens.fontScale}rem` }}
      >
        <div
          className={clsx('pointer-events-none inset-0 -z-10', fixedBg ? 'fixed' : 'absolute')}
          style={{ backgroundColor: tokens.background, backgroundImage: tokens.backgroundGradient || undefined }}
        />
        {tokens.backgroundImage && (
          <>
            <div
              className={clsx('pointer-events-none inset-0 -z-10 bg-cover bg-center', fixedBg ? 'fixed' : 'absolute')}
              style={{ backgroundImage: `url("${assetUrl(tokens.backgroundImage)}")`, filter: tokens.backgroundBlur ? `blur(${tokens.backgroundBlur}px)` : undefined, transform: tokens.backgroundBlur ? 'scale(1.05)' : undefined }}
            />
            <div className={clsx('pointer-events-none inset-0 -z-10', fixedBg ? 'fixed' : 'absolute')} style={{ background: `rgba(0,0,0,${tokens.backgroundOverlay})` }} />
          </>
        )}
        {children}
      </div>
    </ThemeContext.Provider>
  )
}
