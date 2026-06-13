import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, urls } from '../lib/api'
import { useSession } from '../lib/useSession'
import { formatCzk, isTerminal } from '../lib/format'
import type { DisplayConfig, Session } from '../types'

// Customer-facing screen on the tablet, turned toward the customer.
// No PIN needed (runs locally on the tablet). It needs to know WHICH session is
// active. Two supported ways:
//   1) ?id=<sessionId>  — explicit (used when the operator opens a specific session)
//   2) auto-discovery    — poll the public GET /api/sessions/active (no PIN).
// Auto-discovery keeps the display "always on" between payments without manual wiring.
export function DisplayPage() {
  const explicitId = new URLSearchParams(window.location.search).get('id')
  const [discoveredId, setDiscoveredId] = useState<string | null>(null)
  const navigate = useNavigate()

  // Hidden admin trigger: 5 quick taps in the top-right corner open the admin screen.
  const taps = useRef<{ count: number; last: number }>({ count: 0, last: 0 })
  function onSecretTap() {
    const now = Date.now()
    const t = taps.current
    if (now - t.last > 2000) t.count = 0
    t.count += 1
    t.last = now
    if (t.count >= 5) {
      t.count = 0
      navigate('/admin')
    }
  }

  const activeId = explicitId ?? discoveredId

  // Poll for the newest active session when no explicit id is given.
  useEffect(() => {
    if (explicitId) return
    let stop = false

    async function poll() {
      try {
        const active = await api.getActiveSession()
        if (!stop) setDiscoveredId(active ? active.id : null)
      } catch {
        // Backend unreachable — keep showing idle; will retry.
      }
    }

    poll()
    const t = setInterval(poll, 3000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [explicitId])

  const { session } = useSession(activeId)

  // Public display config (shop name + logo) for the idle screensaver. Polled
  // occasionally so a logo change in Setup is picked up without a reload.
  const [displayConfig, setDisplayConfig] = useState<DisplayConfig>({ name: '', logoUrl: '', mode: undefined })
  useEffect(() => {
    let stop = false
    async function load() {
      try {
        const cfg = await api.getDisplayConfig()
        if (!stop) setDisplayConfig(cfg)
      } catch {
        // keep previous; display stays usable offline
      }
    }
    load()
    const t = setInterval(load, 30000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [])

  // When a payment reaches a terminal state, pin that result on screen for 10 s.
  // Split into two effects: capturing the result must NOT also own the 10 s timer,
  // otherwise auto-discovery nulling the session (≈3 s later) would cancel the timer
  // and the result would hang forever. The clear-timer is keyed on the held id, so it
  // runs to completion regardless of what the live session does.
  const [held, setHeld] = useState<Session | null>(null)
  useEffect(() => {
    if (session && isTerminal(session.status)) setHeld(session)
  }, [session?.id, session?.status])
  useEffect(() => {
    if (!held) return
    const t = setTimeout(() => setHeld(null), 10000)
    return () => clearTimeout(t)
  }, [held?.id])

  // Precedence: a live unfinished payment wins; otherwise the held 10 s result; else idle.
  const shown: Session | null =
    session && !isTerminal(session.status) ? session : held

  return (
    <div className="display">
      {/* Invisible hidden-admin trigger: 5 quick taps in the top-right corner. */}
      <div className="secret-trigger" onClick={onSecretTap} aria-hidden />
      {/* Subtle test-mode marker so a customer display in simulation can't be
          mistaken for a live till. Kept small so it doesn't dominate. */}
      {displayConfig.mode === 'simulace' && (
        <div className="sim-marker" aria-hidden>
          ZKUŠEBNÍ REŽIM
        </div>
      )}
      <DisplayContent session={shown} displayConfig={displayConfig} />
    </div>
  )
}

function DisplayContent({
  session,
  displayConfig,
}: {
  session: ReturnType<typeof useSession>['session']
  displayConfig: DisplayConfig
}) {
  // ----- Idle: screensaver -----
  if (!session) {
    return <IdleScreensaver config={displayConfig} />
  }

  // ----- Terminal result -----
  if (isTerminal(session.status)) {
    const paid = session.status === 'PAID' || session.status === 'OVERPAID'
    return (
      <>
        <div className={`result-icon ${paid ? 'result-paid' : 'result-fail'}`}>{paid ? '✓' : '✗'}</div>
        <div className="result-label">{paid ? 'Zaplaceno' : 'Vypršelo'}</div>
        {paid && <div className="display-amount" style={{ fontSize: 'clamp(2rem,5vw,3rem)' }}>{formatCzk(session.amount)}</div>}
      </>
    )
  }

  // ----- Active (PENDING / UNKNOWN): big QR -----
  return (
    <>
      <div className="display-amount">{formatCzk(session.amount)}</div>
      <div className="display-qr">
        <img src={urls.qrImage(session.id)} alt="QR kód pro platbu" />
      </div>
      <div className="display-hint">Použijte okamžitou platbu</div>
      {session.status === 'UNKNOWN' ? (
        <div className="display-verifying">
          <div className="verify-text">Ověřuji platbu…</div>
          <div className="progress-indeterminate" aria-hidden>
            <span />
          </div>
        </div>
      ) : (
        <div className="display-status">Naskenujte QR kód ve své bankovní aplikaci</div>
      )}
    </>
  )
}

// Idle screensaver: full-width logo with a "QR platba" caption underneath,
// centred by default. To prevent burn-in on an always-on display, the block is
// nudged up/down ~25% of the screen every 30 minutes (discrete, no constant
// motion). Cycle: centre → up → centre → down → …
const SCREENSAVER_OFFSETS = ['0', '-25vh', '0', '25vh']
const SCREENSAVER_SHIFT_MS = 30 * 60 * 1000

function IdleScreensaver({ config }: { config: DisplayConfig }) {
  const [logoFailed, setLogoFailed] = useState(false)
  const [posIndex, setPosIndex] = useState(0)

  useEffect(() => {
    setLogoFailed(false)
  }, [config.logoUrl])

  useEffect(() => {
    const t = setInterval(
      () => setPosIndex((i) => (i + 1) % SCREENSAVER_OFFSETS.length),
      SCREENSAVER_SHIFT_MS,
    )
    return () => clearInterval(t)
  }, [])

  const showLogo = !!config.logoUrl && !logoFailed
  return (
    <div className="screensaver">
      <div
        className="screensaver-block"
        style={{ transform: `translateY(${SCREENSAVER_OFFSETS[posIndex]})` }}
      >
        {showLogo ? (
          <img
            src={config.logoUrl}
            alt={config.name || 'logo'}
            className="screensaver-logo"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <div className="screensaver-name">{config.name || 'QR Platba'}</div>
        )}
        <div className="screensaver-caption">QR platba</div>
      </div>
    </div>
  )
}
