// Thin fetch wrapper. All URLs are relative so the app works behind HA ingress / reverse proxies.

let csrfToken: string | null = null
let displayToken: string | null = null

export function setDisplayToken(token: string | null) {
  displayToken = token
}

export function setCsrf(token: string | null) {
  csrfToken = token
}

const SHARE_PREFIX = 'has-share:'

function storage(): Storage | null {
  // Safari private mode, some TV browsers and blocked-cookie setups throw on any access
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Dashboard id and share token of the current URL (`#/present/<id>?share=…`). Pure function of the location. */
export function parseShareLocation(hash: string, search: string): { dashboardId: number | null; token: string | null } {
  const h = hash.replace(/^#/, '')
  const q = h.indexOf('?')
  const path = q >= 0 ? h.slice(0, q) : h
  const m = /^\/present\/(\d+)\/?$/.exec(path)
  if (!m) return { dashboardId: null, token: null }
  // the token normally sits behind the hash; links whose query landed before the `#` are accepted too
  const token = new URLSearchParams(q >= 0 ? h.slice(q + 1) : '').get('share') || new URLSearchParams(search).get('share')
  return { dashboardId: Number(m[1]), token: token || null }
}

/**
 * Share token for the *current* presentation URL. Resolved synchronously from `location` on every call, so the very
 * first request/websocket of a page load carries it no matter how React effects are ordered. The token is remembered
 * per dashboard (sessionStorage, best effort) so reloads without the parameter keep working and a token is never
 * applied to another dashboard.
 */
export function getShareToken(): string | null {
  const { dashboardId, token } = parseShareLocation(window.location.hash, window.location.search)
  if (dashboardId === null) return null
  const store = storage()
  if (token) {
    try {
      store?.setItem(SHARE_PREFIX + dashboardId, token)
    } catch {
      /* storage unavailable: the URL itself still carries the token */
    }
    return token
  }
  try {
    return store?.getItem(SHARE_PREFIX + dashboardId) || null
  } catch {
    return null
  }
}

export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

export function apiUrl(path: string): string {
  const p = path.startsWith('/') ? path.slice(1) : path
  return p.startsWith('api/') ? p : `api/${p}`
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { 'X-Requested-With': 'has', ...extra }
  if (csrfToken) h['X-CSRF-Token'] = csrfToken
  const share = getShareToken()
  if (share) h['X-Share-Token'] = share
  if (displayToken) h['X-Display-Token'] = displayToken
  return h
}

function errorMessage(detail: unknown, status: number): string {
  if (typeof detail === 'string') return detail
  if (detail && typeof detail === 'object' && 'message' in detail) return String((detail as { message: unknown }).message)
  return `Fehler ${status}`
}

let unauthorizedHandler: (() => void) | null = null
export function onUnauthorized(fn: () => void) {
  unauthorizedHandler = fn
}

export async function request<T = unknown>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(apiUrl(path), {
    method,
    credentials: 'same-origin',
    headers: headers(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : undefined),
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    ...init,
  })
  if (!res.ok) {
    let detail: unknown = undefined
    try {
      const data = await res.json()
      detail = data?.detail ?? data
    } catch {
      /* not json */
    }
    if (res.status === 401 && unauthorizedHandler) unauthorizedHandler()
    throw new ApiError(res.status, errorMessage(detail, res.status), detail)
  }
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('application/json')) return (await res.json()) as T
  return (await res.text()) as unknown as T
}

export const api = {
  get: <T = unknown>(p: string) => request<T>('GET', p),
  post: <T = unknown>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T = unknown>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  patch: <T = unknown>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}),
  del: <T = unknown>(p: string) => request<T>('DELETE', p),
}

/** Download a file returned by a POST/GET endpoint. */
export async function download(method: 'GET' | 'POST', path: string, body?: unknown, fallbackName = 'export') {
  const res = await fetch(apiUrl(path), {
    method,
    credentials: 'same-origin',
    headers: headers(body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `Fehler ${res.status}`
    try {
      msg = errorMessage((await res.json()).detail, res.status)
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg)
  }
  const blob = await res.blob()
  const cd = res.headers.get('content-disposition') || ''
  const m = /filename="?([^"]+)"?/.exec(cd)
  saveBlob(blob, m ? m[1] : fallbackName)
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function wsUrl(): string {
  const u = new URL(apiUrl('ws'), window.location.href)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.hash = ''
  const share = getShareToken()
  if (share) u.searchParams.set('share', share)
  if (displayToken) u.searchParams.set('display', displayToken)
  return u.toString()
}

export function assetUrl(url: string | undefined | null): string {
  if (!url) return ''
  if (/^(https?:|data:|blob:)/.test(url)) return url
  return url.replace(/^\//, '')
}
