import { useEffect, useRef, useState } from 'react'
import type { Session } from '../types'
import { api, urls } from './api'

export type SseState = 'connecting' | 'open' | 'reconnecting' | 'closed'

interface UseSessionResult {
  session: Session | null
  sseState: SseState
  error: string | null
}

// Subscribes to /api/sessions/:id/events and keeps a live copy of the session.
// EventSource reconnects automatically on transient drops; we additionally do a
// REST refetch on (re)connect so we never miss a state change that happened
// while the connection was down (important on WiFi drops).
export function useSession(id: string | null): UseSessionResult {
  const [session, setSession] = useState<Session | null>(null)
  const [sseState, setSseState] = useState<SseState>('closed')
  const [error, setError] = useState<string | null>(null)
  const hadConnection = useRef(false)

  useEffect(() => {
    if (!id) {
      setSession(null)
      setSseState('closed')
      setError(null)
      return
    }

    let cancelled = false
    hadConnection.current = false
    setSseState('connecting')
    setError(null)

    // Initial fetch so we render immediately, before the first SSE frame.
    api
      .getSession(id)
      .then((s) => {
        if (!cancelled) setSession(s)
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message ?? 'Nepodařilo se načíst relaci.')
      })

    const es = new EventSource(urls.events(id))

    es.onopen = () => {
      if (cancelled) return
      setSseState('open')
      setError(null)
      // Resync after a reconnect to catch any missed transitions.
      if (hadConnection.current) {
        api.getSession(id).then((s) => !cancelled && setSession(s)).catch(() => {})
      }
      hadConnection.current = true
    }

    const handleData = (ev: MessageEvent) => {
      if (cancelled || !ev.data) return
      try {
        const frame = JSON.parse(ev.data) as Partial<Session>
        // SSE frames are the minimal PUBLIC shape (no vs/spayd/note). Merge onto the
        // existing snapshot so fields from the authenticated initial fetch (vs, note)
        // survive live status updates.
        setSession((prev) => (prev ? { ...prev, ...frame } : (frame as Session)))
        setError(null)
      } catch {
        // Ignore keep-alive comments / malformed frames.
      }
    }

    // The backend emits named `session` events; keep onmessage as a fallback.
    es.addEventListener('session', handleData as EventListener)
    es.onmessage = handleData

    es.onerror = () => {
      if (cancelled) return
      // EventSource auto-reconnects; reflect that in the UI.
      setSseState(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting')
    }

    return () => {
      cancelled = true
      es.close()
      setSseState('closed')
    }
  }, [id])

  return { session, sseState, error }
}
