import type { SessionStatus } from '../types'

const czk = new Intl.NumberFormat('cs-CZ', {
  style: 'currency',
  currency: 'CZK',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatCzk(amount: number | null | undefined): string {
  if (amount == null || Number.isNaN(amount)) return '—'
  return czk.format(amount)
}

const time = new Intl.DateTimeFormat('cs-CZ', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return time.format(d)
}

export interface StatusMeta {
  label: string
  tone: 'pending' | 'success' | 'warning' | 'danger' | 'neutral'
}

export const STATUS_META: Record<SessionStatus, StatusMeta> = {
  PENDING: { label: 'Čeká na platbu', tone: 'pending' },
  PAID: { label: 'Zaplaceno', tone: 'success' },
  OVERPAID: { label: 'Zaplaceno (přeplatek)', tone: 'success' },
  UNDERPAID: { label: 'Podplaceno', tone: 'warning' },
  EXPIRED: { label: 'Vypršelo', tone: 'danger' },
  CANCELLED: { label: 'Zrušeno', tone: 'neutral' },
  UNKNOWN: { label: 'Nelze ověřit', tone: 'warning' },
}

// Terminal states: nothing more will happen, the operator can start over.
export function isTerminal(status: SessionStatus): boolean {
  return status !== 'PENDING' && status !== 'UNKNOWN'
}
