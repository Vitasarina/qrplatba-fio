// The settings password is required by the backend on /api/sessions* and
// /api/config (sent as the x-pin header). We persist it in localStorage so the
// operator does not retype it each session.
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
