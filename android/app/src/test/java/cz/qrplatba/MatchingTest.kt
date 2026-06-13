package cz.qrplatba

import cz.qrplatba.domain.SessionStatus
import cz.qrplatba.domain.money
import cz.qrplatba.gateway.ScenarioType
import cz.qrplatba.gateway.SimulatorGateway
import cz.qrplatba.persistence.JsonSessionRepository
import cz.qrplatba.service.EventBus
import cz.qrplatba.service.MatchingService
import cz.qrplatba.service.SessionService
import org.junit.Assert.assertEquals
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
            sessions.setConfig("Test Shop", VALID_IBAN, "secret-token-abcdef", "LIC-12345", null, null)
        }
    }

    @Test fun pendingExactToPaid() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("450.00")
        assertEquals(SessionStatus.PENDING, s.status)
        val tx = h.gateway.scenario(ScenarioType.exact, s.vs, s.amount)[0]
        h.matching.tick()
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
        h.matching.tick()
        val firstTxId = h.sessions.getSession(s.id).matchedTxId
        h.gateway.enqueue(s.amount, s.vs)
        h.matching.tick()
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
        h.matching.tick()
        val after = h.sessions.getSession(s.id)
        assertEquals(SessionStatus.UNDERPAID, after.status)
        assertNull(after.paidAt)
        assertNull(after.matchedTxId)
    }

    @Test fun overpaymentPaidWithFlag() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("450.00")
        h.gateway.scenario(ScenarioType.over, s.vs, s.amount)
        h.matching.tick()
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
        h.matching.tick()
        assertEquals(SessionStatus.EXPIRED, h.sessions.getSession(s.id).status)
    }

    @Test fun latePaymentUnmatched() {
        val h = Harness(ttlMs = 10); h.configure()
        val s = h.sessions.createSession("50.00")
        Thread.sleep(30)
        h.matching.tick()
        assertEquals(SessionStatus.EXPIRED, h.sessions.getSession(s.id).status)
        h.gateway.scenario(ScenarioType.late, s.vs, s.amount)
        h.matching.tick()
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
        h.matching.tick()
        assertEquals(SessionStatus.CANCELLED, h.sessions.getSession(s.id).status)
    }

    @Test fun duplicateVs() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("200.00")
        h.gateway.scenario(ScenarioType.duplicate, s.vs, s.amount)
        h.matching.tick()
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
        h.matching.tick()
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
        h.matching.tick()
        var after = h.sessions.getSession(s.id)
        assertEquals(SessionStatus.UNKNOWN, after.status)
        assertNull(after.matchedTxId)
        h.gateway.setAvailable(true)
        h.matching.tick()
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
        h.matching.tick()
        assertEquals(SessionStatus.PAID, h.sessions.getSession(s.id).status)
        h.gateway.enqueue(s.amount, s.vs, externalId = "fixed-1")
        h.matching.tick()
        assertEquals(1, h.repo.listTransactions().size)
    }

    @Test fun decimalEqualityMatch() {
        val h = Harness(); h.configure()
        val s = h.sessions.createSession("0.30")
        h.gateway.enqueue(money("0.1").add(money("0.2")), s.vs)
        h.matching.tick()
        assertEquals(SessionStatus.PAID, h.sessions.getSession(s.id).status)
    }
}
