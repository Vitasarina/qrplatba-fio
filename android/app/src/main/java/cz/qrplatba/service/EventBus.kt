package cz.qrplatba.service

import cz.qrplatba.domain.PaymentSession
import java.util.concurrent.ConcurrentHashMap

/**
 * Tiny pub/sub for session state changes. The SSE route subscribes per session id
 * and pushes the updated session to connected clients on every change.
 */
class EventBus {
    private val listeners = ConcurrentHashMap<String, MutableSet<(PaymentSession) -> Unit>>()

    fun publishSessionChange(session: PaymentSession) {
        listeners[session.id]?.toList()?.forEach { it(session) }
    }

    /** Subscribe to changes for [id]; returns an unsubscribe function. */
    fun onSessionChange(id: String, listener: (PaymentSession) -> Unit): () -> Unit {
        val set = listeners.computeIfAbsent(id) { ConcurrentHashMap.newKeySet() }
        set.add(listener)
        return {
            set.remove(listener)
            if (set.isEmpty()) listeners.remove(id, set)
        }
    }
}
