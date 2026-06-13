import { useEffect, useState } from 'react'
import { api, ApiError, urls } from '../lib/api'
import { formatCzk, formatTime } from '../lib/format'
import type { Session } from '../types'
import { StatusBadge } from '../components/StatusBadge'

export function HistoryPage() {
  const [sessions, setSessions] = useState<Session[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const data = await api.listSessions()
      // Newest first (defensive — backend order not guaranteed by contract).
      const sorted = [...data].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      setSessions(sorted)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Nepodařilo se načíst historii.')
      setSessions([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <main className="page">
      <div className="row between" style={{ marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>Historie</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Přehled vystavených plateb.
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn secondary" onClick={load} disabled={loading}>
            {loading ? <span className="spinner" aria-hidden /> : null}
            Obnovit
          </button>
          <a className="btn" href={urls.exportCsv} download>
            Export CSV
          </a>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="card">
        {loading && !sessions ? (
          <p className="muted">Načítám…</p>
        ) : sessions && sessions.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Stav</th>
                  <th>Částka</th>
                  <th>VS</th>
                  <th>Čas</th>
                  <th>Spárováno</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <StatusBadge status={s.status} />
                    </td>
                    <td>{formatCzk(s.amount)}</td>
                    <td className="mono">{s.vs}</td>
                    <td>{formatTime(s.createdAt)}</td>
                    <td>{s.matchedTxId ? formatTime(s.paidAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">Zatím žádné platby.</div>
        )}
      </div>
    </main>
  )
}
