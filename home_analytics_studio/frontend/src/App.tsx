import { useEffect } from 'react'
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { onUnauthorized, setShareToken } from './api/client'
import { live } from './api/live'
import { ConfirmHost, PromptHost, Spinner, Toaster } from './components/ui'
import Shell from './layout/Shell'
import AiExportPage from './pages/AiExport'
import AnalysisPage from './pages/Analysis'
import DashboardPage from './pages/DashboardPage'
import DashboardsPage from './pages/Dashboards'
import EntitiesPage from './pages/Entities'
import LoginPage from './pages/Login'
import MetricsPage from './pages/Metrics'
import PresentPage from './pages/Present'
import SettingsPage from './pages/Settings'
import { useApp } from './store/app'
import { applyThemeToElement, resolveTheme } from './theme/presets'

function ShareBootstrap() {
  // share links: #/present/<id>?share=shr_xxx -> read-only token for API + websocket
  const loc = useLocation()
  useEffect(() => {
    const p = new URLSearchParams(loc.search)
    const tok = p.get('share')
    if (tok) {
      setShareToken(tok)
      sessionStorage.setItem('has-share', tok)
    } else if (loc.pathname.startsWith('/present') && sessionStorage.getItem('has-share')) {
      setShareToken(sessionStorage.getItem('has-share'))
    }
  }, [loc.search, loc.pathname])
  return null
}

function Gate() {
  const { status, loading, appearance, loadStatus, loadAppearance } = useApp()
  const loc = useLocation()
  const isPresent = loc.pathname.startsWith('/present')
  const hasShare = new URLSearchParams(loc.search).has('share') || (isPresent && !!sessionStorage.getItem('has-share'))

  useEffect(() => {
    if (hasShare) {
      setShareToken(new URLSearchParams(loc.search).get('share') || sessionStorage.getItem('has-share'))
    }
    loadStatus().then((s) => {
      if (s?.authenticated || hasShare) {
        loadAppearance()
        live.start()
      }
    })
    onUnauthorized(() => {
      if (!hasShare) loadStatus()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    applyThemeToElement(document.documentElement, resolveTheme(appearance?.appearance))
    if (appearance?.general?.instance_name) document.title = appearance.general.instance_name
  }, [appearance])

  if (loading && !status) {
    return (
      <div className="app-bg flex h-full items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    )
  }

  if (isPresent && hasShare) {
    return (
      <Routes>
        <Route path="/present/:id" element={<PresentPage />} />
      </Routes>
    )
  }

  if (!status?.authenticated) return <LoginPage />

  return (
    <Routes>
      <Route path="/present/:id" element={<PresentPage />} />
      <Route element={<Shell />}>
        <Route index element={<HomeRedirect />} />
        <Route path="/dashboards" element={<DashboardsPage />} />
        <Route path="/d/:id" element={<DashboardPage />} />
        <Route path="/d/:id/:pageId" element={<DashboardPage />} />
        <Route path="/entities" element={<EntitiesPage />} />
        <Route path="/metrics" element={<MetricsPage />} />
        <Route path="/analysis" element={<AnalysisPage />} />
        <Route path="/ai" element={<AiExportPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

function HomeRedirect() {
  const def = useApp((s) => s.appearance?.general?.default_dashboard)
  if (def) return <Navigate to={`/d/${def}`} replace />
  return <Navigate to="/dashboards" replace />
}

export default function App() {
  return (
    <HashRouter>
      <ShareBootstrap />
      <Gate />
      <Toaster />
      <ConfirmHost />
      <PromptHost />
    </HashRouter>
  )
}
