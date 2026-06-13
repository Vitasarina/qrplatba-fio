package cz.qrplatba.domain

import kotlinx.serialization.Serializable

class ConfigError(message: String) : Exception(message)

/** Merchant config. Token stored as-is here (simulator phase). */
@Serializable
data class MerchantConfig(
    val name: String,
    val iban: String,
    val token: String,
    val licenseKey: String,
    val logoUrl: String = "",
    /** Operator PIN guarding the API. Empty = not set yet (server falls back to the default). */
    val pin: String = "",
)

/** Config DTO (PIN-protected) — token is masked, never the raw secret. */
@Serializable
data class ConfigDTO(
    val name: String,
    val iban: String,
    val tokenMasked: String,
    val licenseKey: String,
    val logoUrl: String,
    val configured: Boolean,
    val licensed: Boolean,
    /** Operating mode derived from the token: "simulace" (blank) or "fio" (token set). */
    val mode: String,
    /** Whether a custom operator PIN has been set (the PIN itself is never returned). */
    val hasPin: Boolean,
)

/** Public, non-sensitive subset for the customer-facing display (no PIN). */
@Serializable
data class DisplayConfigDTO(
    val name: String,
    val logoUrl: String,
    /** Operating mode so the display can indicate simulation vs. live. */
    val mode: String,
)

/** Operating mode constants. Token blank -> simulation; token present -> Fio. */
object Mode {
    const val SIMULATION = "simulace"
    const val FIO = "fio"
}

object Config {
    private val HTTP = Regex("^https?://", RegexOption.IGNORE_CASE)

    /** Validate and normalize a config update. Throws [ConfigError] on invalid input. */
    fun validate(
        name: String?,
        iban: String?,
        token: String?,
        licenseKey: String?,
        logoUrl: String?,
        pin: String?,
    ): MerchantConfig {
        val n = name ?: throw ConfigError("název je povinný")
        val ibanRaw = iban ?: throw ConfigError("IBAN nebo číslo účtu je povinné")
        // Token is now optional: blank token selects simulation mode.
        val tok = (token ?: "").trim()
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
        if (p.isNotEmpty() && p.length < 4) throw ConfigError("PIN musí mít alespoň 4 znaky")

        return MerchantConfig(
            name = n.trim(),
            iban = normalizedIban,
            token = tok,
            licenseKey = lic,
            logoUrl = logo,
            pin = p,
        )
    }

    /** Operating mode: token blank -> simulation, token present -> Fio. */
    fun modeOf(c: MerchantConfig?): String =
        if (c?.token?.isNotBlank() == true) Mode.FIO else Mode.SIMULATION

    /** Mask a secret so it never leaves the server in full. */
    fun maskToken(token: String): String {
        if (token.isEmpty()) return ""
        if (token.length <= 4) return "*".repeat(token.length)
        return "*".repeat(token.length - 4) + token.takeLast(4)
    }

    /**
     * A config is "configured" when name and a valid account/IBAN are present.
     * The token is NO LONGER required — a blank token simply selects simulation mode,
     * which still lets the operator create payments.
     */
    fun isConfigured(c: MerchantConfig?): Boolean =
        c != null && c.name.isNotEmpty() && c.iban.isNotEmpty()

    /** Licensing is no longer a gate — always true (field kept for back-compat). */
    fun isLicensed(c: MerchantConfig?): Boolean = true

    fun toDTO(c: MerchantConfig?): ConfigDTO {
        if (c == null) {
            return ConfigDTO("", "", "", "", "", false, true, Mode.SIMULATION, false)
        }
        return ConfigDTO(
            name = c.name,
            iban = c.iban,
            tokenMasked = maskToken(c.token),
            licenseKey = c.licenseKey,
            logoUrl = c.logoUrl,
            configured = isConfigured(c),
            licensed = true,
            mode = modeOf(c),
            hasPin = c.pin.isNotEmpty(),
        )
    }

    fun toDisplayDTO(c: MerchantConfig?): DisplayConfigDTO =
        DisplayConfigDTO(name = c?.name ?: "", logoUrl = c?.logoUrl ?: "", mode = modeOf(c))
}
