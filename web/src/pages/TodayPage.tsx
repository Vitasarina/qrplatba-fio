import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { TodayTable } from '../components/TodayPayments'
import type { TodayTransaction } from '../types'

const REFRESH_MS = 15_000

export function TodayPage() {
  const [txs, setTxs] = useState<TodayTransaction[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Avoid clobbering a manual refresh with a stale auto-refresh response.
  const reqId = useRef(0)

  async function load(showSpinner = false) {
    if (showSpinner) setLoading(true)
    const id = ++reqId.current
    try {
      const data = await api.getTodayTransactions()
      if (id !== reqId.current) return
      setTxs(data)
      setError(null)
    } catch (err) {
      if (id !== reqId.current) return
      setError(err instanceof ApiError ? err.message : 'Nepodařilo se načíst dnešní platby.')
      setTxs((prev) => prev ?? [])
    } finally {
      if (id === reqId.current && showSpinner) setLoading(false)
    }
  }

  useEffect(() => {
    load(true)
    const t = setInterval(() => load(false), REFRESH_MS)
    return () => clearInterval(t)
  }, [])

  return (
    <main className="page">
      <div className="row between" style={{ marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>Dnešní platby</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Příchozí platby z banky za dnešek — čas, částka a jméno plátce. Slouží k ověření, že
            platba dorazila, aniž byste se museli přihlašovat do banky. Obnovuje se sama zhruba
            každých 15 sekund.
          </p>
        </div>
        <button
          type="button"
          className="btn secondary"
          onClick={() => load(true)}
          disabled={loading}
        >
          {loading ? <span className="spinner" aria-hidden /> : null}
          Obnovit
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="card">
        {loading && !txs ? (
          <p className="muted">Načítám…</p>
        ) : txs && txs.length > 0 ? (
          <TodayTable txs={txs} />
        ) : (
          <div className="empty">Dnes zatím nedorazila žádná platba.</div>
        )}
      </div>
    </main>
  )
}
