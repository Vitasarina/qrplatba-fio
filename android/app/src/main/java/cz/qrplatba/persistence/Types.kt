package cz.qrplatba.persistence

import cz.qrplatba.domain.MerchantConfig
import cz.qrplatba.domain.PaymentSession
import kotlinx.serialization.Serializable

/** Mirror of an incoming bank transaction, matched or not. */
@Serializable
data class StoredTransaction(
    val externalId: String,
    val amount: String,
    val currency: String,
    val vs: String? = null,
    val receivedAt: String,
    val matchedSessionId: String? = null,
    /** Why it was not matched, if unmatched: "no-session" | "duplicate" | "currency". */
    val unmatchedReason: String? = null,
    /** Counterparty (payer) name from the bank statement, if the bank provides one. */
    val counterpartyName: String? = null,
)

/** Public DTO for an incoming bank transaction (operator "today's payments" view). */
@Serializable
data class TransactionDTO(
    val externalId: String,
    val amount: String,
    val vs: String? = null,
    val receivedAt: String,
    val matched: Boolean,
    val matchedSessionId: String? = null,
    /** Unmatched reason ("no-session" | "duplicate" | "currency"), or null when matched. */
    val reason: String? = null,
    /** Counterparty (payer) name from the bank statement, or null when unknown. */
    val counterpartyName: String? = null,
)

fun StoredTransaction.toDTO(): TransactionDTO = TransactionDTO(
    externalId = externalId,
    amount = amount,
    vs = vs,
    receivedAt = receivedAt,
    matched = matchedSessionId != null,
    matchedSessionId = matchedSessionId,
    reason = unmatchedReason,
    counterpartyName = counterpartyName,
)

data class SessionFilter(
    val status: String? = null,
    val from: Long? = null,
    val to: Long? = null,
)

/**
 * Clean repository seam. Ships an in-memory + JSON-file implementation;
 * production could swap for SQLite without touching services or the API.
 */
interface SessionRepository {
    fun createSession(session: PaymentSession)
    fun getSession(id: String): PaymentSession?
    fun updateSession(session: PaymentSession)
    fun listSessions(filter: SessionFilter? = null): List<PaymentSession>
    fun findOpenByVs(vs: String): List<PaymentSession>
    fun openVsSet(): Set<String>

    fun hasProcessedTx(externalId: String): Boolean
    fun recordTransaction(tx: StoredTransaction)
    fun listTransactions(): List<StoredTransaction>

    fun getConfig(): MerchantConfig?
    fun setConfig(config: MerchantConfig)
    /** Factory reset: clear config, sessions and transactions. */
    fun reset()
}
