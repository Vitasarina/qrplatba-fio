package cz.qrplatba.domain

/**
 * Build a SPAYD ("QR Platba", Czech Banking Association) string.
 * Format: SPD*1.0*ACC:<IBAN>*AM:<amount.2dp>*CC:CZK*X-VS:<vs>*MSG:<name>
 *
 * SPAYD field values must not contain '*' (the field separator). The MSG value
 * is sanitized: '*' replaced with space, and per spec MSG is limited to 60 chars.
 */
object Spayd {
    fun build(
        iban: String,
        amount: Money,
        vs: String,
        message: String,
        currency: String = "CZK",
    ): String {
        val msg = sanitizeMessage(message)
        return listOf(
            "SPD",
            "1.0",
            "ACC:$iban",
            "AM:${formatAmount2dp(amount)}",
            "CC:$currency",
            "X-VS:$vs",
            "MSG:$msg",
        ).joinToString("*")
    }

    private fun sanitizeMessage(message: String): String =
        message
            .replace("*", " ")
            .replace(Regex("[\\r\\n\\t]"), " ")
            .trim()
            .take(60)
}
