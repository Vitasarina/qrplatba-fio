package cz.qrplatba.server

import cz.qrplatba.api.Csv
import cz.qrplatba.api.Qr
import cz.qrplatba.domain.AmountError
import cz.qrplatba.domain.ConfigError
import cz.qrplatba.domain.isOpen
import cz.qrplatba.domain.toDTO
import cz.qrplatba.gateway.BankGateway
import cz.qrplatba.persistence.JsonSessionRepository
import cz.qrplatba.persistence.SessionFilter
import cz.qrplatba.persistence.toDTO
import cz.qrplatba.service.EventBus
import cz.qrplatba.service.InvalidStateError
import cz.qrplatba.service.MatchingService
import cz.qrplatba.service.NotConfiguredError
import cz.qrplatba.service.NotFoundError
import cz.qrplatba.service.NotLicensedError
import cz.qrplatba.service.SessionService
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import io.ktor.server.engine.ApplicationEngine
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.request.receiveText
import io.ktor.server.request.uri
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.response.respondBytesWriter
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.utils.io.writeStringUtf8
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/** Runtime configuration (mirrors the Node config.ts defaults). */
data class AppConfig(
    val port: Int = 8080,
    val host: String = "0.0.0.0",
    val pin: String = "1234",
    val pollIntervalMs: Long = 30000,
    val sessionTtlMs: Long = 5 * 60 * 1000,
    val simEnabled: Boolean = true,
)

/**
 * The full application graph + an embedded Ktor (CIO) server. Serves the bundled
 * React UI and the API on the same origin so the UI works unchanged. Asset loading
 * (the web/ folder) is supplied by the caller via [assetLoader] so this class stays
 * free of Android dependencies and remains unit-testable on the JVM.
 */
