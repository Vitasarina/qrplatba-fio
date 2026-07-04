import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useSession } from '../lib/useSession'
import { formatCzk, formatClock } from '../lib/format'
import { playFail, playSuccess, unlockSound } from '../lib/sound'
import { TodayOverlay } from './TodayPayments'
import type { DisplayConfig, Session } from '../types'

// Paper-mode operation (dark themed). The QR is printed on paper; the operator
// knows a payment is coming and taps "Čekat na platbu". The app watches the bank
// for the next incoming payment until it arrives or a ~2-minute timeout elapses,
// plays a sound on the result, and offers a "today's payments" list.
const WATCH_TIMEOUT_S = 120

export function PaperWatch() {
  const [watchId, setWatchId] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showToday, setShowToday] = useState(false)
  const [cfg, setCfg] = useState<DisplayConfig>({ name: '', logoUrl: '', flipped: false })

  // Shop logo/name for the header.
  useEffect(() => {
    let stop = false
    api.getDisplayConfig().then((c) => !stop && setCfg(c)).catch(() => {})
    return () => {
      stop = true
    }
  }, [])

  const { session } = useSession(watchId)

  // Play the result sound exactly once per terminal transition.
  const soundedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!session || session.id === soundedFor.current) return
    if (session.status === 'PAID' || session.status === 'OVERPAID') {
      soundedFor.current = session.id
      playSuccess()
    } else if (session.status === 'EXPIRED') {
      soundedFor.current = session.id
      playFail()
    }
  }, [session?.id, session?.status])

  async function start() {
    unlockSound() // this tap is our chance to enable audio
    setError(null)
    setStarting(true)
    try {
      const s = await api.createWatchSession() // watch for the NEXT incoming payment (any amount)
      soundedFor.current = null
      setWatchId(s.id)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Nepodařilo se spustit čekání na platbu.')
    } finally {
      setStarting(false)
    }
  }

  async function cancel() {
    if (watchId) await api.cancelSession(watchId).catch(() => {})
    reset()
  }

  function reset() {
    setWatchId(null)
    setError(null)
  }

  return (
    <div className="paper">
      <header className="paper-header">
        {cfg.logoUrl ? (
          <img src={cfg.logoUrl} alt={cfg.name || 'logo'} className="paper-logo" />
        ) : (
          <span className="paper-title">{cfg.name || 'QR Platba'}</span>
        )}
      </header>

      {session && watchId ? (
        <WatchStatus session={session} onDone={reset} onCancel={cancel} />
      ) : (
        <main className="paper-body">
          <p className="paper-intro">
            Zákazník naskenuje vytištěný QR kód. Až bude platit, klikněte na „Čekat na platbu“ a
            aplikace ohlídá příchozí platbu (do {WATCH_TIMEOUT_S} sekund).
          </p>

          {error && <div className="banner error">{error}</div>}

          <button type="button" className="btn lg block paper-cta" onClick={start} disabled={starting}>
            {starting ? 'Spouštím…' : 'Čekat na platbu'}
          </button>

          <button
            type="button"
            className="btn secondary block"
            style={{ marginTop: '1rem' }}
            onClick={() => setShowToday(true)}
          >
            Dnešní platby
          </button>
        </main>
      )}

      {showToday && <TodayOverlay onClose={() => setShowToday(false)} />}
    </div>
  )
}

// Live waiting / terminal result for a watch session.
function WatchStatus({
  session,
  onDone,
  onCancel,
}: {
  session: Session
  onDone: () => void
  onCancel: () => void
}) {
  const paid = session.status === 'PAID' || session.status === 'OVERPAID'
  const expired = session.status === 'EXPIRED' || session.status === 'CANCELLED'
  const waiting = !paid && !expired

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [waiting])
  const remaining = Math.max(0, Math.ceil((new Date(session.expiresAt).getTime() - now) / 1000))

  return (
    <main className="paper-body">
      {waiting && (
        <div className="watch-waiting">
          <div className="spinner lg" aria-hidden />
          <h1>Čekám na platbu…</h1>
          <p className="paper-muted">Zachytím první příchozí platbu.</p>
          <div className="watch-countdown">Zbývá {remaining}s</div>
          <button type="button" className="btn danger" onClick={onCancel} style={{ marginTop: '1.5rem' }}>
            Zrušit čekání
          </button>
        </div>
      )}

      {paid && (
        <div className="watch-result watch-ok">
          <div className="result-icon result-paid" aria-hidden>✓</div>
          <h1>Platba přijata</h1>
          <div className="watch-amount">{formatCzk(session.receivedAmount ?? session.amount)}</div>
          <dl className="kv paper-kv">
            {session.payerName && (
              <>
                <dt>Plátce</dt>
                <dd>{session.payerName}</dd>
              </>
            )}
            {session.paidAt && (
              <>
                <dt>Čas přijetí</dt>
                <dd>{formatClock(session.paidAt)}</dd>
              </>
            )}
          </dl>
          <button type="button" className="btn lg block" onClick={onDone} style={{ marginTop: '1.5rem' }}>
            Hotovo
          </button>
        </div>
      )}

      {expired && (
        <div className="watch-result watch-fail">
          <div className="result-icon result-fail" aria-hidden>✗</div>
          <h1>{session.status === 'CANCELLED' ? 'Čekání zrušeno' : 'Platba nedorazila'}</h1>
          {session.status !== 'CANCELLED' && (
            <p className="paper-muted">Během vymezeného času nedorazila žádná platba.</p>
          )}
          <button type="button" className="btn lg block" onClick={onDone} style={{ marginTop: '1.5rem' }}>
            Zpět
          </button>
        </div>
      )}
    </main>
  )
}

