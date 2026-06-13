// Shared domain types — kept in sync with the backend API contract.

export type SessionStatus =
  | 'PENDING'
  | 'PAID'
  | 'UNDERPAID'
  | 'OVERPAID'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'UNKNOWN'

export interface Session {
  id: string
  vs: string
  spayd: string
  qrUrl: string
  amount: number
  status: SessionStatus
  expiresAt: string // ISO timestamp
  note?: string
  createdAt?: string
  paidAt?: string | null
  // Amount actually received (present once a transaction is matched). Used to
  // compute the shortfall on UNDERPAID / overpayment on OVERPAID.
  receivedAmount?: number | null
  matchedTxId?: string | null
}

// Operating mode reported by the backend. Empty token ⇒ "simulace" (payments
// auto-confirm); a present Fio token ⇒ "fio" (real bank verification).
export type AppMode = 'simulace' | 'fio'

export interface AppConfig {
  name: string
  iban: string
  tokenMasked: string // masked token returned by the backend (never the raw secret)
  logoUrl: string
  hasPin?: boolean // whether a custom operator PIN is set (PIN itself never returned)
  configured?: boolean
  mode?: AppMode
}

// Public display info (no secrets), served without a PIN.
export interface DisplayConfig {
  name: string
  logoUrl: string
  mode?: AppMode
}

// LAN address of the device running the server (for the admin/access screen).
export interface NetInfo {
  ip: string
  port: number
  baseUrl: string
}

// A single incoming bank transaction for today (matched to a session or not).
export interface TodayTransaction {
  externalId: string
  amount: string // decimal string from the backend (e.g. "149.90")
  vs: string | null
  receivedAt: string // ISO timestamp
  matched: boolean
  matchedSessionId: string | null
  reason: string | null // why it stayed unmatched (present when matched === false)
}

