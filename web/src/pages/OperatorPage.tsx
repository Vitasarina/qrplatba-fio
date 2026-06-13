import { useEffect, useState } from 'react'
import { api, ApiError, urls } from '../lib/api'
import { getPin } from '../lib/pin'
import { useSession } from '../lib/useSession'
import { formatCzk, formatTime, isTerminal, STATUS_META } from '../lib/format'
import type { AppMode, Session } from '../types'
import { StatusBadge } from '../components/StatusBadge'
import { SseIndicator } from '../components/SseIndicator'

export function OperatorPage() {
  const [amountStr, setAmountStr] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [amountError, setAmountError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [mode, setMode] = useState<AppMode | null>(null)

  // Surface the operating mode so the operator knows whether payments are real.
  // Uses the public display-config (also reports `mode`); polled so a token
  // change in Setup is reflected without a reload.
  useEffect(() => {
    let stop = false
    async function load() {
      try {
        const cfg = await api.getDisplayConfig()
        if (!stop) setMode(cfg.mode ?? null)
      } catch {
        // keep previous; mode banner just won't update
      }
    }
    load()
    const t = setInterval(load, 30000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [])

  // Live status for the just-created session.
  const { session, sseState, error: sseError } = useSession(activeId)

  function parseAmount(value: string): number | null {
    const normalized = value.replace(/\s/g, '').replace(',', '.')
    const n = Number(normalized)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.round(n * 100) / 100
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setAmountError(null)

    const amount = parseAmount(amountStr)
    if (amount == null) {
      setAmountError('Zadejte částku větší než 0 (např. 149,90).')
      return
    }
    if (!getPin()) {
      setError('Nejprve nastavte PIN obsluhy (tlačítko vpravo nahoře).')
      return
    }

    setSubmitting(true)
    try {
      const created = await api.createSession(amount, note)
      setActiveId(created.id)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nepodařilo se vystavit platbu.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCancel() {
    if (!activeId) return
    try {
      await api.cancelSession(activeId)
      // SSE will push CANCELLED; no local mutation needed.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Zrušení se nezdařilo.')
    }
  }

  function startOver() {
    setActiveId(null)
    setAmountStr('')
    setNote('')
    setError(null)
  }

  // ----- Active session view -----
  if (activeId) {
    return (
      <main className="page">
        <div className="row between" style={{ marginBottom: '1rem' }}>
          <h1 style={{ margin: 0 }}>Aktivní platba</h1>
          <SseIndicator state={sseState} />
        </div>

        {mode === 'simulace' && <SimModeBanner />}

        {sseError && <div className="banner warning">{sseError}</div>}

        {!session ? (
          <div className="card">
            <p className="muted">Načítám relaci…</p>
          </div>
        ) : (
          <ActiveSession session={session} onCancel={handleCancel} onStartOver={startOver} />
        )}
      </main>
    )
  }

  // ----- Entry form -----
  return (
    <main className="page">
      <h1>Zadání platby</h1>
      <p className="subtitle">Zadejte částku a vystavte QR platbu pro zákazníka.</p>

      {mode === 'simulace' && <SimModeBanner />}

      <form className="card" onSubmit={handleSubmit} noValidate>
        {error && <div className="banner error">{error}</div>}

        <div className="field">
          <label htmlFor="amount">Částka (CZK)</label>
          <input
            id="amount"
            type="text"
            inputMode="decimal"
            autoFocus
            className={amountError ? 'invalid' : ''}
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value)}
            placeholder="0,00"
            aria-invalid={!!amountError}
            aria-describedby={amountError ? 'amount-err' : undefined}
          />
          {amountError && (
            <div className="field-error" id="amount-err">
              {amountError}
            </div>
          )}
        </div>

        <div className="field">
          <label htmlFor="note">Poznámka (volitelné)</label>
          <input
            id="note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="např. Stůl 4, Káva"
            maxLength={140}
          />
        </div>

        <button type="submit" className="btn lg block" disabled={submitting}>
          {submitting ? <span className="spinner" aria-hidden /> : null}
          {submitting ? 'Vystavuji…' : 'Vystavit platbu'}
        </button>
      </form>
    </main>
  )
}

// ---------------------------------------------------------------------------

function ActiveSession({
  session: liveSession,
  onCancel,
  onStartOver,
}: {
  session: Session
  onCancel: () => void
  onStartOver: () => void
}) {
  // Manual "Ověřit platbu" returns a fresh session synchronously; show it
  // immediately. SSE keeps pushing afterwards, so prefer whichever is newer:
  // the SSE-driven `liveSession` wins as soon as the next frame arrives.
  const [checked, setChecked] = useState<Session | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  // Use the manually-checked snapshot only until the live session matches/passes it.
  const session =
    checked && checked.id === liveSession.id && checked.status !== liveSession.status
      ? checked
      : liveSession

  async function handleCheck() {
    setChecking(true)
    setCheckError(null)
    try {
      const updated = await api.checkSession(liveSession.id)
      setChecked(updated)
    } catch (e) {
      setCheckError(e instanceof ApiError ? e.message : 'Ověření platby se nezdařilo.')
    } finally {
      setChecking(false)
    }
  }

  const terminal = isTerminal(session.status)
  const paid = session.status === 'PAID' || session.status === 'OVERPAID'
  // The session is still open (worth re-checking) in these states.
  const open =
    session.status === 'PENDING' ||
    session.status === 'UNDERPAID' ||
    session.status === 'UNKNOWN'

  const shortfall =
    session.status === 'UNDERPAID' && session.receivedAmount != null
      ? session.amount - session.receivedAmount
      : null
  const overpay =
    session.status === 'OVERPAID' && session.receivedAmount != null
      ? session.receivedAmount - session.amount
      : null

  return (
    <>
      {/* Prominent result banner for terminal states. */}
      {paid && (
        <div className="banner success">
          ✓ {STATUS_META[session.status].label}
          {overpay != null && overpay > 0 && <> — přeplatek {formatCzk(overpay)}</>}
        </div>
      )}
      {session.status === 'UNDERPAID' && (
        <div className="banner warning">
          Dorazilo méně, než bylo požadováno.
          {shortfall != null && <> Chybí {formatCzk(shortfall)}.</>} Rozhodněte, zda platbu zrušit.
        </div>
      )}
      {session.status === 'EXPIRED' && (
        <div className="banner error">Platba vypršela. QR kód už není platný.</div>
      )}
      {session.status === 'CANCELLED' && <div className="banner info">Platba byla zrušena.</div>}
      {session.status === 'UNKNOWN' && (
        <div className="banner warning">Stav platby nelze ověřit (výpadek banky). Vyčkejte.</div>
      )}

      <div className="card">
        <div className="session-grid">
          <div className="qr-box">
            {!terminal ? (
              <>
                <img src={urls.qrImage(session.id)} alt={`QR platba ${session.vs}`} />
                <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: '0.85rem' }}>
                  Použijte okamžitou platbu
                </p>
              </>
            ) : (
              <div style={{ fontSize: '3.5rem', padding: '2rem 0' }}>{paid ? '✓' : '—'}</div>
            )}
          </div>

          <div>
            <StatusBadge status={session.status} />
            <div className="big-amount">{formatCzk(session.amount)}</div>

            <dl className="kv">
              <dt>VS</dt>
              <dd className="mono">{session.vs}</dd>
              {session.note && (
                <>
                  <dt>Poznámka</dt>
                  <dd>{session.note}</dd>
                </>
              )}
              {session.receivedAmount != null && (
                <>
                  <dt>Přijato</dt>
                  <dd>{formatCzk(session.receivedAmount)}</dd>
                </>
              )}
              <dt>Platnost do</dt>
              <dd>{formatTime(session.expiresAt)}</dd>
              {session.paidAt && (
                <>
                  <dt>Zaplaceno</dt>
                  <dd>{formatTime(session.paidAt)}</dd>
                </>
              )}
            </dl>

            <div className="row" style={{ marginTop: '1.25rem' }}>
              {!terminal ? (
                <button type="button" className="btn danger" onClick={onCancel}>
                  Zrušit platbu
                </button>
              ) : (
                <button type="button" className="btn" onClick={onStartOver}>
                  Nová platba
                </button>
              )}
              {open && (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={handleCheck}
                  disabled={checking}
                >
                  {checking ? <span className="spinner" aria-hidden /> : null}
                  {checking ? 'Ověřuji…' : 'Ověřit platbu'}
                </button>
              )}
            </div>
            {open && (
              <>
                {checkError && (
                  <div className="banner error" style={{ marginTop: '0.75rem' }}>
                    {checkError}
                  </div>
                )}
                <p className="muted" style={{ fontSize: '0.8rem', marginTop: '0.5rem' }}>
                  Aplikace stav platby ověřuje automaticky přibližně každých 30 sekund.
                  Tlačítkem „Ověřit platbu“ provedete kontrolu v bance okamžitě.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// Unobtrusive banner shown when the app runs without a Fio token: payments are
// auto-confirmed server-side, so the operator must know they aren't real.
function SimModeBanner() {
  return (
    <div className="banner sim-warning" style={{ marginBottom: '1rem' }}>
      🧪 Zkušební režim — platby nejsou skutečné. Pro ostrý provoz vyplňte Fio token v Nastavení.
    </div>
  )
}
