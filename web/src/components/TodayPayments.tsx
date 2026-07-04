import { useEffect, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { formatCzk, formatClock } from '../lib/format'
import type { TodayTransaction } from '../types'

// Shared today's-incoming-payments table: Čas / Částka / Jméno (time only, no date),
// so the amount and payer name are always visible even on a narrow screen.
export function TodayTable({ txs, className }: { txs: TodayTransaction[]; className?: string }) {
  return (
    <div className="table-wrap">
      <table className={className}>
        <thead>
          <tr>
            <th>Čas</th>
            <th>Částka</th>
            <th>Jméno</th>
          </tr>
        </thead>
        <tbody>
          {txs.map((tx) => (
            <tr key={tx.externalId}>
              <td>{formatClock(tx.receivedAt)}</td>
              <td>{formatCzk(Number(tx.amount))}</td>
              <td>{tx.counterpartyName ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Dark modal overlay listing today's payments — used by the kasa display (numpad)
// and paper mode. Tap the backdrop or "Zavřít" to close.
export function TodayOverlay({ onClose }: { onClose: () => void }) {
  const [txs, setTxs] = useState<TodayTransaction[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      setTxs(await api.getTodayTransactions())
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Nepodařilo se načíst dnešní platby.')
    }
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [])

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="overlay-panel paper-panel" onClick={(e) => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: '1rem' }}>
          <h2 style={{ margin: 0 }}>Dnešní platby</h2>
          <button type="button" className="btn secondary" onClick={onClose}>
            Zavřít
          </button>
        </div>
        {error && <div className="banner error">{error}</div>}
        {txs == null ? (
          <p className="paper-muted">Načítám…</p>
        ) : txs.length === 0 ? (
          <div className="empty">Dnes zatím nedorazila žádná platba.</div>
        ) : (
          <TodayTable txs={txs} className="paper-table" />
        )}
      </div>
    </div>
  )
}
