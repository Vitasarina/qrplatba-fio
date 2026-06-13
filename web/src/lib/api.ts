import type { AppConfig, DisplayConfig, NetInfo, Session, TodayTransaction } from '../types'
import { getPin } from './pin'

// Thrown for any non-2xx response. `status` lets callers special-case 401 (PIN).
export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  // Send the operator PIN on every call; harmless on endpoints that ignore it.
  const pin = getPin()
  if (pin) headers.set('x-pin', pin)

  let res: Response
  try {
    res = await fetch(path, { ...init, headers })
  } catch {
    // Network / connection refused (backend not running, WiFi drop, ...).
    throw new ApiError('Nelze se připojit k serveru. Běží backend na :8080?', 0)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const data = await res.json()
      detail = (data && (data.error || data.message)) || ''
    } catch {
      try {
        detail = await res.text()
      } catch {
        detail = ''
      }
    }
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(detail || 'Neplatný nebo chybějící PIN obsluhy.', res.status)
    }
    throw new ApiError(detail || `Chyba serveru (${res.status}).`, res.status)
  }

  // 204 / empty bodies.
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  // Validates the stored PIN against the server (used by the PIN gate). Throws ApiError(401) if wrong.
  auth(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/auth')
  },
  getConfig(): Promise<AppConfig> {
    return request<AppConfig>('/api/config')
  },
  saveConfig(cfg: {
    name: string
    iban: string
    token: string // optional value; empty string ⇒ simulation mode
    logoUrl: string
    pin: string
  }): Promise<AppConfig> {
    return request<AppConfig>('/api/config', {
      method: 'POST',
      body: JSON.stringify(cfg),
    })
  },

  createSession(amount: number, note?: string): Promise<Session> {
    return request<Session>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ amount, note: note || undefined }),
    })
  },
  getSession(id: string): Promise<Session> {
    return request<Session>(`/api/sessions/${encodeURIComponent(id)}`)
  },
  cancelSession(id: string): Promise<Session> {
    return request<Session>(`/api/sessions/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    })
  },
  // Force an immediate bank check (instead of waiting for the ~30s poll) and
  // return the freshly updated session.
  checkSession(id: string): Promise<Session> {
    return request<Session>(`/api/sessions/${encodeURIComponent(id)}/check`, {
      method: 'POST',
    })
  },
  listSessions(): Promise<Session[]> {
    return request<Session[]>('/api/sessions')
  },
  // Today's incoming bank transactions (matched or not), newest first.
  getTodayTransactions(): Promise<TodayTransaction[]> {
    return request<TodayTransaction[]>('/api/transactions/today')
  },
  // Public (no PIN): newest open session, used by the customer-facing display.
  getActiveSession(): Promise<Session | null> {
    return request<Session | null>('/api/sessions/active')
  },
  // Public (no PIN): shop name + logo for the display / idle screensaver.
  getDisplayConfig(): Promise<DisplayConfig> {
    return request<DisplayConfig>('/api/display-config')
  },
  // Public (no PIN): the device's LAN address, so the admin screen can show
  // reachable URLs (the server runs on the phone; window.location is 127.0.0.1).
  getNetInfo(): Promise<NetInfo> {
    return request<NetInfo>('/api/net-info')
  },

  // Reset the operator PIN to the default (1234). The backend only honours this
  // when called from the device itself (localhost); remote callers get HTTP 403.
  // No PIN is sent/required — this is the recovery path for a forgotten PIN.
  resetPin(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/pin/reset', { method: 'POST' })
  },
  // Factory reset (PIN-protected): wipe config + sessions + transactions → first run.
  resetConfig(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/config/reset', { method: 'POST' })
  },
}

// Plain URLs (used directly as <a href> / <img src>, no fetch wrapper needed).
export const urls = {
  qrImage: (id: string) => `/api/qr/${encodeURIComponent(id)}.png`,
  qrFor: (data: string) => `/api/qrcode?data=${encodeURIComponent(data)}`,
  exportCsv: '/api/sessions/export.csv',
  events: (id: string) => `/api/sessions/${encodeURIComponent(id)}/events`,
}
