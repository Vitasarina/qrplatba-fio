// The operator PIN is required by the backend on /api/sessions* and /api/config.
// We persist it in localStorage so the operator does not retype it each session.
// NOTE: this is a LAN-only convenience credential, not a security boundary —
// the real access control is on the backend / network.

const KEY = 'qr.operatorPin'

export function getPin(): string {
  return localStorage.getItem(KEY) ?? ''
}

export function setPin(pin: string): void {
  if (pin) localStorage.setItem(KEY, pin)
  else localStorage.removeItem(KEY)
}

const listeners = new Set<() => void>()

export function onPinChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function notifyPinChange(): void {
  listeners.forEach((cb) => cb())
}
