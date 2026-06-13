import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import { getPin, setPin, notifyPinChange } from '../lib/pin'

// Hard gate: children render only after a PIN that the backend accepts is entered.
// Used to protect the operator and configuration screens on a public Wi-Fi.
export function RequirePin({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'locked' | 'ok'>('checking')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    async function check() {
      if (!getPin()) {
        if (!cancelled) setState('locked')
        return
      }
      try {
        await api.auth()
        if (!cancelled) setState('ok')
      } catch {
        setPin('')
        if (!cancelled) setState('locked')
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const pin = value.trim()
    if (!pin) {
      setError('Zadejte PIN.')
      return
    }
    setBusy(true)
    setPin(pin)
    try {
      await api.auth()
      notifyPinChange()
      setState('ok')
    } catch (err) {
      setPin('')
      setError(err instanceof ApiError && err.status === 401 ? 'Nesprávný PIN.' : 'Ověření selhalo.')
    } finally {
      setBusy(false)
    }
  }

  if (state === 'checking') {
    return (
      <div className="pin-gate">
        <p className="muted">Ověřuji…</p>
      </div>
    )
  }
  if (state === 'ok') return <>{children}</>

  return (
    <div className="pin-gate">
      <form className="card pin-card" onSubmit={submit}>
        <h1 style={{ marginTop: 0 }}>Zadejte PIN</h1>
        <p className="muted" style={{ marginTop: 0 }}>Přístup k aplikaci je chráněn PINem.</p>
        {error && <div className="banner error">{error}</div>}
        <div className="field">
          <label htmlFor="gate-pin">PIN</label>
          <input
            id="gate-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="••••"
          />
        </div>
        <button type="submit" className="btn lg block" disabled={busy}>
          {busy ? 'Ověřuji…' : 'Odemknout'}
        </button>
      </form>
    </div>
  )
}