class AppServer(
    private val config: AppConfig,
    val repo: JsonSessionRepository,
    val gateway: BankGateway,
    private val assetLoader: (path: String) -> ByteArray?,
) {
    val events = EventBus()
    val sessions = SessionService(repo, events, config.sessionTtlMs)
    val matching = MatchingService(repo, gateway, events)

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private var engine: ApplicationEngine? = null

    fun start() {
        repo.load()
        // Resolve sessions left dangling across a restart: expire what should be expired.
        matching.expireStale()
        engine = embeddedServer(CIO, port = config.port, host = config.host) {
            module()
        }.also { it.start(wait = false) }
    }

    fun stop() {
        engine?.stop(500, 1000)
        engine = null
    }

    private fun Application.module() {
        install(ContentNegotiation) { json(Json { encodeDefaults = true }) }
        routing {
            registerApiRoutes()
            registerStaticAndSpa()
        }
    }

    // ---------- helpers ----------

    /** Effective PIN: the merchant-set PIN once configured, otherwise the bootstrap default. */
    private fun effectivePin(): String =
        repo.getConfig()?.pin?.takeIf { it.isNotBlank() } ?: config.pin

    private suspend fun ApplicationCall.requirePin(): Boolean {
        val header = request.headers["x-pin"]
        val cookie = request.cookies["pin"]
        val supplied = header ?: cookie
        if (supplied != effectivePin()) {
            respond(HttpStatusCode.Unauthorized, mapOf("error" to "unauthorized", "message" to "valid PIN required"))
            return false
        }
        return true
    }

    private suspend fun ApplicationCall.sendError(err: Throwable) {
        when (err) {
            is AmountError, is ConfigError, is InvalidStateError ->
                respond(HttpStatusCode.BadRequest, mapOf("error" to "bad_request", "message" to (err.message ?: "")))
            is NotFoundError ->
                respond(HttpStatusCode.NotFound, mapOf("error" to "not_found", "message" to (err.message ?: "")))
            is NotConfiguredError ->
                respond(HttpStatusCode.Conflict, mapOf("error" to "not_configured", "message" to (err.message ?: "")))
            is NotLicensedError ->
                respond(HttpStatusCode.Forbidden, mapOf("error" to "not_licensed", "message" to (err.message ?: "")))
            else ->
                respond(HttpStatusCode.InternalServerError, mapOf("error" to "internal", "message" to (err.message ?: "error")))
        }
    }

    private suspend fun ApplicationCall.parseBody(): JsonObject {
        val text = receiveText()
        if (text.isBlank()) return JsonObject(emptyMap())
        return try {
            val el: JsonElement = json.parseToJsonElement(text)
            el as? JsonObject ?: JsonObject(emptyMap())
        } catch (e: Exception) {
            JsonObject(emptyMap())
        }
    }

    /** Extract a JSON value as a string (numbers become their literal string). */
    private fun JsonObject.str(key: String): String? {
        val v = this[key] ?: return null
        if (v is JsonPrimitive) {
            if (v.isString) return v.content
            return v.contentOrNull // numeric/boolean literal text
        }
        return null
    }

    /** First site-local IPv4 (e.g. 192.168.x.x) so the admin screen can show a URL other devices can reach. */
    private fun lanIpv4(): String? = try {
        java.net.NetworkInterface.getNetworkInterfaces().toList()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.toList() }
            .filterIsInstance<java.net.Inet4Address>()
            .firstOrNull { it.isSiteLocalAddress }
            ?.hostAddress
    } catch (e: Exception) {
        null
    }

    /**
     * True when the request originates from the device itself (the phone's own WebView).
     * Used to gate the PIN-reset recovery: physical possession of the device is the auth
     * factor, so LAN/remote callers must be rejected even though no PIN is required.
     */
    private fun ApplicationCall.isLoopback(): Boolean {
        val host = request.local.remoteHost
        val addr = request.local.remoteAddress
        return isLoopbackAddr(host) || isLoopbackAddr(addr)
    }

    private fun isLoopbackAddr(value: String?): Boolean {
        if (value.isNullOrBlank()) return false
        val v = value.trim().lowercase().substringBefore('%') // strip IPv6 zone id
        if (v == "localhost" || v == "127.0.0.1" || v == "::1" || v == "0:0:0:0:0:0:0:1") return true
        return try {
            java.net.InetAddress.getByName(v).isLoopbackAddress
        } catch (e: Exception) {
            false
        }
    }

    /** [start, end) epoch-millis bounds of the current device-local calendar day. */
    private fun todayBounds(now: Long = System.currentTimeMillis()): Pair<Long, Long> {
        val cal = java.util.Calendar.getInstance()
        cal.timeInMillis = now
        cal.set(java.util.Calendar.HOUR_OF_DAY, 0)
        cal.set(java.util.Calendar.MINUTE, 0)
        cal.set(java.util.Calendar.SECOND, 0)
        cal.set(java.util.Calendar.MILLISECOND, 0)
        val start = cal.timeInMillis
        val end = start + 24L * 60 * 60 * 1000
        return start to end
    }

    // ---------- API routes ----------

    private fun io.ktor.server.routing.Route.registerApiRoutes() {
        // ---- auth: validate the PIN (used by the UI to gate config/operator pages) ----
        get("/api/auth") {
            if (!call.requirePin()) return@get
            call.respond(buildJsonObject { put("ok", true) })
        }
        // ---- config ----
        get("/api/config") {
            if (!call.requirePin()) return@get
            call.respond(sessions.getConfigDTO())
        }
        post("/api/config") {
            if (!call.requirePin()) return@post
            try {
                val b = call.parseBody()
                // Token "keep" rule: the GET only returns the token masked, so the UI
                // re-sends the mask (contains '*') or omits it (null) to mean "keep the
                // current token". An explicit empty string "" clears it (-> simulation).
                // Never store a masked value as if it were the real token.
                val rawToken = b.str("token")
                val token = if (rawToken == null || rawToken.contains('*')) {
                    repo.getConfig()?.token ?: ""
                } else {
                    rawToken
                }
                val dto = sessions.setConfig(
                    b.str("name"), b.str("iban"), token,
                    b.str("licenseKey"), b.str("logoUrl"), b.str("pin"),
                )
                call.respond(dto)
            } catch (e: Throwable) {
                call.sendError(e)
            }
        }
        // Factory reset: wipe config + sessions + transactions (back to first run).
        post("/api/config/reset") {
            if (!call.requirePin()) return@post
            sessions.reset()
            call.respond(buildJsonObject { put("ok", true) })
        }

        // ---- sessions ----
        post("/api/sessions") {
            if (!call.requirePin()) return@post
            try {
                val b = call.parseBody()
                val s = sessions.createSession(b.str("amount"), b.str("note"))
                call.respond(HttpStatusCode.Created, s.toDTO())
            } catch (e: Throwable) {
                call.sendError(e)
            }
        }
        get("/api/sessions") {
            if (!call.requirePin()) return@get
            val status = call.request.queryParameters["status"]
            val from = call.request.queryParameters["from"]?.let { cz.qrplatba.domain.Iso.parse(it) }
            val to = call.request.queryParameters["to"]?.let { cz.qrplatba.domain.Iso.parse(it) }
            val list = sessions.listSessions(SessionFilter(status, from, to))
            call.respond(list.map { it.toDTO() })
        }
        get("/api/sessions/export.csv") {
            if (!call.requirePin()) return@get
            val list = sessions.listSessions()
            call.response.headers.append(HttpHeaders.ContentDisposition, "attachment; filename=\"sessions.csv\"")
            call.respondText(Csv.sessionsToCsv(list), ContentType.parse("text/csv; charset=utf-8"))
        }

        // public (no PIN)
        get("/api/display-config") {
            call.respond(sessions.getDisplayConfigDTO())
        }
        get("/api/sessions/active") {
            val active = sessions.listSessions()
                .filter { isOpen(it.status) }
                .maxByOrNull { it.createdAt }
            if (active == null) {
                call.respondText("null", ContentType.Application.Json)
            } else {
                call.respond(active.toDTO())
            }
        }
        get("/api/sessions/{id}") {
            val id = call.parameters["id"]!!
            try {
                call.respond(sessions.getSession(id).toDTO())
            } catch (e: Throwable) {
                call.sendError(e)
            }
        }
        post("/api/sessions/{id}/cancel") {
            if (!call.requirePin()) return@post
            val id = call.parameters["id"]!!
            try {
                call.respond(sessions.cancelSession(id).toDTO())
            } catch (e: Throwable) {
                call.sendError(e)
            }
        }
        // Force an immediate bank check (one poll cycle) then return the updated session.
        post("/api/sessions/{id}/check") {
            if (!call.requirePin()) return@post
            val id = call.parameters["id"]!!
            try {
                // 404 fast if the session doesn't exist (before doing a poll cycle).
                sessions.getSession(id)
                matching.tick()
                call.respond(sessions.getSession(id).toDTO())
            } catch (e: Throwable) {
                call.sendError(e)
            }
        }

        // ---- transactions ----
        // Today's incoming bank transactions (device-local day), newest first.
        get("/api/transactions/today") {
            if (!call.requirePin()) return@get
            val (start, end) = todayBounds()
            val list = repo.listTransactions()
                // Hide simulated (test) payments — they aren't real bank movements.
                .filter { !it.externalId.startsWith("sim-") }
                .filter {
                    val t = try { cz.qrplatba.domain.Iso.parse(it.receivedAt) } catch (e: Exception) { return@filter false }
                    t in start until end
                }
                // listTransactions() already sorts newest first.
                .map { it.toDTO() }
            call.respond(list)
        }

        // ---- PIN reset (device-only recovery; loopback origin enforced) ----
        post("/api/pin/reset") {
            if (!call.isLoopback()) {
                call.respond(HttpStatusCode.Forbidden, buildJsonObject { put("error", "forbidden") })
                return@post
            }
            // Reset the stored PIN to empty so effectivePin() falls back to the default.
            repo.getConfig()?.let { repo.setConfig(it.copy(pin = "")) }
            call.respond(buildJsonObject { put("ok", true) })
        }

        // ---- SSE (public) ----
        get("/api/sessions/{id}/events") {
            val id = call.parameters["id"]!!
            val current = try {
                sessions.getSession(id)
            } catch (e: Throwable) {
                call.sendError(e)
                return@get
            }

            // Bridge EventBus callbacks (any thread) into the coroutine writer.
            val channel = Channel<String>(Channel.UNLIMITED)
            channel.trySend(json.encodeToString(cz.qrplatba.domain.SessionDTO.serializer(), current.toDTO()))
            val unsubscribe = events.onSessionChange(id) { s ->
                channel.trySend(json.encodeToString(cz.qrplatba.domain.SessionDTO.serializer(), s.toDTO()))
            }

            call.response.headers.append(HttpHeaders.CacheControl, "no-cache")
            call.response.headers.append("X-Accel-Buffering", "no")
            try {
                call.respondBytesWriter(contentType = ContentType.Text.EventStream) {
                    try {
                        for (payload in channel) {
                            writeStringUtf8("event: session\n")
                            writeStringUtf8("data: $payload\n\n")
                            flush()
                        }
                    } catch (e: Exception) {
                        // client disconnected
                    }
                }
            } finally {
                unsubscribe()
                channel.close()
            }
        }

        // ---- QR PNG (public) ----
        get("/api/qr/{id}") {
            val raw = call.parameters["id"]!!
            val id = if (raw.endsWith(".png")) raw.removeSuffix(".png") else raw
            try {
                val s = sessions.getSession(id)
                val png = Qr.spaydToPng(s.spayd)
                call.response.headers.append(HttpHeaders.CacheControl, "no-store")
                call.respondBytes(png, ContentType.Image.PNG)
            } catch (e: Throwable) {
                call.sendError(e)
            }
        }

        // ---- network info + generic QR (public; for the admin/access screen) ----
        get("/api/net-info") {
            val ip = lanIpv4() ?: "127.0.0.1"
            call.respond(buildJsonObject {
                put("ip", ip)
                put("port", config.port)
                put("baseUrl", "http://$ip:${config.port}")
            })
        }
        get("/api/qrcode") {
            val data = call.request.queryParameters["data"]
            if (data.isNullOrBlank()) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject { put("error", "bad_request") })
                return@get
            }
            call.response.headers.append(HttpHeaders.CacheControl, "no-store")
            call.respondBytes(Qr.spaydToPng(data), ContentType.Image.PNG)
        }

        get("/api/health") { call.respond(buildJsonObject { put("ok", true) }) }
    }

    // ---------- static assets + SPA fallback ----------

    private fun io.ktor.server.routing.Route.registerStaticAndSpa() {
        get("/{path...}") {
            val uri = call.request.uri.substringBefore('?')
            // /api is handled above; anything else is UI.
            if (uri.startsWith("/api/")) {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "not_found", "message" to "unknown route"))
                return@get
            }
            val asset = resolveAsset(uri)
            if (asset != null) {
                call.respondBytes(asset.second, asset.first)
                return@get
            }
            // SPA fallback: serve index.html for client-side routes.
            val index = assetLoader("web/index.html")
            if (index != null) {
                call.respondBytes(index, ContentType.Text.Html)
            } else {
                call.respond(HttpStatusCode.NotFound, mapOf("error" to "not_found", "message" to "no UI bundled"))
            }
        }
    }

    /** Resolve a request path to a bundled asset under web/. Returns (contentType, bytes) or null. */
    private fun resolveAsset(uri: String): Pair<ContentType, ByteArray>? {
        val path = uri.trimStart('/')
        if (path.isEmpty() || path == "index.html") {
            val bytes = assetLoader("web/index.html") ?: return null
            return ContentType.Text.Html to bytes
        }
        // Only serve real files (those with an extension), e.g. /assets/index-*.js, favicon, etc.
        if (!path.substringAfterLast('/').contains('.')) return null
        val bytes = assetLoader("web/$path") ?: return null
        return contentTypeFor(path) to bytes
    }

    private fun contentTypeFor(path: String): ContentType = when (path.substringAfterLast('.').lowercase()) {
        "js", "mjs" -> ContentType.parse("text/javascript")
        "css" -> ContentType.Text.CSS
        "html" -> ContentType.Text.Html
        "json" -> ContentType.Application.Json
        "png" -> ContentType.Image.PNG
        "jpg", "jpeg" -> ContentType.Image.JPEG
        "svg" -> ContentType.Image.SVG
        "ico" -> ContentType.parse("image/x-icon")
        "woff" -> ContentType.parse("font/woff")
        "woff2" -> ContentType.parse("font/woff2")
        else -> ContentType.Application.OctetStream
    }
}
