import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Call { url: string; share: string | null }
let calls: Call[]
let valid: Record<string, number> // token -> dashboard id

const dashboard = (id: number) => ({
  id, name: `D${id}`, theme: null, pages: [{ id: id * 10, title: 'Seite', hidden: false, widgets: [], layouts: {}, settings: {} }],
  settings: { presentation: { pages: 'all', interval: 30, refresh: 60 }, grid: { cols: 12, rowHeight: 40, margin: 8 } },
})

function mockFetch() {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const share = ((init?.headers || {}) as Record<string, string>)['X-Share-Token'] ?? null
    calls.push({ url, share })
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url === 'api/auth/status')
      return json({ authenticated: !!share && share in valid, user: null, csrf: null, setup_required: false })
    if (!share || !(share in valid)) return json({ detail: 'Anmeldung erforderlich' }, 401)
    const m = /dashboards\/(\d+)$/.exec(url)
    if (m) return Number(m[1]) === valid[share] ? json(dashboard(Number(m[1]))) : json({ detail: 'Kein Zugriff auf dieses Dashboard' }, 403)
    if (url === 'api/appearance') return json({ appearance: { preset: 'dark', overrides: {} }, general: {}, timezone: 'UTC' })
    return json({ results: [] })
  }))
  vi.stubGlobal('WebSocket', class { onopen: unknown; onclose: unknown; onmessage: unknown; onerror: unknown; close() {} send() {} })
}

async function openApp(hash: string, search = '') {
  window.history.replaceState(null, '', `/${search}${hash}`)
  vi.resetModules() // fresh page load = fresh module state
  const { default: App } = await import('../App')
  return render(<App />)
}

beforeEach(() => {
  sessionStorage.clear()
  valid = { shr_aaa: 6, shr_bbb: 7 }
  mockFetch()
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
  vi.unstubAllGlobals()
})

const protectedCalls = () => calls.filter((c) => c.url !== 'api/auth/status')

describe('share link bootstrap', () => {
  it('fresh anonymous session: every API request incl. the first carries the share token', async () => {
    await openApp('#/present/6?share=shr_aaa&kiosk=1')
    await waitFor(() => expect(calls.some((c) => c.url === 'api/dashboards/6')).toBe(true))
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.share, c.url).toBe('shr_aaa')
    expect(screen.queryByText(/nicht verfügbar/)).toBeNull()
  })

  it('first request of the page already carries the token (also before React effects)', async () => {
    await openApp('#/present/6?share=shr_aaa')
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls[0].share).toBe('shr_aaa')
  })

  it('full reload without the share param (sessionStorage only) still works for the same dashboard', async () => {
    await openApp('#/present/6?share=shr_aaa')
    await waitFor(() => expect(calls.some((c) => c.url === 'api/dashboards/6')).toBe(true))
    cleanup()
    await openApp('#/present/6')
    await waitFor(() => expect(calls.filter((c) => c.url === 'api/dashboards/6').length).toBe(2))
    for (const c of calls) expect(c.share).toBe('shr_aaa')
  })

  it('token is not reused for another dashboard', async () => {
    await openApp('#/present/6?share=shr_aaa')
    await waitFor(() => expect(calls.some((c) => c.url === 'api/dashboards/6')).toBe(true))
    cleanup()
    calls.length = 0
    await openApp('#/present/7')
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.every((c) => c.share === null)).toBe(true)
    expect(calls.some((c) => c.url.startsWith('api/dashboards'))).toBe(false)
  })

  it('switching between dashboards uses each dashboard\'s own token', async () => {
    await openApp('#/present/6?share=shr_aaa')
    await waitFor(() => expect(calls.some((c) => c.url === 'api/dashboards/6')).toBe(true))
    cleanup()
    calls.length = 0
    await openApp('#/present/7?share=shr_bbb')
    await waitFor(() => expect(calls.some((c) => c.url === 'api/dashboards/7')).toBe(true))
    for (const c of calls) expect(c.share).toBe('shr_bbb')
  })

  it('invalid / revoked token is rejected', async () => {
    await openApp('#/present/6?share=shr_revoked')
    await waitFor(() => expect(screen.queryByText(/nicht verfügbar/)).not.toBeNull())
    expect(protectedCalls().every((c) => c.share === 'shr_revoked')).toBe(true)
  })

  it('no share and no session: login page, no presentation request', async () => {
    await openApp('#/present/6')
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    expect(calls.some((c) => c.url.startsWith('api/dashboards'))).toBe(false)
  })

  it('share param placed before the hash (?share=…#/present/6) works', async () => {
    await openApp('#/present/6', '?share=shr_aaa')
    await waitFor(() => expect(calls.some((c) => c.url === 'api/dashboards/6')).toBe(true))
    for (const c of calls) expect(c.share).toBe('shr_aaa')
  })

  it('works when sessionStorage is unavailable (private mode / TV)', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceeded') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    await openApp('#/present/6?share=shr_aaa')
    await waitFor(() => expect(calls.some((c) => c.url === 'api/dashboards/6')).toBe(true))
    for (const c of calls) expect(c.share).toBe('shr_aaa')
    vi.restoreAllMocks()
  })

  it('concurrent requests all carry the token', async () => {
    await openApp('#/present/6?share=shr_aaa')
    const { api } = await import('../api/client')
    await waitFor(() => expect(calls.some((c) => c.url === 'api/dashboards/6')).toBe(true))
    calls.length = 0
    await Promise.all([1, 2, 3, 4, 5].map(() => api.get('dashboards/6')))
    expect(calls).toHaveLength(5)
    for (const c of calls) expect(c.share).toBe('shr_aaa')
  })
})
