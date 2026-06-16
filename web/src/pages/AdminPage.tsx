import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, ApiError, urls } from '../lib/api'
import { setPin } from '../lib/pin'
import type { NetInfo } from '../types'

// Reached via the hidden trigger on the Display (5 taps top-right corner).
// Intentionally NOT behind the PIN gate: this screen is the recovery path when
// the PIN is forgotten, so it must stay reachable. The gesture is the gate.
export function AdminPage() {
  const navigate = useNavigate()
  const [net, setNet] = useState<NetInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api
      .getNetInfo()
      .then(setNet)
      .catch(() => setErr('Nepodařilo se zjistit IP adresu zařízení.'))
  }, [])

  const base = net?.baseUrl ?? ''

  return (
    <div className="admin">
      <div className="admin-head">
        <h1>Správa</h1>
        <button type="button" className="btn secondary" onClick={() => navigate('/display')}>
          Zpět na displej
        </button>
      </div>

      {err && <div className="banner error">{err}</div>}
      {!net && !err && <p className="muted">Zjišťuji adresu zařízení…</p>}

      {net && (
        <>
          <p className="muted">
            Tyto stránky otevři z počítače nebo jiného zařízení na stejné Wi-Fi — nemusíš nic ťukat
            v telefonu. Server běží v tomto telefonu na <span className="mono">{net.ip}:{net.port}</span>.
          </p>

          <AccessCard
            title="Nastavení — vše nastavíš tady"
            desc="Název, IBAN, tokeny banky (Fio), heslo pro přístup a logo. Tokeny se uloží do telefonu a nikam neodchází."
            url={`${base}/setup`}
            onOpen={() => navigate('/setup')}
          />
          <AccessCard
            title="Zadávání plateb (obsluha)"
            desc="Stránka, kde obsluha zadává částky. Přístup chrání heslo nastavené v Nastavení."
            url={`${base}/operator`}
            onOpen={() => navigate('/operator')}
          />
          <ResetPinCard />
        </>
      )}
    </div>
  )
}

// Recovery for a forgotten settings password. Clears the password back to
// first-run; only works when triggered directly on the device (the backend
// rejects remote calls with HTTP 403).
function ResetPinCard() {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleReset() {
    setBusy(true)
    setMsg(null)
    setError(null)
    try {
      await api.resetPin()
      // Drop any stale/forgotten password held locally; a new one is created on
      // the next entry to settings.
      setPin('')
      setMsg('Heslo bylo smazáno. Při dalším vstupu do nastavení vytvoříte nové.')
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setError('Obnovu hesla lze provést jen přímo na zařízení (v telefonu), ne vzdáleně.')
      } else {
        setError(e instanceof ApiError ? e.message : 'Obnova hesla se nezdařila.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card admin-card">
      <h2 style={{ margin: '0 0 0.25rem' }}>Zapomenuté heslo</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Pokud jste zapomněli heslo pro přístup, můžete ho zde smazat. Při dalším vstupu do nastavení
        vytvoříte nové. Z bezpečnostních důvodů to jde jen přímo na tomto zařízení (v telefonu), ne
        přes vzdálený přístup.
      </p>
      {msg && <div className="banner success">{msg}</div>}
      {error && <div className="banner error">{error}</div>}
      <button type="button" className="btn danger" onClick={handleReset} disabled={busy}>
        {busy ? <span className="spinner" aria-hidden /> : null}
        {busy ? 'Obnovuji…' : 'Obnovit heslo (jen na tomto zařízení)'}
      </button>
    </div>
  )
}

function AccessCard({
  title,
  desc,
  url,
  onOpen,
}: {
  title: string
  desc: string
  url: string
  onOpen: () => void
}) {
  return (
    <div className="card admin-card">
      <h2 style={{ margin: '0 0 0.25rem' }}>{title}</h2>
      <p className="muted" style={{ marginTop: 0 }}>{desc}</p>
      <div className="admin-access">
        <img className="admin-qr" src={urls.qrFor(url)} alt="QR odkaz" width={150} height={150} />
        <div>
          <div className="admin-url mono">{url}</div>
          <div className="row" style={{ marginTop: '0.75rem', gap: '0.5rem' }}>
            <button type="button" className="btn" onClick={onOpen}>
              Otevřít tady v telefonu
            </button>
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
            Nebo naskenuj QR / napiš adresu do prohlížeče na PC.
          </p>
        </div>
      </div>
    </div>
  )
}
