import '@testing-library/jest-dom/vitest'

// jsdom lacks ResizeObserver / matchMedia used by charts and the grid
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver || RO
if (!window.matchMedia) {
  ;(window as any).matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })
}
