import { useState } from 'react'
import { api, ApiError } from '../lib/api'
import type { OpMode } from '../types'

// Startup mode picker. Shown when no operating mode has been chosen yet, and
// reachable later from Settings to switch. Persists the choice on the backend
// (POST /api/opmode), so every device sees the same mode.
export function ModeSelect({
  current,
  onChosen,
}: {
  current?: OpMode
  onChosen: (mode: OpMode) => void
}) {
  const [busy, setBusy] = useState<OpMode | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function choose(mode: OpMode) {
    setBusy(mode)
    setError(null)
    try {
      await api.setOpMode(mode)
      onChosen(mode)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Nepodařilo se uložit režim.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mode-select">
      <div className="mode-select-inner">
        <h1>Vyberte režim</h1>
        <p className="subtitle">Jak budete platby přijímat? Režim lze později změnit v Nastavení.</p>
        {error && <div className="banner error">{error}</div>}
        <div className="mode-cards">
          <button
            type="button"
            className={`mode-card ${current === 'kasa' ? 'is-current' : ''}`}
            onClick={() => choose('kasa')}
            disabled={busy != null}
          >
            <div className="mode-card-icon" aria-hidden>🧾</div>
            <div className="mode-card-title">Kasa</div>
            <div className="mode-card-desc">
              Obsluha zadá částku, na displeji se zobrazí QR a platba se ověří automaticky.
            </div>
            {busy === 'kasa' && <div className="mode-card-busy">Ukládám…</div>}
          </button>
          <button
            type="button"
            className={`mode-card ${current === 'paper' ? 'is-current' : ''}`}
            onClick={() => choose('paper')}
            disabled={busy != null}
          >
            <div className="mode-card-icon" aria-hidden>📄</div>
            <div className="mode-card-title">Papírové QR</div>
            <div className="mode-card-desc">
              QR máte vytištěné na papíře. Kliknutím spustíte čekání na příchozí platbu a ručně ji ověříte.
            </div>
            {busy === 'paper' && <div className="mode-card-busy">Ukládám…</div>}
          </button>
        </div>
      </div>
    </div>
  )
}
