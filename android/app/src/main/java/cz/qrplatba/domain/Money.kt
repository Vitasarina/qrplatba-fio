package cz.qrplatba.domain

import java.math.BigDecimal
import java.math.RoundingMode

/**
 * Money is handled with BigDecimal to avoid IEEE-754 float drift on currency math
 * (the Kotlin equivalent of the Node reference's decimal.js). All amounts are CZK
 * with exactly 2 decimal places at the boundary.
 */
typealias Money = BigDecimal

class AmountError(message: String) : Exception(message)

fun money(value: String): Money = BigDecimal(value)
fun money(value: Int): Money = BigDecimal(value)

/**
 * Parse an incoming amount, enforcing: finite, positive, max 2 decimal places.
 * Accepts a kotlinx-serialization JSON primitive content (number or numeric string).
 * Throws [AmountError] on invalid input so callers can map to a 400.
 */
fun parseAmount(value: String?): Money {
    if (value == null) throw AmountError("amount is required")
    val d: BigDecimal = try {
        BigDecimal(value.trim())
    } catch (e: NumberFormatException) {
        throw AmountError("amount is not a valid number")
    }
    if (d <= BigDecimal.ZERO) {
        throw AmountError("amount must be greater than 0")
    }
    // scale() is the number of digits after the decimal point; strip trailing zeros first
    if (d.stripTrailingZeros().scale() > 2) {
        throw AmountError("amount must have at most 2 decimal places")
    }
    return d
}

/** Format with exactly 2 decimal places, e.g. "450.00" — used in SPAYD and API. */
fun formatAmount2dp(amount: Money): String =
    amount.setScale(2, RoundingMode.HALF_UP).toPlainString()

/** Decimal equality ignoring scale, e.g. 450 == 450.00 (BigDecimal.equals would not). */
fun amountsEqual(a: Money, b: Money): Boolean = a.compareTo(b) == 0
