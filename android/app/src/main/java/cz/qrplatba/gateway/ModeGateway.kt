package cz.qrplatba.gateway

import cz.qrplatba.domain.Mode
import cz.qrplatba.domain.isOpen
import cz.qrplatba.persistence.SessionRepository
import java.util.concurrent.ConcurrentHashMap

/**
 * Mode-routing bank gateway. Decides per poll, based on the stored config token,
 * whether to run in simulation or talk to the real Fio API — no restart needed.
 *
 *  - Token blank  -> SIMULATION: auto-confirm. For each currently OPEN session it emits
 *    one exact-amount transaction (matching vs + amount). On the next poll / manual check
 *    the matcher transitions the session to PAID. Idempotence by externalId stops a
 *    session from being paid twice. This makes the demo work hands-free, no simulator UI.
 *  - Token present -> FIO: delegate to a real [FioGateway] built (and cached) per token.
 *
 * Holds a reference to the repo so it can read the live config + open sessions each poll.
 */
class ModeGateway(
    private val repo: SessionRepository,
    private val fioFactory: (token: String) -> BankGateway = { FioGateway(it) },
) : BankGateway {

    private val fioCache = ConcurrentHashMap<String, BankGateway>()
    @Volatile private var lastFioAvailable = true

    override fun fetchNewTransactions(): List<BankTransaction> {
        val cfg = repo.getConfig()
        val token = cfg?.token?.trim().orEmpty()
        return if (token.isEmpty()) {
            simulateAutoConfirm()
        } else {
            val fio = fioCache.getOrPut(token) { fioFactory(token) }
            try {
                val txs = fio.fetchNewTransactions()
                lastFioAvailable = true
                txs
            } catch (e: Exception) {
                lastFioAvailable = false
                throw e
            }
        }
    }

    /** isAvailable(): always true in simulation; in Fio mode reflects the last fetch. */
    override fun isAvailable(): Boolean {
        val token = repo.getConfig()?.token?.trim().orEmpty()
        return if (token.isEmpty()) true else lastFioAvailable
    }

    /**
     * For each open session, emit a deterministic exact-amount transaction. The externalId
     * is derived from the session id so re-emitting across polls is idempotent (the matcher
     * skips already-processed externalIds; once PAID the session is no longer open).
     */
    private fun simulateAutoConfirm(): List<BankTransaction> {
        val now = System.currentTimeMillis()
        return repo.listSessions()
            .filter { isOpen(it.status) }
            .map { s ->
                BankTransaction(
                    externalId = "sim-${s.id}",
                    amount = s.amount,
                    currency = s.currency,
                    vs = s.vs,
                    receivedAt = now,
                )
            }
    }

    companion object {
        const val SIMULATION = Mode.SIMULATION
        const val FIO = Mode.FIO
    }
}
