package cz.qrplatba.service

import cz.qrplatba.domain.Iso
import cz.qrplatba.domain.SessionStatus
import cz.qrplatba.domain.formatAmount2dp
import cz.qrplatba.domain.isOpen
import cz.qrplatba.gateway.BankGateway
import cz.qrplatba.gateway.BankTransaction
import cz.qrplatba.persistence.SessionRepository
import cz.qrplatba.persistence.StoredTransaction

/**
 * Matching engine + poller. Pulls transactions from the BankGateway and reconciles
 * them against open sessions. Hard rule: on gateway unavailability or uncertainty
 * NEVER transition to PAID — keep PENDING (mark UNKNOWN) and resume when the bank
 * is reachable again.
 *
 * The Android shell drives ticks from a coroutine loop; tick() is also safe to call
 * manually (mirrors the Node tests). A simple `running` guard prevents overlap.
 */
class MatchingService(
    private val repo: SessionRepository,
    private val gateway: BankGateway,
    private val events: EventBus,
) {
    @Volatile private var running = false
    /** Tracks whether the last poll succeeded — drives UNKNOWN recovery. */
    @Volatile private var lastPollOk = true

    /** One poll cycle: expire stale sessions, then fetch + match. */
    @Synchronized
    fun tick(now: Long = System.currentTimeMillis()) {
        if (running) return
        running = true
        try {
            expireStale(now)
            poll(now)
        } finally {
            running = false
        }
    }

    /** PENDING/UNDERPAID/UNKNOWN past expiresAt -> EXPIRED. */
    fun expireStale(now: Long = System.currentTimeMillis()) {
        for (s in repo.listSessions()) {
            if (isOpen(s.status) && s.expiresAt <= now) {
                s.status = SessionStatus.EXPIRED
                repo.updateSession(s)
                events.publishSessionChange(s)
            }
        }
    }

    /** Fetch a batch and reconcile. Gateway failures set UNKNOWN on open sessions. */
    fun poll(now: Long = System.currentTimeMillis()) {
        val batch: List<BankTransaction> = try {
            gateway.fetchNewTransactions()
        } catch (e: Exception) {
            // Bank unreachable: mark open PENDING sessions UNKNOWN ("cannot verify").
            lastPollOk = false
            markOpenUnknown()
            return
        }

        // Recovered: any UNKNOWN sessions go back to PENDING before matching.
        if (!lastPollOk) recoverUnknown()
        lastPollOk = true

        for (tx in batch) processTransaction(tx, now)
    }

    /** Idempotent by externalId: a transaction processed once is never reprocessed. */
    private fun processTransaction(tx: BankTransaction, now: Long) {
        if (repo.hasProcessedTx(tx.externalId)) return

        val amountStr = formatAmount2dp(tx.amount)
        val base = StoredTransaction(
            externalId = tx.externalId,
            amount = amountStr,
            currency = tx.currency,
            vs = tx.vs,
            receivedAt = Iso.format(tx.receivedAt),
            matchedSessionId = null,
            unmatchedReason = null,
        )

        if (tx.currency != "CZK") {
            repo.recordTransaction(base.copy(unmatchedReason = "currency"))
            return
        }
        if (tx.vs.isNullOrEmpty()) {
            repo.recordTransaction(base.copy(unmatchedReason = "no-session"))
            return
        }

        val open = repo.findOpenByVs(tx.vs)
        if (open.isEmpty()) {
            val reason = if (anyTerminalForVs(tx.vs)) "duplicate" else "no-session"
            repo.recordTransaction(base.copy(unmatchedReason = reason))
            return
        }

        // Match the oldest open session for this VS.
        val session = open[0]
        val cmp = tx.amount.compareTo(session.amount)

        if (cmp < 0) {
            // Underpayment: do NOT mark success; session stays open until expiry/cancel.
            session.status = SessionStatus.UNDERPAID
            session.receivedAmount = tx.amount
            repo.updateSession(session)
            events.publishSessionChange(session)
            repo.recordTransaction(base.copy(matchedSessionId = session.id))
            return
        }

        // Exact or overpayment -> PAID (overpaid flagged).
        session.status = if (cmp > 0) SessionStatus.OVERPAID else SessionStatus.PAID
        session.overpaid = cmp > 0
        session.receivedAmount = tx.amount
        session.paidAt = now
        session.matchedTxId = tx.externalId
        repo.updateSession(session)
        events.publishSessionChange(session)
        repo.recordTransaction(base.copy(matchedSessionId = session.id))
    }

    private fun anyTerminalForVs(vs: String): Boolean =
        repo.listSessions().any { it.vs == vs && !isOpen(it.status) }

    private fun markOpenUnknown() {
        for (s in repo.listSessions()) {
            if (s.status == SessionStatus.PENDING) {
                s.status = SessionStatus.UNKNOWN
                repo.updateSession(s)
                events.publishSessionChange(s)
            }
        }
    }

    private fun recoverUnknown() {
        for (s in repo.listSessions()) {
            if (s.status == SessionStatus.UNKNOWN) {
                s.status = SessionStatus.PENDING
                repo.updateSession(s)
                events.publishSessionChange(s)
            }
        }
    }
}
