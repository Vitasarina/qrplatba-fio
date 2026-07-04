package cz.qrplatba.domain

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Password hashing for the operator settings password. Stored form:
 *
 *     pbkdf2$<iterations>$<saltBase64>$<hashBase64>
 *
 * PBKDF2-HMAC-SHA256 with a per-password random salt. Verification is constant-time.
 *
 * Backward compatibility: older installs stored the password in PLAINTEXT (config.pin).
 * [verify] therefore falls back to a constant-time plaintext comparison when [stored] is
 * not in the pbkdf2 format. New/changed passwords are always written hashed via [hash],
 * so a plaintext password is upgraded the next time it is set or changed.
 */
object PasswordHash {
    private const val PREFIX = "pbkdf2"
    private const val ITERATIONS = 120_000
    private const val KEY_BITS = 256
    private const val SALT_BYTES = 16

    fun hash(password: String, iterations: Int = ITERATIONS): String {
        val salt = ByteArray(SALT_BYTES).also { SecureRandom().nextBytes(it) }
        val dk = pbkdf2(password.toCharArray(), salt, iterations, KEY_BITS)
        val b64 = Base64.getEncoder()
        return "$PREFIX$${iterations}$${b64.encodeToString(salt)}$${b64.encodeToString(dk)}"
    }

    /** True when [password] matches [stored] (hashed or legacy plaintext). Constant-time. */
    fun verify(password: String, stored: String): Boolean {
        if (stored.isEmpty()) return false
        if (!stored.startsWith("$PREFIX$")) {
            // Legacy plaintext password — compare in constant time.
            return constantTimeEquals(password.toByteArray(), stored.toByteArray())
        }
        val parts = stored.split("$")
        if (parts.size != 4) return false
        val iterations = parts[1].toIntOrNull() ?: return false
        val salt = try { Base64.getDecoder().decode(parts[2]) } catch (e: Exception) { return false }
        val expected = try { Base64.getDecoder().decode(parts[3]) } catch (e: Exception) { return false }
        val actual = pbkdf2(password.toCharArray(), salt, iterations, expected.size * 8)
        return constantTimeEquals(actual, expected)
    }

    /** Whether [stored] is already in the hashed format (vs. legacy plaintext). */
    fun isHashed(stored: String): Boolean = stored.startsWith("$PREFIX$")

    private fun pbkdf2(password: CharArray, salt: ByteArray, iterations: Int, keyBits: Int): ByteArray {
        val spec = PBEKeySpec(password, salt, iterations, keyBits)
        val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        return factory.generateSecret(spec).encoded
    }

    private fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean = MessageDigest.isEqual(a, b)
}
