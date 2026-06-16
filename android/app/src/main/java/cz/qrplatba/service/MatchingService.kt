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
 * Polling cadence (smart, per active session, measured from session.createdAt):
 *  - N == 1 token:   first query at createdAt + 30 s, then every 30 s.
 *  - N >  1 tokens:  first query at createdAt + 10 s, then every 30000/N ms.
 *  - N == 0 (sim):   auto-confirm the open session ~8-10 s after createdAt.
 * A query is the "first" for the current session when lastQueryAt < session.createdAt.
 * Round-robin token per real bank query (handled inside FioGateway via ModeGateway).
 *
 * The shell drives [tick] from a ~1 s coroutine loop; each tick decides whether a bank
 * query is DUE. The manual `/check` endpoint calls [forceCheck], which queries
 * immediately and counts as a query for cadence timing. A `running` guard prevents
 * overlap. tick(now)/forceCheck(now) are deterministic for tests.
 */
class MatchingService(
    private val repo: SessionRepository,
    private val gateway: BankGateway,
    private val events: EventBus,
) {
    @Volatile private var running = false
    /** Tracks whether the last poll succeeded — drives UNKNOWN recovery. */
    @Volatile private var lastPollOk = true
    /** Epoch-millis of the last bank query; 0 = never queried. Drives cadence. */
    @Volatile private var lastQueryAt: Long = 0L

    /** Simulation: confirm the open session this long after it was created (QR visible briefly). */
    private val simConfirmDelayMs = 9_000L
    /** N == 1: first query delay and steady interval. */
    private val singleTokenDelayMs = 30_000L
    /** N > 1: first query delay (faster initial catch). */
    private val multiTokenFirstDelayMs = 10_000L

    private fun tokenCount(): Int = repo.getConfig()?.normalizedTokens()?.size ?: 0

    /** Latest OPEN session (the one whose QR is on screen), or null. */
    private fun latestOpenSession() =
        repo.listSessions().filter { isOpen(it.status) }.maxByOrNull { it.createdAt }

    /**
     * The polling interval (steady-state) for N tokens. N==1 -> 30 s; N>1 -> 30000/N ms.
     * (Each individual token is still hit at most once per 30 s by FioGateway's rotation.)
     */
    fun pollIntervalMs(n: Int = tokenCount()): Long =
        if (n > 1) (30_000L / n) else 30_000L

    /**
     * Decide whether a bank query is due at [now] for the latest open [session].
     * First query for a session (lastQueryAt < createdAt): due at createdAt + firstDelay
     * (10 s if N>1, else 30 s). Subsequent queries: due at lastQueryAt + interval.
     */
    private fun isQueryDue(now: Long, session: cz.qrplatba.domain.PaymentSession, n: Int): Boolean {
        val firstForSession = lastQueryAt < session.createdAt
        val dueAt = if (firstForSession) {
            session.createdAt + if (n > 1) multiTokenFirstDelayMs else singleTokenDelayMs
        } else {
            lastQueryAt + pollIntervalMs(n)
        }
        return now >= dueAt
    }

    /**
     * One scheduler tick. Always expires stale sessions. Then, depending on the configured
     * token count, decides whether to query the bank now (Fio) or auto-confirm (simulation).
     */
    @Synchronized
    fun tick(now: Long = System.currentTimeMillis()) {
        if (running) return
        running = true
        try {
            expireStale(now)
            val n = tokenCount()
            val open = latestOpenSession() ?: return
            if (n == 0) {
                // Simulation: auto-confirm shortly after the QR was shown.
                if (now >= open.createdAt + simConfirmDelayMs) {
                    poll(now)
                    lastQueryAt = now
                }
            } else {
                if (isQueryDue(now, open, n)) {
                    poll(now)
                    lastQueryAt = now
                }
            }
        } finally {
            running = false
        }
    }

    /**
     * Force an immediate bank query (used by POST /api/sessions/{id}/check). Expires stale
     * sessions, polls once regardless of cadence, and counts as a query for cadence timing.
     */
    @Synchronized
    fun forceCheck(now: Long = System.currentTimeMillis()) {
        if (running) return
        running = true
        try {
            expireStale(now)
            poll(now)
            lastQueryAt = now
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
            // Fio statements carry only a DATE (no time-of-day), so the bank time would
            // otherwise be midnight. Stamp the moment we detected the payment instead —
            // that is the useful "when did it arrive" time for the operator.
            receivedAt = Iso.format(now),
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
