import { NavLink, Outlet } from 'react-router-dom'
import { RequirePin } from './RequirePin'

const linkClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')

export function AppLayout() {
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
        </nav>

        <Outlet />
      </div>
    </RequirePin>
  )
}
