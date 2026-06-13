import type { SseState } from '../lib/useSession'

const LABELS: Record<SseState, string> = {
  connecting: 'Připojuji…',
  open: 'Živé spojení',
  reconnecting: 'Obnovuji spojení…',
  closed: 'Odpojeno',
}

// Small live-connection indicator so the operator knows the status is real-time.
export function SseIndicator({ state }: { state: SseState }) {
  return (
    <span className={`sse-dot ${state}`} aria-live="polite">
      {LABELS[state]}
    </span>
  )
}
