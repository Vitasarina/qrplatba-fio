import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, urls } from '../lib/api'
import { useSession } from '../lib/useSession'
import { formatCzk, isTerminal } from '../lib/format'
import type { DisplayConfig, Session } from '../types'

// Two-sided kiosk display. The phone lies FLAT between the operator and the
// customer, who sit on opposite sides — so screens are oriented 180° apart.
// This single page is therefore BOTH the operator's input (a custom numpad)
// and the customer's display (screensaver / QR / result).
//
// View state machine (`view`):
//   idle    — screensaver (customer-facing). No active session.
//   entry   — custom numpad (operator-facing). Operator types the amount.
//   session — driven by the live session: big QR while PENDING/UNKNOWN, then the
//             terminal result (held ~10 s). Customer-facing.
//
// Transitions:
//   double-tap on idle              → entry
//   numpad Enter (valid amount)     → createSession → view follows the session
//   double-tap on entry/QR/result   → close: cancel any live session, back to idle
//   5 quick taps in top-right corner→ /admin (separate, unchanged)
type View = 'idle' | 'entry' | 'session'

const DOUBLE_TAP_MS = 400

export function DisplayPage() {
  // An explicit ?id= still pins a specific session (used when the operator opens
  // one from another screen); in that case we stay session-driven and skip the
  // local numpad/idle flow.
  const explicitId = new URLSearchParams(window.location.search).get('id')
  const [discoveredId, setDiscoveredId] = useState<string | null>(null)
  // The session created locally by the numpad. Tracked so it takes precedence
  // immediately (before auto-discovery catches up) and so a close can cancel it.
  const [localId, setLocalId] = useState<string | null>(null)
  const [view, setView] = useState<View>('idle')
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

  const activeId = explicitId ?? localId ?? discoveredId

  // Poll for the newest active session when no explicit id is given. This keeps
  // the display "always on" between payments and lets the customer side react
  // to sessions started from another device.
  useEffect(() => {
    if (explicitId) return
    let stop = false

    async function poll() {
      try {
        const active = await api.getActiveSession()
        if (!stop) setDiscoveredId(active ? active.id : null)
      } catch {
        // Backend unreachable — keep showing the current view; will retry.
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

  // Public display config (shop name + logo + flipped) for the idle screensaver
  // and the rotation. Polled occasionally so a logo/flip change in Setup is
  // picked up without a reload.
  const [displayConfig, setDisplayConfig] = useState<DisplayConfig>({
    name: '',
    logoUrl: '',
    mode: undefined,
    flipped: false,
  })
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
  // Id of a session the operator deliberately cancelled via the close gesture.
  // Its terminal (CANCELLED) result must NOT be pinned for 10 s — the operator
  // asked to go straight back to the screensaver.
  const dismissedId = useRef<string | null>(null)
  useEffect(() => {
    if (session && isTerminal(session.status) && session.id !== dismissedId.current) {
      setHeld(session)
    }
  }, [session?.id, session?.status])
  useEffect(() => {
    if (!held) return
    const t = setTimeout(() => setHeld(null), 10000)
    return () => clearTimeout(t)
  }, [held?.id])

  // Precedence: a live unfinished payment wins; otherwise the held 10 s result; else none.
  const shown: Session | null = session && !isTerminal(session.status) ? session : held

  // Drive the view from the session lifecycle:
  //   - any session to show (live or held result) → 'session'
  //   - session gone AND we were on 'session'      → back to 'idle' (screensaver)
  // 'entry' (numpad) is left untouched here so typing isn't interrupted; it only
  // leaves 'entry' once a session actually exists (Enter created one).
  useEffect(() => {
    if (shown) {
      setView('session')
    } else {
      setView((v) => (v === 'session' ? 'idle' : v))
      // A finished/cleared local session must stop pinning the id.
      setLocalId(null)
    }
  }, [shown])

  // Close gesture: cancel any live (non-terminal) session, then return to idle.
  const closeToIdle = useCallback(() => {
    const live = session && !isTerminal(session.status) ? session.id : null
    if (live) {
      dismissedId.current = live // its CANCELLED result must not be held for 10 s
      api.cancelSession(live).catch(() => {
        // Best-effort: even if cancel fails, drop back to idle locally; the next
        // poll/SSE frame reconciles the real session state.
      })
    }
    setLocalId(null)
    setHeld(null)
    setView('idle')
  }, [session])

  // Double-tap detection. Two taps within DOUBLE_TAP_MS toggles between idle and
  // entry/close. The handler ignores taps on numpad buttons (so typing numbers
  // never triggers navigation) and on the admin corner (its own element).
  const lastTap = useRef(0)
  function onSurfaceTap(e: React.MouseEvent) {
    const target = e.target as HTMLElement
    // Ignore numpad taps (typing) and the hidden admin corner — both have their
    // own handlers and must not double-tap-navigate.
    if (target.closest('.numpad') || target.closest('.secret-trigger')) return

    const now = Date.now()
    if (now - lastTap.current <= DOUBLE_TAP_MS) {
      lastTap.current = 0 // consume, so a third tap doesn't immediately re-fire
      if (view === 'idle') setView('entry')
      else closeToIdle()
    } else {
      lastTap.current = now
    }
  }

  // Rotation. Customer-facing screens (idle/session) and the operator-facing
  // numpad (entry) are 180° apart. `flipped` swaps which side gets which.
  // Default (flipped=false): customer at 180°, numpad at 0°.
  const flipped = displayConfig.flipped ?? false
  const isOperatorView = view === 'entry'
  const rotation = isOperatorView ? (flipped ? 180 : 0) : flipped ? 0 : 180

  return (
    <div
      className="display"
      onClick={onSurfaceTap}
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      {/* Invisible hidden-admin trigger: 5 quick taps in the top-right corner. */}
      <div className="secret-trigger" onClick={onSecretTap} aria-hidden />
      {/* Subtle test-mode marker so a customer display in simulation can't be
          mistaken for a live till. Kept small so it doesn't dominate. */}
      {displayConfig.mode === 'simulace' && (
        <div className="sim-marker" aria-hidden>
          ZKUŠEBNÍ REŽIM
        </div>
      )}

      {view === 'entry' ? (
        <Numpad onSubmit={(id) => setLocalId(id)} />
      ) : (
        <DisplayContent session={shown} displayConfig={displayConfig} />
      )}
    </div>
  )
}

// Custom numeric keypad (operator-facing). The amount is shown in a plain <div>
// — NEVER an <input> — so the phone's system keyboard cannot appear. The buffer
// is a raw decimal string the operator builds up; we format it for display.
function Numpad({ onSubmit }: { onSubmit: (sessionId: string) => void }) {
  const [buffer, setBuffer] = useState('') // raw, e.g. "149,9" or "0,05"
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function press(key: string) {
    setError(null)
    setBuffer((prev) => applyKey(prev, key))
  }

  const value = parseAmount(buffer)
  const canSubmit = value != null && value > 0 && !busy

  async function submit() {
    const amount = parseAmount(buffer)
    if (amount == null || amount <= 0) {
      setError('Zadejte částku větší než 0.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await api.createSession(amount)
      onSubmit(created.id) // hand the session to the parent → QR screen shows
    } catch {
      setError('Nepodařilo se vytvořit platbu. Zkuste to znovu.')
      setBusy(false)
    }
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', ',']

  return (
    <div className="numpad">
      <div className="numpad-amount" aria-live="polite">
        {formatBuffer(buffer)} <span className="numpad-czk">Kč</span>
      </div>
      {error && <div className="numpad-error">{error}</div>}
      <div className="numpad-grid">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            className={`numpad-key ${k === 'C' ? 'numpad-key-clear' : ''}`}
            onClick={() => press(k)}
            disabled={busy}
          >
            {k}
          </button>
        ))}
        <button
          type="button"
          className="numpad-key numpad-key-back"
          onClick={() => press('back')}
          disabled={busy}
          aria-label="Smazat poslední znak"
        >
          ⌫
        </button>
        <button
          type="button"
          className="numpad-key numpad-key-enter"
          onClick={submit}
          disabled={!canSubmit}
          aria-label="Potvrdit částku"
        >
          {busy ? '…' : 'Enter'}
        </button>
      </div>
    </div>
  )
}

// --- Numpad buffer helpers (pure, so they're easy to reason about) ---

// Apply one key to the raw buffer string. Rules: ',' is the decimal separator
// (only one allowed), max 2 decimals, leading zeros collapsed sensibly, 'C'
// clears, 'back' deletes the last char.
function applyKey(prev: string, key: string): string {
  if (key === 'C') return ''
  if (key === 'back') return prev.slice(0, -1)
  if (key === ',') {
    if (prev.includes(',')) return prev // only one decimal separator
    if (prev === '') return '0,' // ",5" → "0,5"
    return prev + ','
  }
  // A digit.
  const [intPart, decPart] = prev.split(',')
  if (prev.includes(',')) {
    if ((decPart ?? '').length >= 2) return prev // max 2 decimal places
    return prev + key
  }
  // Integer part: collapse a lone leading zero ("0" + "5" → "5"), but keep "0"
  // until a separator follows.
  if (intPart === '0') return key === '0' ? '0' : key
  return prev + key
}

// Parse the raw buffer (comma → dot) into a number, or null if empty/invalid.
function parseAmount(buffer: string): number | null {
  if (!buffer || buffer === ',') return null
  const n = Number(buffer.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// Format the buffer for the on-screen amount. Empty shows "0".
function formatBuffer(buffer: string): string {
  if (buffer === '') return '0'
  return buffer
}

function DisplayContent({
  session,
  displayConfig,
}: {
  session: Session | null
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
