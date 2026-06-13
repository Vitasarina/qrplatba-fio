package cz.qrplatba.persistence

import cz.qrplatba.domain.MerchantConfig
import cz.qrplatba.domain.PaymentSession
import cz.qrplatba.domain.PaymentSessionJson
import cz.qrplatba.domain.isOpen
import cz.qrplatba.domain.toJson
import cz.qrplatba.domain.toSession
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

@Serializable
private data class PersistShape(
    val sessions: List<PaymentSessionJson> = emptyList(),
    val transactions: List<StoredTransaction> = emptyList(),
    val config: MerchantConfig? = null,
)

/**
 * In-memory repository with simple JSON-file persistence so state survives a
 * process/app restart. Writes are serialized and go to a temp file then renamed
 * (atomic on POSIX). Thread-safe via a single lock — mirrors the Node reference.
 *
 * @param file path to the JSON file; if null, persistence is disabled (pure in-memory, used in tests).
 */
class JsonSessionRepository(private val file: File?) : SessionRepository {
    private val lock = Any()
    private val sessions = LinkedHashMap<String, PaymentSession>()
    private val txs = LinkedHashMap<String, StoredTransaction>()
    private var config: MerchantConfig? = null

    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true; encodeDefaults = true }

    /** Load existing state from disk if present. Safe to call once at startup. */
    fun load() {
        val f = file ?: return
        if (!f.exists()) return
        val raw = f.readText()
        if (raw.isBlank()) return
        val data = json.decodeFromString(PersistShape.serializer(), raw)
        synchronized(lock) {
            sessions.clear()
            for (j in data.sessions) {
                val s = j.toSession()
                sessions[s.id] = s
            }
            txs.clear()
            for (t in data.transactions) txs[t.externalId] = t
            config = data.config
        }
    }

    override fun createSession(session: PaymentSession) {
        synchronized(lock) { sessions[session.id] = session }
        persist()
    }

    override fun getSession(id: String): PaymentSession? = synchronized(lock) { sessions[id] }

    override fun updateSession(session: PaymentSession) {
        synchronized(lock) { sessions[session.id] = session }
        persist()
    }

    override fun listSessions(filter: SessionFilter?): List<PaymentSession> = synchronized(lock) {
        var list = sessions.values.toList()
        if (filter?.status != null) list = list.filter { it.status.name == filter.status }
        if (filter?.from != null) list = list.filter { it.createdAt >= filter.from }
        if (filter?.to != null) list = list.filter { it.createdAt <= filter.to }
        // newest first
        list.sortedByDescending { it.createdAt }
    }

    override fun findOpenByVs(vs: String): List<PaymentSession> = synchronized(lock) {
        sessions.values
            .filter { it.vs == vs && isOpen(it.status) }
            .sortedBy { it.createdAt } // oldest first
    }

    override fun openVsSet(): Set<String> = synchronized(lock) {
        sessions.values.filter { isOpen(it.status) }.map { it.vs }.toSet()
    }

    override fun hasProcessedTx(externalId: String): Boolean = synchronized(lock) { txs.containsKey(externalId) }

    override fun recordTransaction(tx: StoredTransaction) {
        synchronized(lock) { txs[tx.externalId] = tx }
        persist()
    }

    override fun listTransactions(): List<StoredTransaction> = synchronized(lock) {
        txs.values.sortedByDescending { cz.qrplatba.domain.Iso.parse(it.receivedAt) }
    }

    override fun getConfig(): MerchantConfig? = synchronized(lock) { config }

    override fun setConfig(c: MerchantConfig) {
        synchronized(lock) { config = c }
        persist()
    }

    /** Factory reset: wipe config, sessions and recorded transactions (back to first run). */
    override fun reset() {
        synchronized(lock) {
            config = null
            sessions.clear()
            txs.clear()
        }
        persist()
    }

    private fun snapshot(): PersistShape = synchronized(lock) {
        PersistShape(
            sessions = sessions.values.map { it.toJson() },
            transactions = txs.values.toList(),
            config = config,
        )
    }

    /** Synchronous, serialized write. Persistence failure must not crash the request path. */
    fun persist() {
        val f = file ?: return
        try {
            synchronized(lock) {
                val data = json.encodeToString(PersistShape.serializer(), snapshot())
                f.parentFile?.mkdirs()
                val tmp = File(f.parentFile, f.name + ".tmp")
                tmp.writeText(data)
                if (!tmp.renameTo(f)) {
                    // renameTo can fail across some FS states; fall back to copy.
                    f.writeText(data)
                    tmp.delete()
                }
            }
        } catch (e: Exception) {
            System.err.println("JsonSessionRepository: persist failed: ${e.message}")
        }
    }
}
