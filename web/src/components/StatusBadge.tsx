import type { SessionStatus } from '../types'
import { STATUS_META } from '../lib/format'

export function StatusBadge({ status }: { status: SessionStatus }) {
  const meta = STATUS_META[status]
  return (
    <span className={`badge tone-${meta.tone}`} role="status">
      {meta.label}
    </span>
  )
}
