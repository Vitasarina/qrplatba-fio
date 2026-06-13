package cz.qrplatba.api

import cz.qrplatba.domain.Iso
import cz.qrplatba.domain.PaymentSession
import cz.qrplatba.domain.formatAmount2dp

/** Serialize sessions to CSV for export. Matches the Node reference column order. */
object Csv {
    private val HEADER = listOf(
        "id", "vs", "amount", "currency", "status", "overpaid",
        "createdAt", "expiresAt", "paidAt", "matchedTxId", "note",
    )

    fun sessionsToCsv(sessions: List<PaymentSession>): String {
        val rows = sessions.map { s ->
            listOf(
                s.id,
                s.vs,
                formatAmount2dp(s.amount),
                s.currency,
                s.status.name,
                s.overpaid.toString(),
                Iso.format(s.createdAt),
                Iso.format(s.expiresAt),
                s.paidAt?.let { Iso.format(it) } ?: "",
                s.matchedTxId ?: "",
                s.note ?: "",
            ).joinToString(",") { cell(it) }
        }
        return (listOf(HEADER.joinToString(",")) + rows).joinToString("\r\n")
    }

    private fun cell(value: String): String =
        if (Regex("[\",\\r\\n]").containsMatchIn(value)) {
            "\"" + value.replace("\"", "\"\"") + "\""
        } else value
}
