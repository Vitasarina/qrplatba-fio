import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import { getPin, setPin } from '../lib/pin'

// Hard gate: children render only after the settings password is satisfied.
// Two modes, decided by GET /api/password/status:
//  - passwordSet === false → first-run "create password" screen (device-only).
//  - passwordSet === true   → "enter password" screen, validated via /api/auth.
// The password is stored locally (lib/pin) and sent as the x-pin header.
export function RequirePin({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'create' | 'enter' | 'ok'>('checking')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // "enter" mode
  const [value, setValue] = useState('')
  // "create" mode
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')

  // Decide which gate to show. If a password is already set and we hold a
  // locally-stored one, try it silently so returning operators skip the prompt.
  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const { passwordSet } = await api.getPasswordStatus()
        if (cancelled) return
        if (!passwordSet) {
          setState('create')
          return
        }
        if (getPin()) {
          try {
            await api.auth()
            if (!cancelled) setState('ok')
            return
          } catch {
            setPin('') // stored password no longer valid
          }
        }
        if (!cancelled) setState('enter')
      } catch {
        // Status check failed (backend down). Fall back to the enter screen;
        // a manual attempt will surface the real error.
        if (!cancelled) setState('enter')
      }
    }
    check()
    return () => {
      cancelled = true
    }
  }, [])

  // First-run: create the password (device-only on the backend).
  async function submitCreate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const a = pw1.trim()
    const b = pw2.trim()
    if (a.length < 4) {
      setError('Heslo musí mít alespoň 4 znaky.')
      return
    }
    if (a !== b) {
      setError('Hesla se neshodují.')
      return
    }
    setBusy(true)
    try {
      await api.setupPassword(a)
      setPin(a)
      setState('ok')
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError('Heslo lze vytvořit jen přímo na tomto zařízení (ne vzdáleně přes Wi-Fi).')
      } else {
        setError(err instanceof ApiError ? err.message : 'Vytvoření hesla selhalo.')
      }
    } finally {
      setBusy(false)
    }
  }

  // Returning: validate the entered password against the backend.
  async function submitEnter(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const pw = value.trim()
    if (!pw) {
      setError('Zadejte heslo.')
      return
    }
    setBusy(true)
    setPin(pw)
    try {
      await api.auth()
      setState('ok')
    } catch (err) {
      setPin('')
      setError(err instanceof ApiError && err.status === 401 ? 'Nesprávné heslo.' : 'Ověření selhalo.')
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

  if (state === 'create') {
    return (
      <div className="pin-gate">
        <form className="card pin-card" onSubmit={submitCreate}>
          <h1 style={{ marginTop: 0 }}>Vytvořte heslo pro nastavení</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            Toto heslo bude chránit přístup k aplikaci. Z bezpečnostních důvodů ho lze vytvořit jen
            přímo na tomto zařízení.
          </p>
          {error && <div className="banner error">{error}</div>}
          <div className="field">
            <label htmlFor="gate-pw1">Heslo</label>
            <input
              id="gate-pw1"
              type="password"
              autoComplete="new-password"
              autoFocus
              value={pw1}
              onChange={(e) => setPw1(e.target.value)}
              placeholder="alespoň 4 znaky"
            />
          </div>
          <div className="field">
            <label htmlFor="gate-pw2">Heslo znovu</label>
            <input
              id="gate-pw2"
              type="password"
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              placeholder="potvrzení hesla"
            />
          </div>
          <button type="submit" className="btn lg block" disabled={busy}>
            {busy ? 'Ukládám…' : 'Vytvořit heslo'}
          </button>
        </form>
      </div>
    )
  }

  // state === 'enter'
  return (
    <div className="pin-gate">
      <form className="card pin-card" onSubmit={submitEnter}>
        <h1 style={{ marginTop: 0 }}>Zadejte heslo</h1>
        <p className="muted" style={{ marginTop: 0 }}>Přístup k aplikaci je chráněn heslem.</p>
        {error && <div className="banner error">{error}</div>}
        <div className="field">
          <label htmlFor="gate-pw">Heslo</label>
          <input
            id="gate-pw"
            type="password"
            autoComplete="current-password"
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
