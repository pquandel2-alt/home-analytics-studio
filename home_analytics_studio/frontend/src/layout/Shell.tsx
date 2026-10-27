import clsx from 'clsx'
import {
  Activity,
  BarChart3,
  Bot,
  Calculator,
  Database,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { api } from '../api/client'
import { useLive } from '../api/live'
import { useApp, useRole } from '../store/app'

const NAV = [
  { to: '/dashboards', label: 'Dashboards', icon: LayoutDashboard, match: ['/dashboards', '/d/'] },
  { to: '/analysis', label: 'Analysen', icon: BarChart3 },
  { to: '/metrics', label: 'Kennzahlen', icon: Calculator },
  { to: '/entities', label: 'Entitäten', icon: Database },
  { to: '/ai', label: 'ChatGPT-Export', icon: Bot },
  { to: '/settings', label: 'Einstellungen', icon: Settings, role: 'admin' as const },
]

export default function Shell() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('has-nav-collapsed') === '1')
  const [mobileOpen, setMobileOpen] = useState(false)
  const loc = useLocation()
  const status = useApp((s) => s.status)
  const name = useApp((s) => s.appearance?.general?.instance_name) || 'Home Analytics Studio'
  const haStatus = useLive((s) => s.haStatus)
  const wsConnected = useLive((s) => s.connected)
  const isAdmin = useRole('admin')
  const fullBleed = loc.pathname.startsWith('/d/')

  useEffect(() => setMobileOpen(false), [loc.pathname])
  useEffect(() => localStorage.setItem('has-nav-collapsed', collapsed ? '1' : '0'), [collapsed])

  const logout = async () => {
    try {
      await api.post('auth/logout')
    } finally {
      window.location.reload()
    }
  }

  const haOk = haStatus?.state === 'connected'

  return (
    <div className="app-bg flex h-full">
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-line/50 bg-surface/95 backdrop-blur-xl transition-all md:static md:z-auto',
          collapsed ? 'w-[68px]' : 'w-60',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0',
        )}
      >
        <div className="flex h-16 items-center gap-3 px-4">
          <img src="./favicon.svg" alt="" className="h-8 w-8 shrink-0" />
          {!collapsed && (
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold leading-tight">{name}</div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted">Analytics Studio</div>
            </div>
          )}
        </div>
        <nav className="flex-1 space-y-1 px-2 py-2">
          {NAV.filter((n) => !n.role || isAdmin).map((n) => {
            const active = (n.match || [n.to]).some((m) => loc.pathname.startsWith(m))
            return (
              <NavLink
                key={n.to}
                to={n.to}
                title={n.label}
                className={clsx(
                  'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition',
                  active ? 'bg-accent/15 text-accent shadow-[inset_2px_0_0_rgb(var(--c-accent))]' : 'text-muted hover:bg-fg/5 hover:text-fg',
                )}
              >
                <n.icon className="h-[18px] w-[18px] shrink-0" />
                {!collapsed && <span>{n.label}</span>}
              </NavLink>
            )
          })}
        </nav>
        <div className="space-y-2 border-t border-line/50 p-3 text-xs">
          <div className={clsx('flex items-center gap-2', haOk ? 'text-ok' : 'text-warn')} title={haStatus?.error || haStatus?.state || ''}>
            {haOk ? <Wifi className="h-4 w-4 shrink-0" /> : <WifiOff className="h-4 w-4 shrink-0" />}
            {!collapsed && <span className="truncate">{haOk ? `Home Assistant ${haStatus?.ha_version || ''}` : `HA: ${haStatus?.state || 'unbekannt'}`}</span>}
          </div>
          <div className={clsx('flex items-center gap-2', wsConnected ? 'text-muted' : 'text-warn')}>
            <Activity className={clsx('h-4 w-4 shrink-0', wsConnected && 'pulse-dot text-ok')} />
            {!collapsed && <span>{wsConnected ? 'Live-Daten aktiv' : 'Live-Verbindung getrennt'}</span>}
          </div>
          {!collapsed && status?.user && (
            <div className="truncate pt-1 text-muted" title={status.user.username}>
              {status.user.username} · {status.user.role}
            </div>
          )}
          <div className="flex items-center gap-1 pt-1">
            <button className="rounded-lg p-1.5 text-muted hover:bg-fg/10 hover:text-fg" onClick={() => setCollapsed((c) => !c)} title="Navigation ein-/ausklappen">
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
            {status?.user?.kind === 'login' && (
              <button className="rounded-lg p-1.5 text-muted hover:bg-fg/10 hover:text-fg" onClick={logout} title="Abmelden">
                <LogOut className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </aside>
      {mobileOpen && <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setMobileOpen(false)} />}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <button
          className="absolute left-3 top-3 z-30 rounded-lg border border-line/60 bg-surface/90 p-2 md:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Menü"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className={clsx('flex-1 overflow-y-auto', !fullBleed && 'px-4 pb-10 pt-14 md:px-8 md:pt-8')}>
          <Outlet />
        </div>
      </main>
    </div>
  )
}
