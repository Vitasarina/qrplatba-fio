import { useEffect, useState } from 'react'
import { getPin, setPin } from '../lib/pin'

interface Props {
  onClose: () => void
}

// Lightweight modal to set/clear the operator PIN stored in localStorage.
export function PinDialog({ onClose }: Props) {
  const [value, setValue] = useState(getPin())

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function save() {
    setPin(value.trim())
    onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Nastavení PINu obsluhy"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        zIndex: 50,
      }}
    >
      <div className="card" style={{ width: '100%', maxWidth: 380 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>PIN obsluhy</h2>
        <p className="muted" style={{ fontSize: '0.9rem', marginTop: 0 }}>
          PIN se posílá serveru u zadávání plateb a nastavení. Uloží se jen v tomto prohlížeči.
        </p>
        <div className="field">
          <label htmlFor="pin-input">PIN</label>
          <input
            id="pin-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            placeholder="např. 1234"
          />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn secondary" onClick={onClose}>
            Zrušit
          </button>
          <button type="button" className="btn" onClick={save}>
            Uložit
          </button>
        </div>
      </div>
    </div>
  )
}
