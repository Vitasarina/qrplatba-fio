package cz.qrplatba

import cz.qrplatba.gateway.ModeGateway
import cz.qrplatba.persistence.JsonSessionRepository
import cz.qrplatba.server.AppConfig
import cz.qrplatba.server.AppServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL

/**
 * Boots the real embedded Ktor server on a free port and exercises the HTTP API
 * end to end (mandatory-password guard, public endpoints, session lifecycle,
 * simulator, matching, multiple tokens). This covers the HTTP/SSE-routing layer
 * that the pure-domain unit tests don't — the only piece left for on-device testing
 * is the Android WebView shell itself.
 *
 * Mandatory password: there is NO default. Each test that needs operator access first
 * calls POST /api/password/setup (loopback — the test client is 127.0.0.1) to create the
 * password "1234", after which `pin = true` (x-pin: 1234) authenticates as before.
 */
class ServerIntegrationTest {

    private data class Resp(val code: Int, val body: String)

    private fun req(
        base: String,
        method: String,
        path: String,
        body: String? = null,
        pin: Boolean = false,
        pinValue: String? = null,
    ): Resp {
        val c = URL(base + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 3000
        c.readTimeout = 3000
        val sendPin = pinValue ?: if (pin) "1234" else null
        if (sendPin != null) c.setRequestProperty("x-pin", sendPin)
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toByteArray()) }
        }
        val code = c.responseCode
        val stream = if (code in 200..299) c.inputStream else c.errorStream
        val text = stream?.bufferedReader()?.use(BufferedReader::readText) ?: ""
        c.disconnect()
        return Resp(code, text)
    }

    private fun field(json: String, key: String): String? =
        Regex("\"$key\":\"([^\"]*)\"").find(json)?.groupValues?.get(1)

    /** Create the mandatory password (loopback-only setup) so operator endpoints unlock. */
    private fun setupPassword(base: String, password: String = "1234") {
        val r = req(base, "POST", "/api/password/setup", "{\"password\":\"$password\"}")
        assertEquals("password setup should succeed: ${r.body}", 200, r.code)
    }

    @Test
    fun full_payment_flow_over_http() {
        val port = ServerSocket(0).use { it.localPort }
        val base = "http://127.0.0.1:$port"
        val repo = JsonSessionRepository(null)
        val server = AppServer(AppConfig(port = port, host = "127.0.0.1"), repo, ModeGateway(repo)) { null }
        server.start()
        try {
            // Wait until the server is accepting connections.
            var up = false
            for (i in 0 until 50) {
                try {
                    req(base, "GET", "/api/display-config")
                    up = true
                    break
                } catch (e: Exception) {
                    Thread.sleep(100)
                }
            }
            assertTrue("server did not start", up)

            // First run: no password set yet.
            val st0 = req(base, "GET", "/api/password/status")
            assertEquals(200, st0.code)
            assertTrue("expected passwordSet:false, got: ${st0.body}", st0.body.contains("\"passwordSet\":false"))

            // Before any password is set, operator endpoints are locked (401), even with a guess.
            assertEquals(401, req(base, "GET", "/api/config").code)
            assertEquals(401, req(base, "GET", "/api/config", pin = true).code)
            assertEquals(401, req(base, "GET", "/api/auth", pin = true).code)

            // Create the mandatory password (loopback setup), then auth works.
            setupPassword(base)
            val st1 = req(base, "GET", "/api/password/status")
            assertTrue("expected passwordSet:true, got: ${st1.body}", st1.body.contains("\"passwordSet\":true"))
            assertEquals(401, req(base, "GET", "/api/auth").code)
            assertEquals(200, req(base, "GET", "/api/auth", pin = true).code)

            // Public display-config (no PIN, no secrets) — defaults to simulation mode.
            val dc = req(base, "GET", "/api/display-config")
            assertEquals(200, dc.code)
            assertTrue("display-config should expose mode: ${dc.body}", dc.body.contains("\"mode\":\"simulace\""))

            // Public net-info exposes a base URL for the admin screen.
            val ni = req(base, "GET", "/api/net-info")
            assertEquals(200, ni.code)
            assertTrue("net-info missing baseUrl: ${ni.body}", ni.body.contains("\"baseUrl\""))

            // Generic QR endpoint renders an image for an arbitrary URL.
            assertEquals(200, req(base, "GET", "/api/qrcode?data=http%3A%2F%2F192.168.1.34%3A8080%2Fsetup").code)

            // Not configured yet -> creating a session is blocked.
            assertEquals(409, req(base, "POST", "/api/sessions", "{\"amount\":\"10.00\"}", pin = true).code)

            // Configure the merchant WITHOUT tokens -> simulation/auto-confirm mode.
            val cfg = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop\",\"iban\":\"CZ6508000000192000145399\",\"logoUrl\":\"\"}",
                pin = true,
            )
            assertEquals(200, cfg.code)
            assertTrue("config should report simulation mode: ${cfg.body}", cfg.body.contains("\"mode\":\"simulace\""))
            assertTrue("config should report tokenCount 0: ${cfg.body}", cfg.body.contains("\"tokenCount\":0"))

            // Create a payment session.
            val created = req(base, "POST", "/api/sessions", "{\"amount\":\"123.00\"}", pin = true)
            assertEquals(201, created.code)
            val id = field(created.body, "id") ?: error("no id in $created")
            assertTrue(created.body.contains("\"status\":\"PENDING\""))

            // The display can read the active session without a PIN.
            val active = req(base, "GET", "/api/sessions/active")
            assertEquals(200, active.code)
            assertEquals(id, field(active.body, "id"))

            // In simulation mode a forced check auto-confirms the open session.
            server.matching.forceCheck()

            // Session is now PAID (public read).
            val paid = req(base, "GET", "/api/sessions/$id")
            assertEquals(200, paid.code)
            assertTrue("expected PAID, got: ${paid.body}", paid.body.contains("\"status\":\"PAID\""))

            // No open session remains.
            assertEquals("null", req(base, "GET", "/api/sessions/active").body.trim())
        } finally {
            server.stop()
        }
    }

    /** Boots a server on a free port and waits until it accepts connections. */
    private fun bootServer(
        repo: JsonSessionRepository = JsonSessionRepository(null),
    ): Triple<AppServer, String, Int> {
        val port = ServerSocket(0).use { it.localPort }
        val base = "http://127.0.0.1:$port"
        val server = AppServer(AppConfig(port = port, host = "127.0.0.1"), repo, ModeGateway(repo)) { null }
        server.start()
        var up = false
        for (i in 0 until 50) {
            try { req(base, "GET", "/api/display-config"); up = true; break } catch (e: Exception) { Thread.sleep(100) }
        }
        assertTrue("server did not start", up)
        return Triple(server, base, port)
    }

    /** Set up the password ("1234") then configure WITHOUT tokens -> simulation mode. */
    private fun configure(base: String) {
        setupPassword(base)
        val cfg = req(
            base, "POST", "/api/config",
            "{\"name\":\"Shop\",\"iban\":\"CZ6508000000192000145399\",\"logoUrl\":\"\"}",
            pin = true,
        )
        assertEquals(200, cfg.code)
    }

    @Test
    fun check_endpoint_drives_pending_to_paid() {
        val (server, base, _) = bootServer()
        try {
            configure(base)
            val created = req(base, "POST", "/api/sessions", "{\"amount\":\"55.00\"}", pin = true)
            assertEquals(201, created.code)
            val id = field(created.body, "id") ?: error("no id in $created")
            assertTrue(created.body.contains("\"status\":\"PENDING\""))

            // Endpoint is PIN-protected.
            assertEquals(401, req(base, "POST", "/api/sessions/$id/check", "{}").code)
            // Unknown session -> 404.
            assertEquals(404, req(base, "POST", "/api/sessions/does-not-exist/check", "{}", pin = true).code)

            // Simulation mode auto-confirms: forcing an immediate check pays the session.
            val checked = req(base, "POST", "/api/sessions/$id/check", "{}", pin = true)
            assertEquals(200, checked.code)
            assertEquals(id, field(checked.body, "id"))
            assertTrue("expected PAID, got: ${checked.body}", checked.body.contains("\"status\":\"PAID\""))
        } finally {
            server.stop()
        }
    }

    @Test
    fun transactions_today_lists_recorded_incoming() {
        val (server, base, _) = bootServer()
        try {
            configure(base)

            // PIN-protected, and empty before anything arrives.
            assertEquals(401, req(base, "GET", "/api/transactions/today").code)
            assertEquals("[]", req(base, "GET", "/api/transactions/today", pin = true).body.trim())

            // Record a REAL (non-"sim-") incoming transaction directly, as the Fio gateway would.
            val now = java.time.Instant.now().truncatedTo(java.time.temporal.ChronoUnit.MILLIS).toString()
            server.repo.recordTransaction(
                cz.qrplatba.persistence.StoredTransaction(
                    externalId = "fio-12345",
                    amount = "42.00",
                    currency = "CZK",
                    vs = "8888",
                    receivedAt = now,
                    matchedSessionId = "sess-1",
                    unmatchedReason = null,
                ),
            )

            val today = req(base, "GET", "/api/transactions/today", pin = true)
            assertEquals(200, today.code)
            assertTrue("expected vs 8888 in: ${today.body}", today.body.contains("\"vs\":\"8888\""))
            assertTrue("expected matched:true in: ${today.body}", today.body.contains("\"matched\":true"))
            assertTrue("expected amount field in: ${today.body}", today.body.contains("\"amount\":\"42.00\""))
        } finally {
            server.stop()
        }
    }

    @Test
    fun password_setup_loopback_only_and_only_when_unset() {
        val (server, base, _) = bootServer()
        try {
            // First run: status is false.
            assertTrue(req(base, "GET", "/api/password/status").body.contains("\"passwordSet\":false"))

            // Too-short password is rejected.
            assertEquals(400, req(base, "POST", "/api/password/setup", "{\"password\":\"12\"}").code)

            // Valid setup (loopback) succeeds.
            assertEquals(200, req(base, "POST", "/api/password/setup", "{\"password\":\"1234\"}").code)
            assertTrue(req(base, "GET", "/api/password/status").body.contains("\"passwordSet\":true"))

            // A SECOND setup is forbidden once a password exists (only the unset path is allowed).
            assertEquals(403, req(base, "POST", "/api/password/setup", "{\"password\":\"9999\"}").code)

            // The first password still authenticates; the rejected one does not.
            assertEquals(200, req(base, "GET", "/api/auth", pinValue = "1234").code)
            assertEquals(401, req(base, "GET", "/api/auth", pinValue = "9999").code)
        } finally {
            server.stop()
        }
    }

    @Test
    fun endpoints_locked_until_password_set_then_open() {
        val (server, base, _) = bootServer()
        try {
            // Guarded endpoints all 401 before any password exists.
            assertEquals(401, req(base, "GET", "/api/config", pin = true).code)
            assertEquals(401, req(base, "POST", "/api/sessions", "{\"amount\":\"10.00\"}", pin = true).code)
            assertEquals(401, req(base, "GET", "/api/transactions/today", pin = true).code)
            assertEquals(401, req(base, "POST", "/api/config/reset", "{}", pin = true).code)

            // Public endpoints stay public.
            assertEquals(200, req(base, "GET", "/api/display-config").code)
            assertEquals(200, req(base, "GET", "/api/password/status").code)

            // After setup, the password authenticates.
            setupPassword(base)
            assertEquals(200, req(base, "GET", "/api/config", pin = true).code)
        } finally {
            server.stop()
        }
    }

    @Test
    fun password_change_requires_current() {
        val (server, base, _) = bootServer()
        try {
            setupPassword(base) // password = 1234

            // Change requires auth (the new-password endpoint is guarded).
            assertEquals(401, req(base, "POST", "/api/password/change", "{\"current\":\"1234\",\"new\":\"5678\"}").code)

            // Wrong current -> 401.
            assertEquals(
                401,
                req(base, "POST", "/api/password/change", "{\"current\":\"0000\",\"new\":\"5678\"}", pin = true).code,
            )
            // Too-short new -> 400.
            assertEquals(
                400,
                req(base, "POST", "/api/password/change", "{\"current\":\"1234\",\"new\":\"99\"}", pin = true).code,
            )
            // Correct current + valid new -> 200, and the new password takes effect.
            assertEquals(
                200,
                req(base, "POST", "/api/password/change", "{\"current\":\"1234\",\"new\":\"5678\"}", pin = true).code,
            )
            assertEquals(200, req(base, "GET", "/api/auth", pinValue = "5678").code)
            assertEquals(401, req(base, "GET", "/api/auth", pinValue = "1234").code)
        } finally {
            server.stop()
        }
    }

    @Test
    fun pin_reset_from_loopback_clears_to_first_run() {
        // The test HTTP client connects from 127.0.0.1, so this exercises the loopback (allowed) path.
        // The 403 remote/LAN path cannot be simulated here without a non-loopback client.
        val (server, base, _) = bootServer()
        try {
            setupPassword(base) // password = 1234
            assertEquals(200, req(base, "GET", "/api/auth", pinValue = "1234").code)

            // Forgot password (loopback): clears the password back to the first-run state.
            val reset = req(base, "POST", "/api/pin/reset", "{}")
            assertEquals(200, reset.code)
            assertTrue("expected ok:true, got: ${reset.body}", reset.body.contains("\"ok\":true"))

            // Back to first-run: no password set; the old password no longer authenticates.
            assertTrue(req(base, "GET", "/api/password/status").body.contains("\"passwordSet\":false"))
            assertEquals(401, req(base, "GET", "/api/auth", pinValue = "1234").code)

            // The only way forward is to create a new password again.
            assertEquals(200, req(base, "POST", "/api/password/setup", "{\"password\":\"4321\"}").code)
            assertEquals(200, req(base, "GET", "/api/auth", pinValue = "4321").code)
        } finally {
            server.stop()
        }
    }

    @Test
    fun custom_pin_replaces_setup_default() {
        val (server, base, _) = bootServer()
        try {
            // Set up the mandatory password directly to a custom value.
            setupPassword(base, "4321")
            assertEquals(200, req(base, "GET", "/api/auth", pinValue = "4321").code)
            assertEquals(401, req(base, "GET", "/api/auth", pinValue = "1234").code)

            // Configure (no tokens), and verify hasPin/passwordSet stay true across config saves.
            val saved = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop\",\"iban\":\"CZ6508000000192000145399\",\"logoUrl\":\"\"}",
                pinValue = "4321",
            )
            assertEquals(200, saved.code)
            assertTrue("hasPin should stay true: ${saved.body}", saved.body.contains("\"hasPin\":true"))
            assertTrue("passwordSet should stay true: ${saved.body}", saved.body.contains("\"passwordSet\":true"))

            // Creating a session requires the password.
            assertEquals(401, req(base, "POST", "/api/sessions", "{\"amount\":\"10.00\"}", pinValue = "1234").code)
            assertEquals(201, req(base, "POST", "/api/sessions", "{\"amount\":\"10.00\"}", pinValue = "4321").code)
        } finally {
            server.stop()
        }
    }

    @Test
    fun tokens_select_mode_and_mask_keeps_tokens() {
        val (server, base, _) = bootServer()
        try {
            setupPassword(base)
            // Two real tokens -> Fio mode, tokenCount 2.
            val r1 = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop\",\"iban\":\"CZ6508000000192000145399\",\"tokens\":[\"fio-secret-1234\",\"fio-other-5678\"],\"logoUrl\":\"\"}",
                pin = true,
            )
            assertEquals(200, r1.code)
            assertTrue("expected fio mode: ${r1.body}", r1.body.contains("\"mode\":\"fio\""))
            assertTrue("expected tokenCount 2: ${r1.body}", r1.body.contains("\"tokenCount\":2"))

            // Re-saving with MASKED tokens (each contains '*') must KEEP the stored tokens -> still 2, fio.
            val masks = Regex("\"tokensMasked\":\\[([^\\]]*)\\]").find(r1.body)?.groupValues?.get(1)
                ?: error("no tokensMasked in ${r1.body}")
            val r2 = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop2\",\"iban\":\"CZ6508000000192000145399\",\"tokens\":[$masks],\"logoUrl\":\"\"}",
                pin = true,
            )
            assertEquals(200, r2.code)
            assertTrue("mask must keep tokens (still fio): ${r2.body}", r2.body.contains("\"mode\":\"fio\""))
            assertTrue("mask must keep both tokens: ${r2.body}", r2.body.contains("\"tokenCount\":2"))

            // Positional keep-by-mask: keep token[0] (mask) and add a new real token[1].
            val firstMask = Config_maskFirst(r2.body)
            val r3 = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop2\",\"iban\":\"CZ6508000000192000145399\",\"tokens\":[\"$firstMask\",\"brand-new-token\"],\"logoUrl\":\"\"}",
                pin = true,
            )
            assertEquals(200, r3.code)
            assertTrue("expected tokenCount 2 after keep+add: ${r3.body}", r3.body.contains("\"tokenCount\":2"))

            // Empty tokens array clears them -> simulation mode.
            val r4 = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop2\",\"iban\":\"CZ6508000000192000145399\",\"tokens\":[],\"logoUrl\":\"\"}",
                pin = true,
            )
            assertEquals(200, r4.code)
            assertTrue("empty tokens -> simulace: ${r4.body}", r4.body.contains("\"mode\":\"simulace\""))
            assertTrue("empty tokens -> tokenCount 0: ${r4.body}", r4.body.contains("\"tokenCount\":0"))
        } finally {
            server.stop()
        }
    }

    /** Pull the first element of the tokensMasked array out of a config response. */
    private fun Config_maskFirst(body: String): String {
        val inner = Regex("\"tokensMasked\":\\[([^\\]]*)\\]").find(body)?.groupValues?.get(1) ?: ""
        return Regex("\"([^\"]*)\"").find(inner)?.groupValues?.get(1) ?: ""
    }

    @Test
    fun config_post_does_not_set_password() {
        val (server, base, _) = bootServer()
        try {
            setupPassword(base) // password = 1234
            // A config POST that tries to smuggle a "pin" must NOT change the password.
            val saved = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop\",\"iban\":\"CZ6508000000192000145399\",\"logoUrl\":\"\",\"pin\":\"9999\"}",
                pin = true,
            )
            assertEquals(200, saved.code)
            // The original password still works; the smuggled one does not.
            assertEquals(200, req(base, "GET", "/api/auth", pinValue = "1234").code)
            assertEquals(401, req(base, "GET", "/api/auth", pinValue = "9999").code)
        } finally {
            server.stop()
        }
    }

    @Test
    fun factory_reset_clears_config_to_first_run() {
        val (server, base, _) = bootServer()
        try {
            setupPassword(base)
            // Configure with tokens (fio mode).
            val saved = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop\",\"iban\":\"CZ6508000000192000145399\",\"tokens\":[\"fio-x\"],\"logoUrl\":\"\"}",
                pin = true,
            )
            assertEquals(200, saved.code)
            assertTrue(saved.body.contains("\"configured\":true"))

            // Reset is PIN-protected.
            assertEquals(401, req(base, "POST", "/api/config/reset", "{}").code)
            assertEquals(200, req(base, "POST", "/api/config/reset", "{}", pin = true).code)

            // Config is gone -> first run: no password, endpoints locked again.
            assertTrue(req(base, "GET", "/api/password/status").body.contains("\"passwordSet\":false"))
            assertEquals(401, req(base, "GET", "/api/config", pin = true).code)
        } finally {
            server.stop()
        }
    }

    @Test
    fun today_excludes_simulated_payments() {
        val (server, base, _) = bootServer()
        try {
            // No tokens -> simulation; create a session and let the sim auto-confirm it.
            configure(base)
            val created = req(base, "POST", "/api/sessions", "{\"amount\":\"50.00\"}", pin = true)
            assertEquals(201, created.code)
            server.matching.forceCheck() // sim emits a "sim-..." transaction and pays the session

            // The session is PAID, but the simulated transaction must NOT appear in today's list.
            val today = req(base, "GET", "/api/transactions/today", pin = true)
            assertEquals(200, today.code)
            assertEquals("[]", today.body.trim())
        } finally {
            server.stop()
        }
    }
}
