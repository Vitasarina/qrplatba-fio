package cz.qrplatba.service

import java.security.SecureRandom

/**
 * Generate a numeric variable symbol, exactly 10 digits (no leading zero), unique
 * against the set of VS values currently in use by open sessions. Retried until unique.
 */
object Vs {
    private val rng = SecureRandom()

    fun generate(taken: Set<String>): String {
        repeat(1000) {
            val candidate = randomVs()
            if (!taken.contains(candidate)) return candidate
        }
        throw IllegalStateException("failed to generate a unique VS after 1000 attempts")
    }

    private fun randomVs(): String {
        val first = rng.nextInt(9) + 1 // 1..9
        val sb = StringBuilder().append(first)
        repeat(9) { sb.append(rng.nextInt(10)) }
        return sb.toString()
    }
}
