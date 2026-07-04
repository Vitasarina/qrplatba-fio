import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useOutletContext } from 'react-router-dom'
import { RequirePin } from './RequirePin'
import { ModeSelect } from './ModeSelect'
import { api } from '../lib/api'
import type { OpMode } from '../types'

const linkClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')

// Context handed to child routes so they can adapt to the chosen operating mode
// and switch it (from Settings).
interface AppContext {
  opMode: OpMode
  setOpMode: (m: OpMode) => void
}
export function useAppContext(): AppContext {
  return useOutletContext<AppContext>()
}

export function AppLayout() {
  return (
    <RequirePin>
      <ModeGate />
    </RequirePin>
  )
}

function ModeGate() {
  const [opMode, setOpModeState] = useState<OpMode | null>(null)

  useEffect(() => {
    let stop = false
    api
      .getConfig()
      .then((cfg) => !stop && setOpModeState((cfg.opMode ?? '') as OpMode))
      .catch(() => !stop && setOpModeState('')) // fall back to the picker on error
    return () => {
      stop = true
    }
  }, [])

  const setOpMode = useCallback((m: OpMode) => setOpModeState(m), [])

  if (opMode == null) {
    return (
      <div className="pin-gate">
        <p className="muted">Načítám…</p>
      </div>
    )
  }

  if (opMode === '') {
    return <ModeSelect onChosen={setOpMode} />
  }

  const isPaper = opMode === 'paper'
  return (
    <div className="app">
      <nav className="topnav" aria-label="Hlavní navigace">
        <div className="brand">
          QR <span>Platba</span>
        </div>
        <NavLink to="/operator" className={linkClass}>
          {isPaper ? 'Příjem platby' : 'Obsluha'}
        </NavLink>
        <NavLink to="/today" className={linkClass}>
          Dnešní platby
        </NavLink>
        {!isPaper && (
          <NavLink to="/display" className={linkClass} target="_blank" rel="noreferrer">
            Displej ↗
          </NavLink>
        )}
        <NavLink to="/history" className={linkClass}>
          Historie
        </NavLink>
        <NavLink to="/setup" className={linkClass}>
          Nastavení
        </NavLink>
      </nav>

      <Outlet context={{ opMode, setOpMode } satisfies AppContext} />
    </div>
  )
}
