import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { PinDialog } from './PinDialog'
import { RequirePin } from './RequirePin'
import { getPin } from '../lib/pin'

const linkClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')

export function AppLayout() {
  const [pinOpen, setPinOpen] = useState(false)
  // Re-read on each render after the dialog closes; cheap enough.
  const hasPin = getPin().length > 0

  return (
    <RequirePin>
    <div className="app">
      <nav className="topnav" aria-label="Hlavní navigace">
        <div className="brand">
          QR <span>Platba</span>
        </div>
        <NavLink to="/operator" className={linkClass}>
          Obsluha
        </NavLink>
        <NavLink to="/today" className={linkClass}>
          Dnešní platby
        </NavLink>
        <NavLink to="/display" className={linkClass} target="_blank" rel="noreferrer">
          Displej ↗
        </NavLink>
        <NavLink to="/history" className={linkClass}>
          Historie
        </NavLink>
        <NavLink to="/setup" className={linkClass}>
          Nastavení
        </NavLink>
        <span className="spacer" />
        <button
          type="button"
          className="btn secondary"
          style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
          onClick={() => setPinOpen(true)}
        >
          {hasPin ? 'PIN ✓' : 'Nastavit PIN'}
        </button>
      </nav>

      <Outlet />

      {pinOpen && <PinDialog onClose={() => setPinOpen(false)} />}
    </div>
    </RequirePin>
  )
}
