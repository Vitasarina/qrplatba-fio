package cz.qrplatba.domain

/**
 * IBAN validation: structural check + ISO 7064 mod-97 checksum.
 * Generic for any country, but length is sanity-checked against the
 * IBAN registry for a few common ones (CZ is 24).
 */
object Iban {
    private val COUNTRY_LENGTHS = mapOf(
        "CZ" to 24, "SK" to 24, "DE" to 22, "AT" to 20, "PL" to 28, "GB" to 22,
    )

    private val SHAPE = Regex("^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$")

    fun normalize(raw: String): String = raw.replace(Regex("\\s+"), "").uppercase()

    /** Czech account number: optional "prefix-", base, "/bankcode". Spaces ignored. */
    private val CZ_ACCOUNT = Regex("^(?:([0-9]{1,6})-)?([0-9]{1,10})/([0-9]{1,4})$")

    /**
     * If [raw] is a Czech account number (e.g. "2400123456/2010" or "19-2000145399/0800"),
     * convert it to the normalized IBAN; otherwise return null.
     */
    fun czechAccountToIban(raw: String?): String? {
        if (raw == null) return null
        val cleaned = raw.replace(Regex("\\s+"), "")
        val m = CZ_ACCOUNT.matchEntire(cleaned) ?: return null
        val (prefix, base, bank) = m.destructured
        return fromCzechAccount(prefix.ifEmpty { null }, base, bank)
    }

    fun isValid(raw: String?): Boolean {
        if (raw == null) return false
        val iban = normalize(raw)
        if (!SHAPE.matches(iban)) return false
        val country = iban.substring(0, 2)
        val expectedLen = COUNTRY_LENGTHS[country]
        if (expectedLen != null && iban.length != expectedLen) return false
        return mod97(iban) == 1
    }

    /**
     * Czech account number -> IBAN.
     *
     * BBAN layout for CZ is bank(4) + prefix(6, zero-padded) + base(10, zero-padded) = 20 digits.
     * The two IBAN check digits are derived with the standard ISO 7064 mod-97 algorithm:
     * compute 98 - (mod97 of BBAN + "CZ00" rearranged) where "CZ" maps to 12 35 ("123500").
     *
     * @param prefix optional account prefix (the part before '-'); blank/null -> "0".
     * @param number the base account number (after the optional '-', before '/').
     * @param bankCode the 4-digit bank code (after '/').
     * @return the normalized 24-char Czech IBAN, e.g. "CZ6508000000192000145399".
     */
    fun fromCzechAccount(prefix: String?, number: String, bankCode: String): String {
        val bank = bankCode.trim()
        val pfx = (prefix ?: "").trim().ifEmpty { "0" }
        val base = number.trim()
        require(bank.matches(Regex("^[0-9]{1,4}$"))) { "kód banky musí být 1–4 číslice" }
        require(pfx.matches(Regex("^[0-9]{1,6}$"))) { "předčíslí musí mít nejvýše 6 číslic" }
        require(base.matches(Regex("^[0-9]{1,10}$"))) { "číslo účtu musí mít nejvýše 10 číslic" }

        val bban = bank.padStart(4, '0') + pfx.padStart(6, '0') + base.padStart(10, '0')
        // Check string: BBAN + country code as digits ("CZ" -> 1235) + "00".
        val checkSource = bban + "123500"
        val checkDigits = (98 - mod97Digits(checkSource)).toString().padStart(2, '0')
        return "CZ$checkDigits$bban"
    }

    /** mod-97 over a pure-digit string, chunked to stay within Long range. */
    private fun mod97Digits(digits: String): Int {
        var remainder = 0
        var i = 0
        while (i < digits.length) {
            val end = minOf(i + 7, digits.length)
            val chunk = remainder.toString() + digits.substring(i, end)
            remainder = chunk.toLong().rem(97).toInt()
            i = end
        }
        return remainder
    }

    /**
     * ISO 7064 mod-97-10. Move first 4 chars to the end, map letters to numbers
     * (A=10 .. Z=35), then compute the big integer mod 97 in chunks.
     */
    private fun mod97(iban: String): Int {
        val rearranged = iban.substring(4) + iban.substring(0, 4)
        var remainder = 0
        var buffer = StringBuilder()
        for (ch in rearranged) {
            if (ch in 'A'..'Z') {
                buffer.append((ch.code - 55).toString()) // A->10 ... Z->35
            } else {
                buffer.append(ch)
            }
            while (buffer.length >= 7) {
                remainder = (remainder.toString() + buffer.substring(0, 7)).toLong().rem(97).toInt()
                buffer = StringBuilder(buffer.substring(7))
            }
        }
        if (buffer.isNotEmpty()) {
            remainder = (remainder.toString() + buffer.toString()).toLong().rem(97).toInt()
        }
        return remainder
    }
}
