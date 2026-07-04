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
    /** Paper-mode watch: query soon after the operator starts waiting (a payment may
     *  already have arrived), then follow the steady per-token cadence. */
    private val watchFirstDelayMs = 4_000L

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
        val firstDelay = when {
            session.watch -> watchFirstDelayMs
            n > 1 -> multiTokenFirstDelayMs
            else -> singleTokenDelayMs
        }
        val dueAt = if (firstForSession) {
            session.createdAt + firstDelay
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

    /**
     * Fetch a batch and reconcile. Gateway failures set UNKNOWN on open sessions.
     * Returns true when the bank was reachable (fetch succeeded), false otherwise.
     */
    fun poll(now: Long = System.currentTimeMillis()): Boolean {
        val batch: List<BankTransaction> = try {
            gateway.fetchNewTransactions()
        } catch (e: Exception) {
            // Bank unreachable: mark open PENDING sessions UNKNOWN ("cannot verify").
            lastPollOk = false
            markOpenUnknown()
            return false
        }

        // Recovered: any UNKNOWN sessions go back to PENDING before matching.
        if (!lastPollOk) recoverUnknown()
        lastPollOk = true

        for (tx in batch) processTransaction(tx, now)
        return true
    }

    /**
     * Register-mode precheck performed BEFORE showing a QR: verify the bank is reachable by
     * making a REAL token query (per the operator's preference — with multiple tokens one
     * query per QR is well within the rate budget). Any transactions the query returns are
     * reconciled normally (not lost). In simulation (no tokens) the bank is always "reachable".
     * The query counts toward the polling cadence so we don't immediately re-query the token.
     */
    @Synchronized
    fun probeBank(now: Long = System.currentTimeMillis()): Boolean {
        if (tokenCount() == 0) return true // simulation: always reachable
        if (running) return lastPollOk // a poll is already in flight; report its last outcome
        running = true
        try {
            val ok = poll(now)
            lastQueryAt = now
            return ok
        } finally {
            running = false
        }
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
            counterpartyName = tx.counterpartyName,
        )

        if (tx.currency != "CZK") {
            repo.recordTransaction(base.copy(unmatchedReason = "currency"))
            return
        }

        // Paper-mode "watch" sessions bind the NEXT incoming payment regardless of VS
        // (the paper QR is static, so payments usually carry no matching VS). A watch with
        // no expected amount (amount == 0) matches any incoming; one with an expected amount
        // matches only that exact amount. Oldest waiting watch wins.
        if (matchWatch(tx, base, now)) return

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
            session.payerName = tx.counterpartyName ?: session.payerName
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
        session.payerName = tx.counterpartyName ?: session.payerName
        repo.updateSession(session)
        events.publishSessionChange(session)
        repo.recordTransaction(base.copy(matchedSessionId = session.id))
    }

    /**
     * Try to bind [tx] to the oldest open paper-mode watch session. Returns true (and records
     * the transaction as matched) when it did; false when no eligible watch is waiting.
     */
    private fun matchWatch(tx: BankTransaction, base: StoredTransaction, now: Long): Boolean {
        val watch = repo.listSessions()
            .filter { it.watch && isOpen(it.status) }
            .sortedBy { it.createdAt }
            .firstOrNull { w -> w.amount.signum() == 0 || w.amount.compareTo(tx.amount) == 0 }
            ?: return false

        val cmp = if (watch.amount.signum() == 0) 0 else tx.amount.compareTo(watch.amount)
        watch.status = if (cmp > 0) SessionStatus.OVERPAID else SessionStatus.PAID
        watch.overpaid = cmp > 0
        watch.receivedAmount = tx.amount
        watch.paidAt = now
        watch.matchedTxId = tx.externalId
        watch.payerName = tx.counterpartyName
        repo.updateSession(watch)
        events.publishSessionChange(watch)
        repo.recordTransaction(base.copy(matchedSessionId = watch.id))
        return true
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
