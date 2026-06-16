import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom'
import './styles.css'
import { AppLayout } from './components/AppLayout'
import { OperatorPage } from './pages/OperatorPage'
import { DisplayPage } from './pages/DisplayPage'
import { HistoryPage } from './pages/HistoryPage'
import { TodayPage } from './pages/TodayPage'
import { SetupPage } from './pages/SetupPage'
import { AdminPage } from './pages/AdminPage'

const router = createBrowserRouter([
  // The Display screen is full-bleed (no app chrome) — it lives outside the layout.
  { path: '/display', element: <DisplayPage /> },
  // Admin (reached from the Display's hidden trigger) is also full-bleed.
  { path: '/admin', element: <AdminPage /> },
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/operator" replace /> },
      { path: 'operator', element: <OperatorPage /> },
      { path: 'today', element: <TodayPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'setup', element: <SetupPage /> },
    ],
  },
  { path: '*', element: <Navigate to="/operator" replace /> },
])

// When a field gets focus and the soft keyboard opens, scroll it into the visible
// area (the keyboard otherwise covers inputs on mobile). The delay lets the
// keyboard / viewport resize settle first.
document.addEventListener('focusin', (e) => {
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) {
    setTimeout(() => t.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300)
  }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
