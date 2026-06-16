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

// Operating mode reported by the backend. No tokens ⇒ "simulace" (payments
// auto-confirm); at least one Fio token ⇒ "fio" (real bank verification).
export type AppMode = 'simulace' | 'fio'

export interface AppConfig {
  name: string
  iban: string
  // Masked Fio tokens already stored on the backend (never the raw secrets).
  // One entry per configured token; up to 32.
  tokensMasked: string[]
  tokenCount: number
  logoUrl: string
  passwordSet: boolean // whether the settings password has been created
  configured?: boolean
  mode?: AppMode
  // Whether the display is rotated 180° (operator/customer stand on swapped
  // sides of the flat phone). See DisplayConfig.flipped.
  flipped: boolean
}

// Public display info (no secrets), served without a PIN.
export interface DisplayConfig {
  name: string
  logoUrl: string
  mode?: AppMode
  // Which side faces the customer. The phone lies flat between operator and
  // customer; customer-facing and operator-facing screens are oriented 180°
  // apart. `flipped` swaps which orientation each gets. Default (false):
  // customer screens at 180°, the operator numpad at 0°.
  flipped?: boolean
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

