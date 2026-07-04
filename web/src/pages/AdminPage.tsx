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
  const [serviceOn, setServiceOn] = useState(false)

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
          <ServiceModeCard onChange={setServiceOn} />

          <p className="muted">
            Vzdálený přístup (konfigurace / kontrola plateb z počítače na stejné Wi-Fi) je z
            bezpečnostních důvodů dostupný jen když je zapnutý <strong>servisní režim</strong>.
            Server běží v telefonu na <span className="mono">{net.ip}:{net.port}</span>.
          </p>

          <AccessCard
            title="Nastavení — vše nastavíš tady"
            desc="Název, IBAN, tokeny banky (Fio), heslo pro přístup a logo. Tokeny se uloží do telefonu a nikam neodchází."
            url={`${base}/setup`}
            lanEnabled={serviceOn}
            onOpen={() => navigate('/setup')}
          />
          <AccessCard
            title="Zadávání plateb (obsluha)"
            desc="Stránka, kde obsluha zadává částky. Přístup chrání heslo nastavené v Nastavení."
            url={`${base}/operator`}
            lanEnabled={serviceOn}
            onOpen={() => navigate('/operator')}
          />
          <ResetPinCard />
        </>
      )}
    </div>
  )
}

// Toggle the LAN access window. Enabling opens remote (Wi-Fi) access for a limited
// time so the operator can configure from a PC; it auto-closes to keep the plaintext
// HTTP attack surface to a small, deliberate window. Enabling is device-only.
function ServiceModeCard({ onChange }: { onChange: (on: boolean) => void }) {
  const [on, setOn] = useState(false)
  const [remainingMs, setRemainingMs] = useState(0)
  const [minutes, setMinutes] = useState(15)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      const s = await api.getServiceMode()
      setOn(s.on)
      setRemainingMs(s.remainingMs)
      onChange(s.on)
    } catch {
      // keep previous
    }
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => clearInterval(t)
  }, [])

  // Local countdown between server refreshes.
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setRemainingMs((ms) => Math.max(0, ms - 1000)), 1000)
    return () => clearInterval(t)
  }, [on])

  async function toggle(next: boolean) {
    setBusy(true)
    setError(null)
    try {
      const s = await api.setServiceMode(next, next ? minutes : undefined)
      setOn(s.on)
      setRemainingMs(s.remainingMs)
      onChange(s.on)
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setError('Servisní režim lze zapnout jen přímo na tomto zařízení (v telefonu).')
      } else {
        setError(e instanceof ApiError ? e.message : 'Přepnutí se nezdařilo.')
      }
    } finally {
      setBusy(false)
    }
  }

  const mins = Math.floor(remainingMs / 60000)
  const secs = Math.floor((remainingMs % 60000) / 1000)

  return (
    <div className={`card admin-card service-card ${on ? 'service-on' : ''}`}>
      <h2 style={{ margin: '0 0 0.25rem' }}>
        Servisní režim {on ? '— zapnutý' : '— vypnutý'}
      </h2>
      {error && <div className="banner error">{error}</div>}
      {on ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Vzdálený přístup přes Wi-Fi je otevřený. Zbývá{' '}
            <strong className="mono">
              {mins}:{String(secs).padStart(2, '0')}
            </strong>
            . Po vypršení se přístup sám zavře.
          </p>
          <button type="button" className="btn danger" onClick={() => toggle(false)} disabled={busy}>
            {busy ? 'Přepínám…' : 'Vypnout teď'}
          </button>
        </>
      ) : (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            Zapne vzdálený přístup z počítače/telefonu na stejné Wi-Fi na omezenou dobu. Mimo tento
            režim server na síti nikoho neobsluhuje — obsluha běží jen zde na terminálu.
          </p>
          <div className="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="muted" htmlFor="svc-min">
              Na dobu (min):
            </label>
            <select
              id="svc-min"
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              style={{ maxWidth: '6rem' }}
            >
              {[5, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <button type="button" className="btn" onClick={() => toggle(true)} disabled={busy}>
              {busy ? 'Zapínám…' : 'Zapnout servisní režim'}
            </button>
          </div>
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
  lanEnabled,
  onOpen,
}: {
  title: string
  desc: string
  url: string
  lanEnabled: boolean
  onOpen: () => void
}) {
  return (
    <div className="card admin-card">
      <h2 style={{ margin: '0 0 0.25rem' }}>{title}</h2>
      <p className="muted" style={{ marginTop: 0 }}>{desc}</p>
      <div className="admin-access">
        {lanEnabled && (
          <img className="admin-qr" src={urls.qrFor(url)} alt="QR odkaz" width={150} height={150} />
        )}
        <div>
          <div className="row" style={{ gap: '0.5rem' }}>
            <button type="button" className="btn" onClick={onOpen}>
              Otevřít tady v telefonu
            </button>
          </div>
          {lanEnabled ? (
            <>
              <div className="admin-url mono" style={{ marginTop: '0.75rem' }}>{url}</div>
              <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
                Naskenuj QR / napiš adresu do prohlížeče na PC.
              </p>
            </>
          ) : (
            <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
              Vzdálená adresa se zobrazí po zapnutí servisního režimu výše.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
