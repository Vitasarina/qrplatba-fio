package cz.qrplatba.gateway

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import cz.qrplatba.domain.Iso
import java.math.BigDecimal
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Fio Bank gateway (real). Pulls incremental movements from the Fio REST API.
 *
 *   GET https://fioapi.fio.cz/v1/rest/last/{token}/transactions.json
 * The `/last` endpoint returns movements since the server-side bookmark ("zarážka")
 * and advances it, so each successful call returns only new transactions.
 *
 * MULTIPLE TOKENS (round-robin): the gateway holds up to MAX_TOKENS tokens and uses
 * the NEXT token (round-robin) on each [fetchNewTransactions] call. Each token has its
 * own server-side Fio bookmark, so rotating tokens still catches a payment within one
 * polling cycle, and the matcher is idempotent by externalId so any overlap is harmless.
 *
 * Fio rate limit: 1 request / token / 30 s. With N tokens the poller may query every
 * 30000/N ms because each individual token is still hit at most once per 30 s.
 *
 * Column mapping (each transaction is { "columnN": { value, name, id } }):
 *   column0  = date (datum)            -> receivedAt
 *   column1  = amount (objem)          -> amount  (keep only incoming, amount > 0)
 *   column5  = variabilní symbol (VS)  -> vs
 *   column14 = currency (měna)         -> currency
 *   column22 = ID pohybu               -> externalId (idempotence key)
 *
 * Network/HTTP/parse failures THROW so MatchingService maps them to UNKNOWN and
 * never to PAID. HTTPS only, read-only token.
 */
class FioGateway(
    private val tokens: List<String>,
    private val baseUrl: String = "https://fioapi.fio.cz/v1/rest",
) : BankGateway {

    /** Convenience constructor for a single token (kept for callers/tests). */
    constructor(token: String, baseUrl: String = "https://fioapi.fio.cz/v1/rest")
        : this(listOf(token), baseUrl)

    private val tokenList: List<String> =
        tokens.map { it.trim() }.filter { it.isNotEmpty() }

    private val lastOk = AtomicBoolean(true)
    private val rotation = AtomicInteger(0)

    /** The token used by the NEXT fetch (round-robin). Exposed for tests. */
    fun nextToken(): String {
        require(tokenList.isNotEmpty()) { "FioGateway requires at least one token" }
        val i = (rotation.getAndIncrement() % tokenList.size + tokenList.size) % tokenList.size
        return tokenList[i]
    }

    override fun fetchNewTransactions(): List<BankTransaction> {
        if (tokenList.isEmpty()) return emptyList()
        val token = nextToken()
        val body = httpGet("$baseUrl/last/$token/transactions.json")
        return try {
            val txs = parseFioTransactions(body)
            lastOk.set(true)
            txs
        } catch (e: Exception) {
            lastOk.set(false)
            throw BankUnavailableException("fio: unparseable response: ${e.message}")
        }
    }

    /** Reflects the last fetch outcome (true until the first failure). */
    override fun isAvailable(): Boolean = lastOk.get()

    private fun httpGet(url: String): String {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 8000
            readTimeout = 8000
            setRequestProperty("Accept", "application/json")
        }
        try {
            val code = conn.responseCode
            if (code !in 200..299) {
                lastOk.set(false)
                throw BankUnavailableException("fio: HTTP $code")
            }
            return conn.inputStream.bufferedReader().use { it.readText() }
        } catch (e: BankUnavailableException) {
            throw e
        } catch (e: Exception) {
            lastOk.set(false)
            throw BankUnavailableException("fio: network error: ${e.message}")
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /**
         * Pure parser for a Fio "transactions.json" response. Maps incoming-only
         * (amount > 0) movements to [BankTransaction]. Unit-testable without the network.
         */
        fun parseFioTransactions(body: String): List<BankTransaction> {
            val root = json.parseToJsonElement(body) as? JsonObject ?: return emptyList()
            val statement = root["accountStatement"] as? JsonObject ?: return emptyList()
            val txList = statement["transactionList"] as? JsonObject ?: return emptyList()
            val arr: JsonArray = txList["transaction"] as? JsonArray ?: return emptyList()

            val out = ArrayList<BankTransaction>()
            for (el in arr) {
                val tx = el.jsonObject
                val amount = colDecimal(tx, "column1") ?: continue
                // Keep only incoming movements.
                if (amount.signum() <= 0) continue
                val externalId = colString(tx, "column22") ?: continue
                val vs = colString(tx, "column5")
                val currency = colString(tx, "column14") ?: "CZK"
                val receivedAt = colString(tx, "column0")?.let { parseFioDate(it) }
                    ?: System.currentTimeMillis()

                out.add(
                    BankTransaction(
                        externalId = externalId,
                        amount = amount,
                        currency = currency,
                        vs = vs?.ifBlank { null },
                        receivedAt = receivedAt,
                    )
                )
            }
            return out
        }

        private fun col(tx: JsonObject, name: String): JsonObject? =
            (tx[name] as? JsonObject)

        private fun colString(tx: JsonObject, name: String): String? {
            val v = col(tx, name)?.get("value") ?: return null
            val prim = v as? JsonPrimitive ?: return null
            return prim.contentOrNull
        }

        private fun colDecimal(tx: JsonObject, name: String): BigDecimal? {
            val v = col(tx, name)?.get("value") as? JsonPrimitive ?: return null
            // Fio returns amounts as JSON numbers; be tolerant of string form too.
            v.doubleOrNull?.let { return BigDecimal(v.content) }
            return v.contentOrNull?.let {
                try { BigDecimal(it.trim().replace(",", ".")) } catch (e: Exception) { null }
            }
        }

        /** Fio dates look like "2026-06-13+0200"; tolerate plain ISO too. */
        private fun parseFioDate(raw: String): Long? {
            return try {
                val datePart = raw.take(10) // yyyy-MM-dd
                Iso.parse(datePart + "T00:00:00.000Z")
            } catch (e: Exception) {
                null
            }
        }
    }
}
