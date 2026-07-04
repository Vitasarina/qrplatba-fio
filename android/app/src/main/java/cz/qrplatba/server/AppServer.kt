package cz.qrplatba.server

import cz.qrplatba.api.Csv
import cz.qrplatba.api.Qr
import cz.qrplatba.domain.AmountError
import cz.qrplatba.domain.ConfigError
import cz.qrplatba.domain.MAX_TOKENS
import cz.qrplatba.domain.MerchantConfig
import cz.qrplatba.domain.PasswordHash
import cz.qrplatba.domain.isOpen
import cz.qrplatba.domain.toDTO
import cz.qrplatba.domain.toPublicDTO
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
import io.ktor.server.application.ApplicationCallPipeline
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
import kotlinx.serialization.json.JsonArray
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
    /** Scheduler tick interval. The poller ticks frequently and decides per tick whether a
     *  bank query is due (smart cadence lives in MatchingService). 1 s by default. */
    val pollIntervalMs: Long = 1000,
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
        // Gate LAN access behind service mode (loopback / on-device is always allowed).
        intercept(ApplicationCallPipeline.Plugins) {
            if (lanBlocked(call.isLoopback(), serviceModeActive())) {
                if (call.request.uri.startsWith("/api/")) {
                    call.respond(
                        HttpStatusCode.ServiceUnavailable,
                        mapOf(
                            "error" to "service_mode_off",
                            "message" to "Vzdálený přístup je vypnutý. Zapněte servisní režim na displeji zařízení.",
                        ),
                    )
                } else {
                    call.respondText(SERVICE_OFF_HTML, ContentType.Text.Html, HttpStatusCode.ServiceUnavailable)
                }
                finish()
            }
        }
        routing {
            registerApiRoutes()
            registerStaticAndSpa()
        }
    }

    companion object {
        /** Pure gate decision (testable): block a request from the LAN unless service mode is active. */
        fun lanBlocked(loopback: Boolean, serviceActive: Boolean): Boolean = !loopback && !serviceActive

        private val SERVICE_OFF_HTML = """
            <!doctype html><html lang="cs"><head><meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Vzdálený přístup vypnutý</title>
            <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#f8fafc;
            display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:2rem;text-align:center}
            div{max-width:30rem}h1{font-size:1.5rem}p{color:#94a3b8;line-height:1.5}</style></head>
            <body><div><h1>Vzdálený přístup je vypnutý</h1>
            <p>Pro konfiguraci nebo kontrolu plateb z tohoto zařízení zapněte <strong>servisní režim</strong>
            přímo na displeji terminálu (5× ťukněte do pravého horního rohu → Servisní režim).</p></div></body></html>
        """.trimIndent()
    }

    // ---------- helpers ----------

    /** Minimum length for the mandatory settings password. */
    private val minPasswordLen = 4

    /** The stored operator password. Empty string = NOT set (first-run, no default). */
    private fun storedPassword(): String = repo.getConfig()?.pin.orEmpty()

    /** Whether the mandatory settings password has been created. */
    private fun passwordSet(): Boolean = storedPassword().isNotBlank()

    // ---- brute-force lockout (single shared password; in-memory, per-process) ----
    private val authLock = Any()
    private var authFails = 0
    private var lockedUntil = 0L

    /** Remaining lockout in ms (0 = not locked). */
    private fun authLockedForMs(now: Long): Long = synchronized(authLock) { maxOf(0L, lockedUntil - now) }

    private fun recordAuthFailure(now: Long) = synchronized(authLock) {
        authFails++
        // After 5 consecutive failures, lock out with escalating backoff (5 s per extra
        // failure, capped at 60 s). Any success resets the counter.
        if (authFails >= 5) {
            val extra = minOf(60_000L, (authFails - 4) * 5_000L)
            lockedUntil = now + extra
        }
    }

    private fun recordAuthSuccess() = synchronized(authLock) { authFails = 0; lockedUntil = 0 }

    // ---- service mode: LAN access only on demand (small plaintext-HTTP attack window) ----
    // The server always listens, but requests from OTHER devices on the LAN are blocked
    // UNLESS the operator has enabled "service mode" from the on-device admin screen. This
    // means during normal on-device operation NO sensitive data ever crosses the LAN wire;
    // it is exposed only during a short, operator-initiated, auto-expiring admin window.
    @Volatile private var serviceModeUntil: Long = 0L
    /** Default / maximum service-mode window in minutes. */
    private val serviceModeDefaultMinutes = 15
    private val serviceModeMaxMinutes = 120

    fun serviceModeActive(now: Long = System.currentTimeMillis()): Boolean = now < serviceModeUntil
    private fun serviceModeRemainingMs(now: Long = System.currentTimeMillis()): Long =
        maxOf(0L, serviceModeUntil - now)

    /**
     * Validate the supplied x-pin against the stored password WITHOUT sending a response or
     * touching the lockout. Used to content-vary otherwise-public endpoints (a wrong/absent
     * pin simply yields the minimal public view — no secret is exposed, so no brute-force value).
     */
    private fun ApplicationCall.isPinValid(): Boolean {
        val stored = storedPassword()
        if (stored.isBlank()) return false
        val supplied = request.headers["x-pin"] ?: return false
        return PasswordHash.verify(supplied, stored)
    }

    /**
     * Guard for operator/config endpoints. There is NO default password: when none is set
     * (first run) EVERY guarded endpoint is rejected (401) — the only way forward is to
     * create one via POST /api/password/setup. Once set, requires a valid x-pin HEADER
     * (cookie auth removed to avoid a CSRF vector). A brute-force lockout applies.
     */
    private suspend fun ApplicationCall.requirePin(): Boolean {
        val stored = storedPassword()
        if (stored.isBlank()) {
            respond(HttpStatusCode.Unauthorized, mapOf("error" to "unauthorized", "message" to "password not set"))
            return false
        }
        val now = System.currentTimeMillis()
        val wait = authLockedForMs(now)
        if (wait > 0) {
            respond(
                HttpStatusCode.TooManyRequests,
                mapOf("error" to "locked", "message" to "příliš mnoho pokusů, zkuste to za ${(wait / 1000) + 1} s"),
            )
            return false
        }
        val supplied = request.headers["x-pin"]
        if (supplied == null || !PasswordHash.verify(supplied, stored)) {
            recordAuthFailure(now)
            respond(HttpStatusCode.Unauthorized, mapOf("error" to "unauthorized", "message" to "valid password required"))
            return false
        }
        recordAuthSuccess()
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
            else -> {
                // Do NOT leak internal exception detail to the client; log it instead.
                System.err.println("AppServer: internal error: ${err.message}")
                respond(HttpStatusCode.InternalServerError, mapOf("error" to "internal", "message" to "interní chyba serveru"))
            }
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

    private fun JsonObject.bool(key: String): Boolean? {
        val p = this[key] as? JsonPrimitive ?: return null
        return p.content.toBooleanStrictOrNull()
    }

    /**
     * Extract a JSON string array (e.g. body field `tokens`). Returns null when the key is
     * absent, an empty list when present-but-empty. Non-string elements are coerced to their
     * literal text; nulls are dropped.
     */
    private fun JsonObject.strList(key: String): List<String>? {
        val v = this[key] ?: return null
        val arr = v as? JsonArray ?: return null
        return arr.mapNotNull { el ->
            val p = el as? JsonPrimitive ?: return@mapNotNull null
            if (p.isString) p.content else p.contentOrNull
        }
    }

    /**
     * Apply the positional keep-by-mask rule to an incoming `tokens` array against the
     * currently stored tokens. For index i: a value containing '*' (a mask) keeps the
     * stored token at position i (if any); a non-blank real value is used as-is; blank is
     * dropped. The result is capped at MAX_TOKENS. This lets the UI render masked existing
     * tokens and only type genuinely new ones.
     */
    private fun resolveTokens(incoming: List<String>): List<String> {
        val stored = repo.getConfig()?.normalizedTokens() ?: emptyList()
        val out = ArrayList<String>()
        for ((i, raw) in incoming.withIndex()) {
            val v = raw.trim()
            when {
                v.isEmpty() -> { /* drop */ }
                v.contains('*') -> stored.getOrNull(i)?.let { out.add(it) }
                else -> out.add(v)
            }
            if (out.size >= MAX_TOKENS) break
        }
        return out
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
                // Tokens keep-by-mask rule: the GET returns each token masked, so the UI
                // re-sends masks (contain '*') to keep stored tokens at that position and
                // real values for new ones. Blank entries are dropped. Capped at MAX_TOKENS.
                // The password is NOT accepted here — it is managed via the password endpoints.
                val incoming = b.strList("tokens") ?: emptyList()
                val tokens = resolveTokens(incoming)
                val dto = sessions.setConfig(
                    b.str("name"), b.str("iban"), tokens,
                    b.str("licenseKey"), b.str("logoUrl"), b.bool("flipped"),
                    b.str("opMode"),
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
        // Set the operating (workflow) mode: {"mode":"kasa"|"paper"|""}. Preserves the rest.
        post("/api/opmode") {
            if (!call.requirePin()) return@post
            try {
                val b = call.parseBody()
                call.respond(sessions.setOpMode(b.str("mode")))
            } catch (e: Throwable) {
                call.sendError(e)
            }
        }

        // ---- sessions ----
        post("/api/sessions") {
            if (!call.requirePin()) return@post
            try {
                // Register mode: before publishing a QR we must be able to verify the payment
                // later. Probe the bank with a REAL token query; if it is unreachable, refuse
                // rather than show a QR we can't reconcile. (Simulation always probes true.)
                if (!matching.probeBank()) {
                    call.respond(HttpStatusCode.ServiceUnavailable, buildJsonObject {
                        put("error", "bank_unreachable")
                        put("message", "Nelze ověřit spojení s bankou. QR platba nebyla vystavena — zkontrolujte připojení k internetu.")
                    })
                    return@post
                }
                val b = call.parseBody()
                val s = sessions.createSession(b.str("amount"), b.str("note"))
                call.respond(HttpStatusCode.Created, s.toDTO())
            } catch (e: Throwable) {
                call.sendError(e)
            }
        }
        // Paper mode: start waiting for the NEXT incoming payment (optional exact amount).
        post("/api/sessions/watch") {
            if (!call.requirePin()) return@post
            try {
                val b = call.parseBody()
                val s = sessions.createWatchSession(b.str("amount"), b.str("note"))
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
                // Public: minimal DTO only (no IBAN/SPAYD, VS or note).
                call.respond(active.toPublicDTO())
            }
        }
        get("/api/sessions/{id}") {
            val id = call.parameters["id"]!!
            try {
                val s = sessions.getSession(id)
                // Full details only for an authenticated operator; the public/display view
                // gets the minimal DTO (a wrong/absent pin is not an error here).
                if (call.isPinValid()) call.respond(s.toDTO()) else call.respond(s.toPublicDTO())
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
                // Manual check forces an immediate bank query (counts toward cadence timing).
                matching.forceCheck()
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

        // ---- password status (PUBLIC): lets the UI choose "create" vs "enter" password ----
        get("/api/password/status") {
            call.respond(buildJsonObject { put("passwordSet", passwordSet()) })
        }

        // ---- password setup (device-only, first-run only): create the mandatory password ----
        post("/api/password/setup") {
            // Loopback-only: physical possession of the device is the auth factor here.
            if (!call.isLoopback()) {
                call.respond(HttpStatusCode.Forbidden, buildJsonObject { put("error", "forbidden") })
                return@post
            }
            // Only allowed while no password is set; otherwise it is not the bootstrap path.
            if (passwordSet()) {
                call.respond(HttpStatusCode.Forbidden, buildJsonObject {
                    put("error", "forbidden"); put("message", "password already set")
                })
                return@post
            }
            val b = call.parseBody()
            val pw = (b.str("password") ?: "").trim()
            if (pw.length < minPasswordLen) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject {
                    put("error", "bad_request"); put("message", "heslo musí mít alespoň $minPasswordLen znaky")
                })
                return@post
            }
            // Persist the password HASHED; create a minimal config row if none exists yet.
            val hashed = PasswordHash.hash(pw)
            val cur = repo.getConfig()
            if (cur == null) {
                repo.setConfig(MerchantConfig(name = "", iban = "", tokens = emptyList(), pin = hashed))
            } else {
                repo.setConfig(cur.copy(pin = hashed, legacyToken = null))
            }
            call.respond(buildJsonObject { put("ok", true) })
        }

        // ---- password change (operator-authenticated; requires current as defense) ----
        post("/api/password/change") {
            if (!call.requirePin()) return@post
            val b = call.parseBody()
            val current = (b.str("current") ?: "")
            val next = (b.str("new") ?: "").trim()
            if (!PasswordHash.verify(current, storedPassword())) {
                call.respond(HttpStatusCode.Unauthorized, buildJsonObject {
                    put("error", "unauthorized"); put("message", "current password mismatch")
                })
                return@post
            }
            if (next.length < minPasswordLen) {
                call.respond(HttpStatusCode.BadRequest, buildJsonObject {
                    put("error", "bad_request"); put("message", "heslo musí mít alespoň $minPasswordLen znaky")
                })
                return@post
            }
            repo.getConfig()?.let { repo.setConfig(it.copy(pin = PasswordHash.hash(next), legacyToken = null)) }
            call.respond(buildJsonObject { put("ok", true) })
        }

        // ---- forgot password (device-only recovery; loopback origin enforced) ----
        // Clears the password (pin="") -> returns to first-run "create password" state.
        post("/api/pin/reset") {
            if (!call.isLoopback()) {
                call.respond(HttpStatusCode.Forbidden, buildJsonObject { put("error", "forbidden") })
                return@post
            }
            repo.getConfig()?.let { repo.setConfig(it.copy(pin = "", legacyToken = null)) }
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

            // Bridge EventBus callbacks (any thread) into the coroutine writer. SSE cannot
            // carry the x-pin header, so frames are the minimal PUBLIC DTO; the operator UI
            // merges them onto its authenticated full snapshot (keeps VS/note).
            val channel = Channel<String>(Channel.UNLIMITED)
            channel.trySend(json.encodeToString(cz.qrplatba.domain.PublicSessionDTO.serializer(), current.toPublicDTO()))
            val unsubscribe = events.onSessionChange(id) { s ->
                channel.trySend(json.encodeToString(cz.qrplatba.domain.PublicSessionDTO.serializer(), s.toPublicDTO()))
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

        // ---- service mode (LAN access window; toggled from the on-device admin) ----
        get("/api/service-mode") {
            call.respond(buildJsonObject {
                put("on", serviceModeActive())
                put("remainingMs", serviceModeRemainingMs())
                put("defaultMinutes", serviceModeDefaultMinutes)
            })
        }
        post("/api/service-mode") {
            val b = call.parseBody()
            val on = b.bool("on") ?: false
            if (on) {
                // Opening the LAN window is gated by physical possession (loopback only).
                if (!call.isLoopback()) {
                    call.respond(HttpStatusCode.Forbidden, buildJsonObject {
                        put("error", "forbidden")
                        put("message", "Servisní režim lze zapnout jen přímo na zařízení.")
                    })
                    return@post
                }
                val minutes = (b.str("minutes")?.toIntOrNull() ?: serviceModeDefaultMinutes)
                    .coerceIn(1, serviceModeMaxMinutes)
                serviceModeUntil = System.currentTimeMillis() + minutes * 60_000L
            } else {
                // Closing the window is always allowed (never a security risk).
                serviceModeUntil = 0L
            }
            call.respond(buildJsonObject {
                put("on", serviceModeActive())
                put("remainingMs", serviceModeRemainingMs())
            })
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
        // Reject path traversal / absolute-path attempts outright.
        val decoded = try { java.net.URLDecoder.decode(uri, "UTF-8") } catch (e: Exception) { uri }
        if (decoded.contains("..") || decoded.contains('\\') || decoded.contains(' ')) return null
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
