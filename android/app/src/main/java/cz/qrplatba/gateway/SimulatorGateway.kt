package cz.qrplatba.gateway

import cz.qrplatba.domain.Money
import cz.qrplatba.domain.money
import java.math.BigDecimal
import java.util.concurrent.atomic.AtomicLong

enum class ScenarioType { exact, under, over, none, late, duplicate, wrongvs, unavailable }

/**
 * In-memory bank simulator. Tests/dev enqueue transactions; the poller drains them
 * via fetchNewTransactions(). Implements the same BankGateway contract as the real
 * Fio gateway, so the rest of the app is unaware which one is wired.
 */
class SimulatorGateway : BankGateway {
    private val queue = ArrayDeque<BankTransaction>()
    @Volatile private var available = true
    private val counter = AtomicLong(0)

    private fun nextExternalId(): String = "sim-${System.currentTimeMillis()}-${counter.incrementAndGet()}"

    @Synchronized
    override fun fetchNewTransactions(): List<BankTransaction> {
        if (!available) throw BankUnavailableException("simulator: bank unavailable")
        val batch = queue.toList()
        queue.clear()
        return batch
    }

    override fun isAvailable(): Boolean = available

    @Synchronized
    fun setAvailable(value: Boolean) {
        available = value
    }

    @Synchronized
    fun enqueue(
        amount: Money,
        vs: String?,
        currency: String = "CZK",
        externalId: String? = null,
        receivedAt: Long = System.currentTimeMillis(),
        counterpartyName: String? = null,
    ): BankTransaction {
        val t = BankTransaction(
            externalId = externalId ?: nextExternalId(),
            amount = amount,
            currency = currency,
            vs = vs,
            receivedAt = receivedAt,
            counterpartyName = counterpartyName,
        )
        queue.addLast(t)
        return t
    }

    /**
     * Enqueue a scenario for a given target (vs + required amount). Returns the
     * transaction(s) generated. "none" generates nothing, "unavailable" toggles the
     * error condition.
     */
    @Synchronized
    fun scenario(type: ScenarioType, vs: String, amount: Money, currency: String = "CZK"): List<BankTransaction> {
        return when (type) {
            ScenarioType.exact -> listOf(enqueue(amount, vs, currency))
            ScenarioType.under -> listOf(enqueue(amount.subtract(money("1.00")), vs, currency))
            ScenarioType.over -> listOf(enqueue(amount.add(money("1.00")), vs, currency))
            // "lateness" is decided by when the poller runs vs expiry, txn is exact.
            ScenarioType.late -> listOf(enqueue(amount, vs, currency))
            ScenarioType.duplicate -> listOf(
                enqueue(amount, vs, currency),
                enqueue(amount, vs, currency),
            )
            // Right amount, wrong/typo'd reference: leading-zero VS never matches a generated VS.
            ScenarioType.wrongvs -> listOf(enqueue(amount, "0404040404", currency))
            ScenarioType.none -> emptyList()
            ScenarioType.unavailable -> {
                setAvailable(false)
                emptyList()
            }
        }
    }
}
