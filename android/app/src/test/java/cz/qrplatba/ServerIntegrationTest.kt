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
 * end to end (PIN guard, public endpoints, session lifecycle, simulator, matching).
 * This covers the HTTP/SSE-routing layer that the pure-domain unit tests don't —
 * the only piece left for on-device testing is the Android WebView shell itself.
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

    @Test
    fun full_payment_flow_over_http() {
        val port = ServerSocket(0).use { it.localPort }
        val base = "http://127.0.0.1:$port"
        val repo = JsonSessionRepository(null)
        val server = AppServer(AppConfig(port = port, host = "127.0.0.1", pin = "1234"), repo, ModeGateway(repo)) { null }
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

            // PIN guard: operator endpoint without a PIN is rejected.
            assertEquals(401, req(base, "GET", "/api/config").code)

            // Auth check endpoint: rejects without PIN, accepts the (default) PIN.
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

            // Configure the merchant WITHOUT a token -> simulation/auto-confirm mode.
            val cfg = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop\",\"iban\":\"CZ6508000000192000145399\",\"logoUrl\":\"\"}",
                pin = true,
            )
            assertEquals(200, cfg.code)
            assertTrue("config should report simulation mode: ${cfg.body}", cfg.body.contains("\"mode\":\"simulace\""))

            // Create a payment session.
            val created = req(base, "POST", "/api/sessions", "{\"amount\":\"123.00\"}", pin = true)
            assertEquals(201, created.code)
            val id = field(created.body, "id") ?: error("no id in $created")
            assertTrue(created.body.contains("\"status\":\"PENDING\""))

            // The display can read the active session without a PIN.
            val active = req(base, "GET", "/api/sessions/active")
            assertEquals(200, active.code)
            assertEquals(id, field(active.body, "id"))

            // In simulation mode one poll cycle auto-confirms the open session.
            server.matching.tick()

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
        pin: String = "1234",
        repo: JsonSessionRepository = JsonSessionRepository(null),
    ): Triple<AppServer, String, Int> {
        val port = ServerSocket(0).use { it.localPort }
        val base = "http://127.0.0.1:$port"
        val server = AppServer(AppConfig(port = port, host = "127.0.0.1", pin = pin), repo, ModeGateway(repo)) { null }
        server.start()
        var up = false
        for (i in 0 until 50) {
            try { req(base, "GET", "/api/display-config"); up = true; break } catch (e: Exception) { Thread.sleep(100) }
        }
        assertTrue("server did not start", up)
        return Triple(server, base, port)
    }

    /** Configure WITHOUT a token -> simulation mode (auto-confirm), no license required. */
    private fun configure(base: String) {
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
    fun pin_reset_from_loopback_restores_default() {
        // The test HTTP client connects from 127.0.0.1, so this exercises the loopback (allowed) path.
        // The 403 remote/LAN path cannot be simulated here without a non-loopback client.
        val (server, base, _) = bootServer()
        try {
            // Set a custom PIN; the default (1234) stops working.
            val saved = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop\",\"iban\":\"CZ6508000000192000145399\",\"token\":\"sim\",\"licenseKey\":\"L\",\"logoUrl\":\"\",\"pin\":\"9999\"}",
                pinValue = "1234",
            )
            assertEquals(200, saved.code)
            assertEquals(200, req(base, "GET", "/api/auth", pinValue = "9999").code)
            assertEquals(401, req(base, "GET", "/api/auth", pinValue = "1234").code)

            // Reset requires NO PIN but only from loopback (this client is loopback).
            val reset = req(base, "POST", "/api/pin/reset", "{}")
            assertEquals(200, reset.code)
            assertTrue("expected ok:true, got: ${reset.body}", reset.body.contains("\"ok\":true"))

            // The default PIN authenticates again; the old custom PIN no longer does.
            assertEquals(200, req(base, "GET", "/api/auth", pinValue = "1234").code)
            assertEquals(401, req(base, "GET", "/api/auth", pinValue = "9999").code)
        } finally {
            server.stop()
        }
    }

    @Test
    fun custom_pin_replaces_default() {
        val port = ServerSocket(0).use { it.localPort }
        val base = "http://127.0.0.1:$port"
        val repo = JsonSessionRepository(null)
        val server = AppServer(AppConfig(port = port, host = "127.0.0.1", pin = "1234"), repo, ModeGateway(repo)) { null }
        server.start()
        try {
            var up = false
            for (i in 0 until 50) {
                try { req(base, "GET", "/api/display-config"); up = true; break } catch (e: Exception) { Thread.sleep(100) }
            }
            assertTrue("server did not start", up)

            // First-run: the default PIN (1234) is accepted; save a config (no token) with a custom PIN.
            val saved = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop\",\"iban\":\"CZ6508000000192000145399\",\"logoUrl\":\"\",\"pin\":\"4321\"}",
                pinValue = "1234",
            )
            assertEquals(200, saved.code)
            assertTrue("hasPin should be true: ${saved.body}", saved.body.contains("\"hasPin\":true"))

            // The custom PIN now authenticates; the old default no longer does.
            assertEquals(200, req(base, "GET", "/api/auth", pinValue = "4321").code)
            assertEquals(401, req(base, "GET", "/api/auth", pinValue = "1234").code)

            // Creating a session requires the new PIN.
            assertEquals(401, req(base, "POST", "/api/sessions", "{\"amount\":\"10.00\"}", pinValue = "1234").code)
            assertEquals(201, req(base, "POST", "/api/sessions", "{\"amount\":\"10.00\"}", pinValue = "4321").code)
        } finally {
            server.stop()
        }
    }

    @Test
    fun token_selects_mode_and_mask_keeps_token() {
        val (server, base, _) = bootServer()
        try {
            // A real token -> Fio mode.
            val r1 = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop\",\"iban\":\"CZ6508000000192000145399\",\"token\":\"fio-secret-1234\",\"logoUrl\":\"\",\"pin\":\"\"}",
                pin = true,
            )
            assertEquals(200, r1.code)
            assertTrue("expected fio mode: ${r1.body}", r1.body.contains("\"mode\":\"fio\""))

            // Re-saving with the MASKED token (contains '*') must KEEP the real token -> still Fio.
            val mask = field(r1.body, "tokenMasked") ?: error("no tokenMasked in ${r1.body}")
            val r2 = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop2\",\"iban\":\"CZ6508000000192000145399\",\"token\":\"$mask\",\"logoUrl\":\"\",\"pin\":\"\"}",
                pin = true,
            )
            assertEquals(200, r2.code)
            assertTrue("mask must keep token (still fio): ${r2.body}", r2.body.contains("\"mode\":\"fio\""))

            // An explicit empty token clears it -> simulation mode.
            val r3 = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop2\",\"iban\":\"CZ6508000000192000145399\",\"token\":\"\",\"logoUrl\":\"\",\"pin\":\"\"}",
                pin = true,
            )
            assertEquals(200, r3.code)
            assertTrue("empty token -> simulace: ${r3.body}", r3.body.contains("\"mode\":\"simulace\""))
        } finally {
            server.stop()
        }
    }

    @Test
    fun factory_reset_clears_config() {
        val (server, base, _) = bootServer()
        try {
            // Configure with a token (fio mode).
            val saved = req(
                base, "POST", "/api/config",
                "{\"name\":\"Shop\",\"iban\":\"CZ6508000000192000145399\",\"token\":\"fio-x\",\"logoUrl\":\"\",\"pin\":\"\"}",
                pin = true,
            )
            assertEquals(200, saved.code)
            assertTrue(saved.body.contains("\"configured\":true"))

            // Reset is PIN-protected.
            assertEquals(401, req(base, "POST", "/api/config/reset", "{}").code)
            assertEquals(200, req(base, "POST", "/api/config/reset", "{}", pin = true).code)

            // Config is gone -> not configured, simulation mode, default PIN works again.
            val cfg = req(base, "GET", "/api/config", pin = true)
            assertEquals(200, cfg.code)
            assertTrue("expected not configured: ${cfg.body}", cfg.body.contains("\"configured\":false"))
            assertTrue("expected simulace: ${cfg.body}", cfg.body.contains("\"mode\":\"simulace\""))
        } finally {
            server.stop()
        }
    }

    @Test
    fun today_excludes_simulated_payments() {
        val (server, base, _) = bootServer()
        try {
            // No token -> simulation; create a session and let the sim auto-confirm it.
            configure(base)
            val created = req(base, "POST", "/api/sessions", "{\"amount\":\"50.00\"}", pin = true)
            assertEquals(201, created.code)
            server.matching.tick() // sim emits a "sim-..." transaction and pays the session

            // The session is PAID, but the simulated transaction must NOT appear in today's list.
            val today = req(base, "GET", "/api/transactions/today", pin = true)
            assertEquals(200, today.code)
            assertEquals("[]", today.body.trim())
        } finally {
            server.stop()
        }
    }
}
