// `inset` is only supported from Chromium 87 – expand it for older TV browsers.
const expandInset = () => ({
  postcssPlugin: 'expand-inset',
  Declaration: {
    inset(decl) {
      const v = decl.value.trim().split(/\s+/)
      const [t, r = t, b = t, l = r] = v
      decl.cloneBefore({ prop: 'top', value: t })
      decl.cloneBefore({ prop: 'right', value: r })
      decl.cloneBefore({ prop: 'bottom', value: b })
      decl.cloneBefore({ prop: 'left', value: l })
    },
  },
})
expandInset.postcss = true

export default { plugins: [(await import('tailwindcss')).default, (await import('autoprefixer')).default, expandInset] }
