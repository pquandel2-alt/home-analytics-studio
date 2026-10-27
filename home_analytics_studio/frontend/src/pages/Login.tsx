import { KeyRound, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { api, setCsrf } from '../api/client'
import { Button, Field, Input } from '../components/ui'
import { useApp } from '../store/app'

export default function LoginPage() {
  const status = useApp((s) => s.status)
  const loadStatus = useApp((s) => s.loadStatus)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const setup = !!status?.setup_required

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (setup && password !== password2) {
      setError('Die Passwörter stimmen nicht überein')
      return
    }
    setBusy(true)
    try {
      const res = await api.post<{ csrf: string }>(setup ? 'auth/setup' : 'auth/login', setup ? { username, password, setup_code: code } : { username, password })
      setCsrf(res.csrf)
      await loadStatus()
      window.location.reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-bg flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="panel anim-fade w-full max-w-sm space-y-5 p-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src="./favicon.svg" alt="" className="h-14 w-14" />
          <div>
            <h1 className="text-xl font-semibold">{status?.instance_name || 'Home Analytics Studio'}</h1>
            <p className="mt-1 text-sm text-muted">{setup ? 'Ersteinrichtung: Administrator anlegen' : 'Bitte anmelden'}</p>
          </div>
        </div>
        {setup && (
          <div className="rounded-lg border border-accent/30 bg-accent/10 p-3 text-xs text-muted">
            <ShieldCheck className="mb-1 h-4 w-4 text-accent" />
            Zum Schutz vor unbefugtem Zugriff wird der <b>Einrichtungscode</b> aus dem Add-on-Protokoll benötigt. Alternativ
            die Oberfläche über die Home-Assistant-Seitenleiste öffnen und dort unter Einstellungen → Benutzer einen Zugang anlegen.
          </div>
        )}
        {!setup && !status?.direct_login_allowed && <div className="text-sm text-warn">Die Direktanmeldung ist deaktiviert.</div>}
        <Field label="Benutzername">
          <Input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Passwort">
          <Input type="password" autoComplete={setup ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {setup && (
          <>
            <Field label="Passwort wiederholen" hint="Mindestens 8 Zeichen">
              <Input type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} required />
            </Field>
            {!status?.ingress && (
              <Field label="Einrichtungscode">
                <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="z. B. 1A2B3C4D" required />
              </Field>
            )}
          </>
        )}
        {error && <div className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
        <Button type="submit" variant="primary" className="w-full" loading={busy} icon={<KeyRound className="h-4 w-4" />}>
          {setup ? 'Administrator anlegen' : 'Anmelden'}
        </Button>
      </form>
    </div>
  )
}
