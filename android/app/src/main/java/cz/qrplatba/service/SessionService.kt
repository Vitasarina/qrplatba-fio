package cz.qrplatba.service

import cz.qrplatba.domain.Config
import cz.qrplatba.domain.ConfigDTO
import cz.qrplatba.domain.DisplayConfigDTO
import cz.qrplatba.domain.MerchantConfig
import cz.qrplatba.domain.Money
import cz.qrplatba.domain.PaymentSession
import cz.qrplatba.domain.SessionStatus
import cz.qrplatba.domain.Spayd
import cz.qrplatba.domain.isOpen
import cz.qrplatba.domain.parseAmount
import cz.qrplatba.persistence.SessionFilter
import cz.qrplatba.persistence.SessionRepository
import java.util.UUID

class NotConfiguredError(message: String) : Exception(message)
class NotLicensedError(message: String) : Exception(message)
class NotFoundError(message: String) : Exception(message)
class InvalidStateError(message: String) : Exception(message)

class SessionService(
    private val repo: SessionRepository,
    private val events: EventBus,
    private val ttlMs: Long,
) {
    // ---- config ----

    fun getConfigDTO(): ConfigDTO = Config.toDTO(repo.getConfig())

    fun getDisplayConfigDTO(): DisplayConfigDTO = Config.toDisplayDTO(repo.getConfig())

    /**
     * Save merchant config. The password is NOT taken from this call — it is managed
     * only by the password endpoints. The existing stored password (config.pin) is
     * preserved across config saves.
     */
    fun setConfig(
        name: String?,
        iban: String?,
        tokens: List<String>?,
        licenseKey: String?,
        logoUrl: String?,
        flipped: Boolean? = null,
        opMode: String? = null,
    ): ConfigDTO {
        val existing = repo.getConfig()
        val existingPin = existing?.pin ?: ""
        // Preserve the chosen operating mode when the caller doesn't send one.
        val effectiveOpMode = opMode ?: existing?.opMode
        val cfg = Config.validate(name, iban, tokens, licenseKey, logoUrl, existingPin, flipped, effectiveOpMode)
        repo.setConfig(cfg)
        return Config.toDTO(cfg)
    }

    /** Set only the operating (workflow) mode, preserving everything else in the config. */
    fun setOpMode(mode: String?): ConfigDTO {
        val existing = repo.getConfig()
            ?: throw NotConfiguredError("Obchodník není nakonfigurován.")
        val updated = existing.copy(opMode = cz.qrplatba.domain.OpMode.normalize(mode), legacyToken = null)
        repo.setConfig(updated)
        return Config.toDTO(updated)
    }

    /** Factory reset: clear config, sessions and transactions (back to first run). */
    fun reset() = repo.reset()

    // ---- sessions ----

    /** @param amount raw amount string/number content from the request body. */
    fun createSession(amount: String?, note: String? = null): PaymentSession {
        val config = repo.getConfig()
        if (!Config.isConfigured(config)) {
            throw NotConfiguredError("Obchodník není nakonfigurován (vyžadován název a IBAN/číslo účtu).")
        }
        config!!

        val parsedAmount: Money = parseAmount(amount)
        val parsedNote = parseNote(note)

        val taken = repo.openVsSet()
        val vs = Vs.generate(taken)

        val now = System.currentTimeMillis()
        val spayd = Spayd.build(
            iban = config.iban,
            amount = parsedAmount,
            vs = vs,
            message = buildSpaydMessage(config.name, parsedNote),
            currency = "CZK",
        )

        val session = PaymentSession(
            id = UUID.randomUUID().toString(),
            amount = parsedAmount,
            currency = "CZK",
            vs = vs,
            spayd = spayd,
            status = SessionStatus.PENDING,
            createdAt = now,
            expiresAt = now + ttlMs,
            paidAt = null,
            matchedTxId = null,
            note = parsedNote,
            overpaid = false,
            receivedAmount = null,
        )

        repo.createSession(session)
        events.publishSessionChange(session)
        return session
    }

    /**
     * Create a paper-mode "watch" session: the operator has a printed paper QR and just
     * started waiting for the next incoming payment. No on-screen QR is needed. An optional
     * [expectedAmount] narrows matching to that exact amount (safer with concurrent payers);
     * when blank/null, any incoming payment matches. Times out after [ttlMs] (default 2 min).
     */
    fun createWatchSession(
        expectedAmount: String? = null,
        note: String? = null,
        ttlMs: Long = 120_000L,
    ): PaymentSession {
        val config = repo.getConfig()
        if (!Config.isConfigured(config)) {
            throw NotConfiguredError("Obchodník není nakonfigurován (vyžadován název a IBAN/číslo účtu).")
        }
        config!!

        val expected: Money =
            if (expectedAmount.isNullOrBlank()) java.math.BigDecimal.ZERO else parseAmount(expectedAmount)
        val parsedNote = parseNote(note)

        val taken = repo.openVsSet()
        val vs = Vs.generate(taken)

        val now = System.currentTimeMillis()
        // A SPAYD is still produced (paper QR is external, but /api/qr stays valid for
        // display fallbacks). VS is intentionally empty — paper payments rarely carry one.
        val spayd = Spayd.build(
            iban = config.iban,
            amount = expected,
            vs = "",
            message = buildSpaydMessage(config.name, parsedNote),
            currency = "CZK",
        )

        val session = PaymentSession(
            id = UUID.randomUUID().toString(),
            amount = expected,
            currency = "CZK",
            vs = vs,
            spayd = spayd,
            status = SessionStatus.PENDING,
            createdAt = now,
            expiresAt = now + ttlMs,
            paidAt = null,
            matchedTxId = null,
            note = parsedNote,
            overpaid = false,
            receivedAmount = null,
            watch = true,
            payerName = null,
        )

        repo.createSession(session)
        events.publishSessionChange(session)
        return session
    }

    fun getSession(id: String): PaymentSession =
        repo.getSession(id) ?: throw NotFoundError("session $id not found")

    fun cancelSession(id: String): PaymentSession {
        val s = repo.getSession(id) ?: throw NotFoundError("session $id not found")
        if (!isOpen(s.status)) {
            throw InvalidStateError("session $id is ${s.status} and cannot be cancelled")
        }
        s.status = SessionStatus.CANCELLED
        repo.updateSession(s)
        events.publishSessionChange(s)
        return s
    }

    /** Force an open session to EXPIRED now (simulator "abandon"/"late" scenarios). */
    fun expireSession(id: String): PaymentSession {
        val s = repo.getSession(id) ?: throw NotFoundError("session $id not found")
        if (!isOpen(s.status)) {
            throw InvalidStateError("session $id is ${s.status} and cannot be expired")
        }
        s.status = SessionStatus.EXPIRED
        repo.updateSession(s)
        events.publishSessionChange(s)
        return s
    }

    fun listSessions(filter: SessionFilter? = null): List<PaymentSession> = repo.listSessions(filter)

    fun latestSession(): PaymentSession? = repo.listSessions().firstOrNull()

    fun latestOpenSession(): PaymentSession? = repo.listSessions().firstOrNull { isOpen(it.status) }

    private fun parseNote(note: String?): String? {
        if (note == null) return null
        val trimmed = note.trim()
        return if (trimmed.isEmpty()) null else trimmed.take(200)
    }

    companion object {
        /**
         * The SPAYD MSG value: the operator note combined with the company name,
         * hyphen-joined, note first, lowercased. With no note it is just the
         * lowercased company name.
         *   name "Boldgym", note "musli" -> "musli-boldgym"
         *   name "Boldgym", note null/blank -> "boldgym"
         * SPAYD field sanitization (no '*', length cap) is still applied by [Spayd.build].
         */
        fun buildSpaydMessage(name: String, note: String?): String {
            val n = note?.trim()
            return if (n.isNullOrEmpty()) {
                name.trim().lowercase()
            } else {
                "${n.lowercase()}-${name.trim().lowercase()}"
            }
        }
    }
}
