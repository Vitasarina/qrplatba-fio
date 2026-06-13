package cz.qrplatba.domain

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * ISO-8601 UTC timestamps that match JavaScript's Date.toISOString()
 * (always UTC, milliseconds, trailing 'Z'), e.g. "2026-06-13T12:34:56.789Z".
 */
object Iso {
    private val utc = TimeZone.getTimeZone("UTC")

    private fun fmt(): SimpleDateFormat =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = utc }

    fun format(epochMillis: Long): String = fmt().format(Date(epochMillis))

    /** Parse an ISO-8601 string to epoch millis. Tolerates a 'Z' or offset suffix. */
    fun parse(iso: String): Long {
        // Try with millis first, then without.
        val candidates = listOf(
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
        )
        for (pattern in candidates) {
            try {
                val sdf = SimpleDateFormat(pattern, Locale.US).apply { timeZone = utc }
                return sdf.parse(iso)!!.time
            } catch (_: Exception) {
            }
        }
        // Fallback: let the platform handle offsets like +02:00.
        return Date.parse(iso)
    }
}
