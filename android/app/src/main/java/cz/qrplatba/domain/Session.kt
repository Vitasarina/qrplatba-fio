package cz.qrplatba.domain

import kotlinx.serialization.Serializable
import java.math.BigDecimal

enum class SessionStatus {
    PENDING, PAID, UNDERPAID, OVERPAID, EXPIRED, CANCELLED, UNKNOWN
}

/** A status is terminal when the matching engine should stop acting on it. */
val TERMINAL_STATUSES = setOf(
    SessionStatus.PAID, SessionStatus.OVERPAID, SessionStatus.EXPIRED, SessionStatus.CANCELLED,
)

/** A session is "open" (still eligible to match) while PENDING, UNDERPAID, or UNKNOWN. */
fun isOpen(status: SessionStatus): Boolean =
    status == SessionStatus.PENDING || status == SessionStatus.UNDERPAID || status == SessionStatus.UNKNOWN

fun isTerminal(status: SessionStatus): Boolean = status in TERMINAL_STATUSES

/**
 * A payment session. Times are stored as epoch millis internally; serialized as ISO-8601
 * at the JSON/DTO boundary. Amounts are decimal-safe [Money].
 */
data class PaymentSession(
    val id: String,
    val amount: Money,
    val currency: String,
    val vs: String,
    val spayd: String,
    var status: SessionStatus,
    val createdAt: Long,
    val expiresAt: Long,
    var paidAt: Long? = null,
    var matchedTxId: String? = null,
    val note: String? = null,
    var overpaid: Boolean = false,
    var receivedAmount: Money? = null,
)

/** Persisted JSON shape (amount as 2dp string, dates as ISO strings). */
@Serializable
data class PaymentSessionJson(
    val id: String,
    val amount: String,
    val currency: String,
    val vs: String,
    val spayd: String,
    val status: String,
    val createdAt: String,
    val expiresAt: String,
    val paidAt: String? = null,
    val matchedTxId: String? = null,
    val note: String? = null,
    val overpaid: Boolean = false,
    val receivedAmount: String? = null,
)

/** Public DTO returned by the API; matches the Node sessionToDTO shape exactly. */
@Serializable
data class SessionDTO(
    val id: String,
    val amount: String,
    val currency: String,
    val vs: String,
    val spayd: String,
    val status: String,
    val createdAt: String,
    val expiresAt: String,
    val paidAt: String? = null,
    val matchedTxId: String? = null,
    val note: String? = null,
    val overpaid: Boolean = false,
    val receivedAmount: String? = null,
    val qrUrl: String,
)

fun PaymentSession.toJson(): PaymentSessionJson = PaymentSessionJson(
    id = id,
    amount = amount.setScale(2, java.math.RoundingMode.HALF_UP).toPlainString(),
    currency = currency,
    vs = vs,
    spayd = spayd,
    status = status.name,
    createdAt = Iso.format(createdAt),
    expiresAt = Iso.format(expiresAt),
    paidAt = paidAt?.let { Iso.format(it) },
    matchedTxId = matchedTxId,
    note = note,
    overpaid = overpaid,
    receivedAmount = receivedAmount?.setScale(2, java.math.RoundingMode.HALF_UP)?.toPlainString(),
)

fun PaymentSessionJson.toSession(): PaymentSession = PaymentSession(
    id = id,
    amount = BigDecimal(amount),
    currency = currency,
    vs = vs,
    spayd = spayd,
    status = SessionStatus.valueOf(status),
    createdAt = Iso.parse(createdAt),
    expiresAt = Iso.parse(expiresAt),
    paidAt = paidAt?.let { Iso.parse(it) },
    matchedTxId = matchedTxId,
    note = note,
    overpaid = overpaid,
    receivedAmount = receivedAmount?.let { BigDecimal(it) },
)

fun PaymentSession.toDTO(): SessionDTO = SessionDTO(
    id = id,
    amount = amount.setScale(2, java.math.RoundingMode.HALF_UP).toPlainString(),
    currency = currency,
    vs = vs,
    spayd = spayd,
    status = status.name,
    createdAt = Iso.format(createdAt),
    expiresAt = Iso.format(expiresAt),
    paidAt = paidAt?.let { Iso.format(it) },
    matchedTxId = matchedTxId,
    note = note,
    overpaid = overpaid,
    receivedAmount = receivedAmount?.setScale(2, java.math.RoundingMode.HALF_UP)?.toPlainString(),
    qrUrl = "/api/qr/$id.png",
)
