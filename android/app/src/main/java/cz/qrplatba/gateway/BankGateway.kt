package cz.qrplatba.gateway

import cz.qrplatba.domain.Money
import java.math.BigDecimal

/** An incoming bank transaction. externalId is used for idempotence. */
data class BankTransaction(
    val externalId: String,
    val amount: Money,
    val currency: String,
    val vs: String?,
    val receivedAt: Long,
)

/** Raised by a gateway when the bank cannot be reached (drives UNKNOWN handling). */
class BankUnavailableException(message: String) : Exception(message)

/**
 * The single seam between matching logic and any bank. Swapping
 * SimulatorGateway -> FioGateway must not change matching, session states, or the API.
 */
interface BankGateway {
    /** New incoming transactions since the last checkpoint. Throws [BankUnavailableException] if unreachable. */
    fun fetchNewTransactions(): List<BankTransaction>

    /** Connectivity probe — drives UNKNOWN / "cannot verify" handling. */
    fun isAvailable(): Boolean
}
