package cz.qrplatba.domain

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

class ConfigError(message: String) : Exception(message)

/** Maximum number of Fio tokens an operator may configure. */
const val MAX_TOKENS = 32

/**
 * Merchant config. Tokens stored as-is here (read-only Fio API tokens).
 *
 * Backward compatibility: older persisted configs carried a single `token` string.
 * The legacy field is still accepted on deserialization via [legacyToken]; it is
 * folded into [tokens] by [normalizedTokens]/the repository migration. It is NOT
 * serialized back out (only `tokens` is written going forward).
 */
@Serializable
data class MerchantConfig(
    val name: String,
    val iban: String,
    /** Fio API tokens (0..MAX_TOKENS). Empty => simulation mode. */
    val tokens: List<String> = emptyList(),
    val licenseKey: String = "",
    val logoUrl: String = "",
    /** Operator password guarding the API. Empty = NOT set (first-run state, no default). */
    val pin: String = "",
    /** Display rotated 180° toggle: which side the customer-facing screens face. */
    val flipped: Boolean = false,
    /** Legacy single-token field from old persisted configs; migrated into [tokens]. */
    @SerialName("token") val legacyToken: String? = null,
) {
    /**
     * The effective token list: explicit [tokens] if present, otherwise the migrated
     * legacy single [legacyToken] (when non-blank). Always trimmed/non-blank/capped.
     */
    fun normalizedTokens(): List<String> {
        val base = if (tokens.isNotEmpty()) tokens else listOfNotNull(legacyToken)
        return base.map { it.trim() }.filter { it.isNotEmpty() }.take(MAX_TOKENS)
    }
}

/** Config DTO (password-protected) — tokens are masked, never the raw secrets. */
@Serializable
data class ConfigDTO(
    val name: String,
    val iban: String,
    /** Each configured token, masked. Length == tokenCount. */
    val tokensMasked: List<String>,
    /** Number of configured tokens (0..MAX_TOKENS). */
    val tokenCount: Int,
    val licenseKey: String,
    val logoUrl: String,
    val configured: Boolean,
    val licensed: Boolean,
    /** Operating mode derived from the tokens: "simulace" (none) or "fio" (>=1). */
    val mode: String,
    /** Whether a custom operator password has been set (the password itself is never returned). */
    val hasPin: Boolean,
    /** Whether the mandatory settings password has been created (alias of hasPin; first-run gate). */
    val passwordSet: Boolean,
    /** Display rotated 180° toggle (which side faces the customer). */
    val flipped: Boolean,
)

/** Public, non-sensitive subset for the customer-facing display (no PIN). */
@Serializable
data class DisplayConfigDTO(
    val name: String,
    val logoUrl: String,
    /** Operating mode so the display can indicate simulation vs. live. */
    val mode: String,
    /** Display rotated 180° toggle (customer-facing side). */
    val flipped: Boolean,
)

/** Operating mode constants. No tokens -> simulation; >=1 token -> Fio. */
object Mode {
    const val SIMULATION = "simulace"
    const val FIO = "fio"
}

object Config {
    private val HTTP = Regex("^https?://", RegexOption.IGNORE_CASE)

    /**
     * Validate and normalize a config update. Throws [ConfigError] on invalid input.
     * Note: the password is NO LONGER set here — it is managed only via the password
     * endpoints. A pre-existing password is preserved by the caller (see AppServer).
     */
    fun validate(
        name: String?,
        iban: String?,
        tokens: List<String>?,
        licenseKey: String?,
        logoUrl: String?,
        pin: String?,
        flipped: Boolean? = null,
    ): MerchantConfig {
        val n = name ?: throw ConfigError("název je povinný")
        val ibanRaw = iban ?: throw ConfigError("IBAN nebo číslo účtu je povinné")
        // Tokens are optional: an empty list selects simulation mode.
        val toks = (tokens ?: emptyList())
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .take(MAX_TOKENS)
        // License is no longer required; keep the field (default "").
        val lic = (licenseKey ?: "").trim()
        val logo = (logoUrl ?: "").trim()
        val p = (pin ?: "").trim()

        if (n.trim().isEmpty()) throw ConfigError("název nesmí být prázdný")

        // Accept EITHER a valid IBAN OR a Czech account number; normalize to the IBAN.
        val normalizedIban: String = when {
            Iban.isValid(ibanRaw) -> Iban.normalize(ibanRaw)
            else -> try {
                Iban.czechAccountToIban(ibanRaw)
                    ?: throw ConfigError("neplatný IBAN nebo číslo účtu (formát nebo kontrolní součet)")
            } catch (e: IllegalArgumentException) {
                throw ConfigError(e.message ?: "neplatné číslo účtu")
            }
        }

        if (logo.isNotEmpty() && !HTTP.containsMatchIn(logo)) {
            throw ConfigError("logoUrl musí začínat http:// nebo https://")
        }
        if (p.isNotEmpty() && p.length < 4) throw ConfigError("heslo musí mít alespoň 4 znaky")

        return MerchantConfig(
            name = n.trim(),
            iban = normalizedIban,
            tokens = toks,
            licenseKey = lic,
            logoUrl = logo,
            pin = p,
            flipped = flipped ?: false,
            legacyToken = null,
        )
    }

    /** Number of configured (normalized) tokens. */
    fun tokenCount(c: MerchantConfig?): Int = c?.normalizedTokens()?.size ?: 0

    /** Operating mode: no tokens -> simulation, >=1 token -> Fio. */
    fun modeOf(c: MerchantConfig?): String =
        if (tokenCount(c) > 0) Mode.FIO else Mode.SIMULATION

    /** Mask a secret so it never leaves the server in full. */
    fun maskToken(token: String): String {
        if (token.isEmpty()) return ""
        if (token.length <= 4) return "*".repeat(token.length)
        return "*".repeat(token.length - 4) + token.takeLast(4)
    }

    /**
     * A config is "configured" when name and a valid account/IBAN are present.
     * Tokens are NOT required — an empty token list simply selects simulation mode,
     * which still lets the operator create payments.
     */
    fun isConfigured(c: MerchantConfig?): Boolean =
        c != null && c.name.isNotEmpty() && c.iban.isNotEmpty()

    /** Licensing is no longer a gate — always true (field kept for back-compat). */
    fun isLicensed(c: MerchantConfig?): Boolean = true

    fun toDTO(c: MerchantConfig?): ConfigDTO {
        if (c == null) {
            return ConfigDTO(
                name = "", iban = "", tokensMasked = emptyList(), tokenCount = 0,
                licenseKey = "", logoUrl = "", configured = false, licensed = true,
                mode = Mode.SIMULATION, hasPin = false, passwordSet = false, flipped = false,
            )
        }
        val toks = c.normalizedTokens()
        val pwSet = c.pin.isNotEmpty()
        return ConfigDTO(
            name = c.name,
            iban = c.iban,
            tokensMasked = toks.map { maskToken(it) },
            tokenCount = toks.size,
            licenseKey = c.licenseKey,
            logoUrl = c.logoUrl,
            configured = isConfigured(c),
            licensed = true,
            mode = modeOf(c),
            hasPin = pwSet,
            passwordSet = pwSet,
            flipped = c.flipped,
        )
    }

    fun toDisplayDTO(c: MerchantConfig?): DisplayConfigDTO =
        DisplayConfigDTO(name = c?.name ?: "", logoUrl = c?.logoUrl ?: "", mode = modeOf(c), flipped = c?.flipped ?: false)
}
