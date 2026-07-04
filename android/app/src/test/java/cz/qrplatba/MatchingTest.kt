package cz.qrplatba

import cz.qrplatba.domain.SessionStatus
import cz.qrplatba.domain.money
import cz.qrplatba.gateway.ModeGateway
import cz.qrplatba.gateway.ScenarioType
import cz.qrplatba.gateway.SimulatorGateway
import cz.qrplatba.persistence.JsonSessionRepository
import cz.qrplatba.service.EventBus
import cz.qrplatba.service.MatchingService
import cz.qrplatba.service.SessionService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val VALID_IBAN = "CZ6508000000192000145399"

/** Mirrors server/test/matching.test.ts against the Kotlin port. */
class MatchingTest {
    private class Harness(ttlMs: Long = 5 * 60 * 1000) {
        val repo = JsonSessionRepository(null) // in-memory, no file
        val gateway = SimulatorGateway()
        val events = EventBus()
        val sessions = SessionService(repo, events, ttlMs)
        val matching = MatchingService(repo, gateway, events)

        fun configure() {
            sessions.setConfig("Test Shop", VALID_IBAN, listOf("secret-token-abcdef"), "LIC-12345", null)
        }
    }

    @Test fun pendingExactToPaid() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("450.00")
        assertEquals(SessionStatus.PENDING, s.status)
        val tx = h.gateway.scenario(ScenarioType.exact, s.vs, s.amount)[0]
        h.matching.forceCheck()
        val after = h.sessions.getSession(s.id)
        assertEquals(SessionStatus.PAID, after.status)
        assertNotNull(after.paidAt)
        assertEquals(tx.externalId, after.matchedTxId)
        assertEquals(false, after.overpaid)
    }

    @Test fun secondTxDoesNotChangePaid() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("100.00")
        h.gateway.scenario(ScenarioType.exact, s.vs, s.amount)
        h.matching.forceCheck()
        val firstTxId = h.sessions.getSession(s.id).matchedTxId
        h.gateway.enqueue(s.amount, s.vs)
        h.matching.forceCheck()
        val still = h.sessions.getSession(s.id)
        assertEquals(SessionStatus.PAID, still.status)
        assertEquals(firstTxId, still.matchedTxId)
        val unmatched = h.repo.listTransactions().filter { it.matchedSessionId == null }
        assertEquals(1, unmatched.size)
        assertEquals("duplicate", unmatched[0].unmatchedReason)
    }

    @Test fun underpaymentStaysOpen() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("450.00")
        h.gateway.scenario(ScenarioType.under, s.vs, s.amount)
        h.matching.forceCheck()
        val after = h.sessions.getSession(s.id)
        assertEquals(SessionStatus.UNDERPAID, after.status)
        assertNull(after.paidAt)
        assertNull(after.matchedTxId)
    }

    @Test fun overpaymentPaidWithFlag() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("450.00")
        h.gateway.scenario(ScenarioType.over, s.vs, s.amount)
        h.matching.forceCheck()
        val after = h.sessions.getSession(s.id)
        assertEquals(SessionStatus.OVERPAID, after.status)
        assertTrue(after.overpaid)
        assertNotNull(after.paidAt)
        assertNotNull(after.matchedTxId)
    }

    @Test fun timeoutExpires() {
        val h = Harness(ttlMs = 10); h.configure()
        val s = h.sessions.createSession("50.00")
        Thread.sleep(30)
        h.matching.forceCheck()
        assertEquals(SessionStatus.EXPIRED, h.sessions.getSession(s.id).status)
    }

    @Test fun latePaymentUnmatched() {
        val h = Harness(ttlMs = 10); h.configure()
        val s = h.sessions.createSession("50.00")
        Thread.sleep(30)
        h.matching.forceCheck()
        assertEquals(SessionStatus.EXPIRED, h.sessions.getSession(s.id).status)
        h.gateway.scenario(ScenarioType.late, s.vs, s.amount)
        h.matching.forceCheck()
        assertEquals(SessionStatus.EXPIRED, h.sessions.getSession(s.id).status)
        val txs = h.repo.listTransactions()
        assertEquals(1, txs.size)
        assertNull(txs[0].matchedSessionId)
        assertEquals("duplicate", txs[0].unmatchedReason)
    }

    @Test fun manualCancel() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("50.00")
        assertEquals(SessionStatus.CANCELLED, h.sessions.cancelSession(s.id).status)
        h.gateway.enqueue(s.amount, s.vs)
        h.matching.forceCheck()
        assertEquals(SessionStatus.CANCELLED, h.sessions.getSession(s.id).status)
    }

    @Test fun duplicateVs() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("200.00")
        h.gateway.scenario(ScenarioType.duplicate, s.vs, s.amount)
        h.matching.forceCheck()
        assertEquals(SessionStatus.PAID, h.sessions.getSession(s.id).status)
        val txs = h.repo.listTransactions()
        assertEquals(2, txs.size)
        assertEquals(1, txs.count { it.matchedSessionId == s.id })
        val unmatched = txs.filter { it.matchedSessionId == null }
        assertEquals(1, unmatched.size)
        assertEquals("duplicate", unmatched[0].unmatchedReason)
    }

    @Test fun unmatchedNoSession() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("75.00")
        h.gateway.enqueue(money("75.00"), "9999999999")
        h.matching.forceCheck()
        assertEquals(SessionStatus.PENDING, h.sessions.getSession(s.id).status)
        val txs = h.repo.listTransactions()
        assertEquals(1, txs.size)
        assertNull(txs[0].matchedSessionId)
        assertEquals("no-session", txs[0].unmatchedReason)
    }

    @Test fun gatewayUnavailableNeverPaidThenRecovers() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("300.00")
        h.gateway.enqueue(s.amount, s.vs)
        h.gateway.setAvailable(false)
        h.matching.forceCheck()
        var after = h.sessions.getSession(s.id)
        assertEquals(SessionStatus.UNKNOWN, after.status)
        assertNull(after.matchedTxId)
        h.gateway.setAvailable(true)
        h.matching.forceCheck()
        after = h.sessions.getSession(s.id)
        assertEquals(SessionStatus.PAID, after.status)
    }

    @Test fun vsUniqueTenDigits() {
        val h = Harness(); h.configure()
        val seen = HashSet<String>()
        repeat(50) {
            val s = h.sessions.createSession("10.00")
            assertTrue(s.vs.matches(Regex("^[1-9][0-9]{9}$")))
            assertTrue(seen.add(s.vs))
        }
    }

    @Test fun idempotentByExternalId() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("120.00")
        h.gateway.enqueue(s.amount, s.vs, externalId = "fixed-1")
        h.matching.forceCheck()
        assertEquals(SessionStatus.PAID, h.sessions.getSession(s.id).status)
        h.gateway.enqueue(s.amount, s.vs, externalId = "fixed-1")
        h.matching.forceCheck()
        assertEquals(1, h.repo.listTransactions().size)
    }

    @Test fun decimalEqualityMatch() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("0.30")
        h.gateway.enqueue(money("0.1").add(money("0.2")), s.vs)
        h.matching.forceCheck()
        assertEquals(SessionStatus.PAID, h.sessions.getSession(s.id).status)
    }

    // ---- paper-mode watch sessions (match the next incoming payment) ----

    @Test fun watchMatchesAnyIncomingPayment() {
        val h = Harness(); h.configure()
        val w = h.sessions.createWatchSession(null) // any amount
        assertTrue(w.watch)
        assertEquals(SessionStatus.PENDING, w.status)
        h.gateway.enqueue(money("42.00"), vs = null, counterpartyName = "Jan Novák")
        h.matching.forceCheck()
        val after = h.sessions.getSession(w.id)
        assertEquals(SessionStatus.PAID, after.status)
        assertEquals("Jan Novák", after.payerName)
        assertEquals(0, after.receivedAmount!!.compareTo(money("42.00")))
    }

    @Test fun watchWithExpectedAmountIgnoresWrongThenMatchesRight() {
        val h = Harness(); h.configure()
        val w = h.sessions.createWatchSession("100.00")
        // Wrong amount: watch stays pending, tx recorded unmatched.
        h.gateway.enqueue(money("50.00"), vs = null)
        h.matching.forceCheck()
        assertEquals(SessionStatus.PENDING, h.sessions.getSession(w.id).status)
        // Right amount: watch resolves.
        h.gateway.enqueue(money("100.00"), vs = null, counterpartyName = "Petr")
        h.matching.forceCheck()
        val after = h.sessions.getSession(w.id)
        assertEquals(SessionStatus.PAID, after.status)
        assertEquals("Petr", after.payerName)
    }

    @Test fun watchTimesOutToExpired() {
        val h = Harness(); h.configure()
        val w = h.sessions.createWatchSession(null, ttlMs = 1L)
        // No payment arrives; a tick past expiry expires the watch (→ negative result/sound).
        h.matching.expireStale(w.createdAt + 10)
        assertEquals(SessionStatus.EXPIRED, h.sessions.getSession(w.id).status)
    }

    @Test fun watchIgnoresVsAndBindsPaymentWithoutVs() {
        val h = Harness(); h.configure()
        val w = h.sessions.createWatchSession(null)
        // Paper payments typically carry NO variable symbol; the watch must still bind.
        h.gateway.enqueue(money("15.00"), vs = null)
        h.matching.forceCheck()
        assertEquals(SessionStatus.PAID, h.sessions.getSession(w.id).status)
    }

    // ---- bank connectivity precheck (real token query) ----

    @Test fun probeBankReachableWhenGatewayResponds() {
        val h = Harness(); h.configure() // 1 token -> Fio path, gateway available
        assertTrue(h.matching.probeBank())
    }

    @Test fun probeBankUnreachableWhenGatewayThrows() {
        val h = Harness(); h.configure()
        h.gateway.setAvailable(false) // simulate bank unreachable
        assertFalse(h.matching.probeBank())
    }

    @Test fun probeBankTrueInSimulationWithoutQuery() {
        val h = Harness()
        // No tokens -> simulation; probe reports reachable without touching the gateway.
        h.sessions.setConfig("Shop", VALID_IBAN, emptyList(), "", null)
        h.gateway.setAvailable(false) // even if the gateway would fail, sim is "reachable"
        assertTrue(h.matching.probeBank())
    }

    @Test fun probeBankReconcilesReturnedTransactions() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("77.00")
        // A payment already sits at the bank when the precheck runs: the probe must not lose it.
        h.gateway.enqueue(s.amount, s.vs)
        assertTrue(h.matching.probeBank())
        assertEquals(SessionStatus.PAID, h.sessions.getSession(s.id).status)
    }

    // ---- polling cadence (driven by a controllable `now`) ----

    /** A gateway that just counts fetch calls; lets us assert exactly when a query happens. */
    private class CountingGateway : cz.qrplatba.gateway.BankGateway {
        var fetches = 0
        override fun fetchNewTransactions(): List<cz.qrplatba.gateway.BankTransaction> { fetches++; return emptyList() }
        override fun isAvailable() = true
    }

    /** Builds a harness whose config has [n] tokens, with a counting gateway and a fixed createdAt. */
    private class CadenceHarness(n: Int) {
        val repo = JsonSessionRepository(null)
        val events = EventBus()
        val gateway = CountingGateway()
        val sessions = SessionService(repo, events, 60L * 60 * 1000) // long TTL so it doesn't expire
        val matching = MatchingService(repo, gateway, events)
        init {
            val tokens = (1..n).map { "tok$it" }
            sessions.setConfig("Shop", VALID_IBAN, tokens, "", null)
        }
    }

    @Test fun cadenceSingleTokenFirstQueryAt30s() {
        val h = CadenceHarness(1)
        val s = h.sessions.createSession("10.00")
        val t0 = s.createdAt
        // Before +30 s: no query.
        h.matching.tick(t0)
        h.matching.tick(t0 + 29_999)
        assertEquals(0, h.gateway.fetches)
        // At +30 s: first query fires.
        h.matching.tick(t0 + 30_000)
        assertEquals(1, h.gateway.fetches)
        // Then every 30 s.
        h.matching.tick(t0 + 45_000)
        assertEquals(1, h.gateway.fetches) // not yet (last query at +30s, interval 30s)
        h.matching.tick(t0 + 60_000)
        assertEquals(2, h.gateway.fetches)
    }

    @Test fun cadenceMultiTokenFirstAt10sThenInterval() {
        val n = 3
        val h = CadenceHarness(n)
        val s = h.sessions.createSession("10.00")
        val t0 = s.createdAt
        // N>1: first query at +10 s.
        h.matching.tick(t0 + 9_999)
        assertEquals(0, h.gateway.fetches)
        h.matching.tick(t0 + 10_000)
        assertEquals(1, h.gateway.fetches)
        // Then every 30000/N ms = 10000 ms (last query at +10000 -> next due +20000).
        h.matching.tick(t0 + 19_999)
        assertEquals(1, h.gateway.fetches)
        h.matching.tick(t0 + 20_000)
        assertEquals(2, h.gateway.fetches)
        h.matching.tick(t0 + 30_000)
        assertEquals(3, h.gateway.fetches)
    }

    @Test fun cadenceIntervalForManyTokens() {
        // 30000 / N for a few N values.
        val h2 = CadenceHarness(2); assertEquals(15_000L, h2.matching.pollIntervalMs())
        val h5 = CadenceHarness(5); assertEquals(6_000L, h5.matching.pollIntervalMs())
        val h1 = CadenceHarness(1); assertEquals(30_000L, h1.matching.pollIntervalMs())
    }

    @Test fun cadenceNoQueryWithoutOpenSession() {
        val h = CadenceHarness(1)
        // No sessions at all: ticking never queries.
        h.matching.tick(System.currentTimeMillis() + 60_000)
        assertEquals(0, h.gateway.fetches)
    }

    @Test fun cadenceManualCheckCountsAsQueryForTiming() {
        val h = CadenceHarness(1)
        val s = h.sessions.createSession("10.00")
        val t0 = s.createdAt
        // Force a check well before the +30 s first-query point.
        h.matching.forceCheck(t0 + 5_000)
        assertEquals(1, h.gateway.fetches)
        // Because the manual check counted as a query (lastQueryAt = t0+5000), the next
        // scheduled query is now lastQueryAt + interval (30 s), not the +30s-from-createdAt point.
        h.matching.tick(t0 + 30_000)
        assertEquals(1, h.gateway.fetches) // 30000+5000 = 35000 not yet due
        h.matching.tick(t0 + 35_000)
        assertEquals(2, h.gateway.fetches)
    }

    @Test fun cadenceSimAutoConfirmsAfterDelayNotInstant() {
        // N == 0 (simulation): the open session is auto-confirmed ~9 s after createdAt, not instantly.
        val repo = JsonSessionRepository(null)
        val events = EventBus()
        val gateway = ModeGateway(repo)
        val sessions = SessionService(repo, events, 60L * 60 * 1000)
        val matching = MatchingService(repo, gateway, events)
        sessions.setConfig("Shop", VALID_IBAN, emptyList(), "", null)
        val s = sessions.createSession("10.00")
        val t0 = s.createdAt
        // Right away: still PENDING (QR must be visible briefly).
        matching.tick(t0)
        matching.tick(t0 + 5_000)
        assertEquals(SessionStatus.PENDING, sessions.getSession(s.id).status)
        // After ~9 s: auto-confirmed.
        matching.tick(t0 + 9_000)
        assertEquals(SessionStatus.PAID, sessions.getSession(s.id).status)
    }
}
