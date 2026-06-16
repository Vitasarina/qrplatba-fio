package cz.qrplatba

import cz.qrplatba.domain.SessionStatus
import cz.qrplatba.domain.formatAmount2dp
import cz.qrplatba.gateway.FioGateway
import cz.qrplatba.gateway.ModeGateway
import cz.qrplatba.persistence.JsonSessionRepository
import cz.qrplatba.service.EventBus
import cz.qrplatba.service.MatchingService
import cz.qrplatba.service.SessionService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private const val VALID_IBAN = "CZ6508000000192000145399"

class GatewayTest {

    // ---- Fio JSON parsing (pure function, no network) ----

    private val sampleFio = """
        {
          "accountStatement": {
            "info": { "accountId": "2000145399", "bankId": "0800", "currency": "CZK" },
            "transactionList": {
              "transaction": [
                {
                  "column0": { "value": "2026-06-13+0200", "name": "Datum", "id": 0 },
                  "column1": { "value": 450.00, "name": "Objem", "id": 1 },
                  "column5": { "value": "1234567890", "name": "VS", "id": 5 },
                  "column14": { "value": "CZK", "name": "Měna", "id": 14 },
                  "column22": { "value": 26000000001, "name": "ID pohybu", "id": 22 }
                },
                {
                  "column0": { "value": "2026-06-13+0200", "name": "Datum", "id": 0 },
                  "column1": { "value": -99.00, "name": "Objem", "id": 1 },
                  "column5": { "value": "9999", "name": "VS", "id": 5 },
                  "column14": { "value": "CZK", "name": "Měna", "id": 14 },
                  "column22": { "value": 26000000002, "name": "ID pohybu", "id": 22 }
                }
              ]
            }
          }
        }
    """.trimIndent()

    @Test fun fioParsesIncomingOnly() {
        val txs = FioGateway.parseFioTransactions(sampleFio)
        // Only the positive (incoming) movement is kept; the outgoing -99 is dropped.
        assertEquals(1, txs.size)
        val t = txs[0]
        assertEquals("26000000001", t.externalId)
        assertEquals("450.00", formatAmount2dp(t.amount))
        assertEquals("1234567890", t.vs)
        assertEquals("CZK", t.currency)
    }

    @Test fun fioEmptyStatementYieldsNoTransactions() {
        val empty = """{"accountStatement":{"transactionList":{"transaction":[]}}}"""
        assertEquals(0, FioGateway.parseFioTransactions(empty).size)
        val nullList = """{"accountStatement":{"transactionList":null}}"""
        assertEquals(0, FioGateway.parseFioTransactions(nullList).size)
    }

    @Test(expected = Exception::class) fun fioRejectsGarbage() {
        FioGateway.parseFioTransactions("not json")
    }

    // ---- FioGateway round-robin token rotation (no network) ----

    @Test fun fioRotatesTokensRoundRobin() {
        val fio = FioGateway(listOf("t1", "t2", "t3"))
        // nextToken() advances the rotation index deterministically.
        assertEquals("t1", fio.nextToken())
        assertEquals("t2", fio.nextToken())
        assertEquals("t3", fio.nextToken())
        assertEquals("t1", fio.nextToken()) // wraps
    }

    @Test fun fioSingleTokenAlwaysSame() {
        val fio = FioGateway("only")
        assertEquals("only", fio.nextToken())
        assertEquals("only", fio.nextToken())
    }

    @Test fun fioTrimsAndDropsBlankTokens() {
        val fio = FioGateway(listOf("  a ", "", "   ", "b"))
        assertEquals("a", fio.nextToken())
        assertEquals("b", fio.nextToken())
        assertEquals("a", fio.nextToken())
    }

    // ---- ModeGateway simulation: auto-confirm open sessions -> PAID ----

    private class SimHarness {
        val repo = JsonSessionRepository(null)
        val events = EventBus()
        val gateway = ModeGateway(repo)
        val sessions = SessionService(repo, events, 5 * 60 * 1000)
        val matching = MatchingService(repo, gateway, events)
        // No tokens -> simulation mode.
        fun configureSim() = sessions.setConfig("Shop", VALID_IBAN, emptyList(), "", null)
    }

    @Test fun simModeAutoConfirmsOpenSessionToPaid() {
        val h = SimHarness(); h.configureSim()
        val s = h.sessions.createSession("123.00")
        assertEquals(SessionStatus.PENDING, s.status)
        // gateway available in sim mode regardless of network
        assertTrue(h.gateway.isAvailable())
        // forceCheck (manual /check) polls immediately, auto-confirming the open session.
        h.matching.forceCheck()
        assertEquals(SessionStatus.PAID, h.sessions.getSession(s.id).status)
    }

    @Test fun simAutoConfirmIsIdempotent() {
        val h = SimHarness(); h.configureSim()
        val s = h.sessions.createSession("50.00")
        h.matching.forceCheck()
        assertEquals(SessionStatus.PAID, h.sessions.getSession(s.id).status)
        // A second poll must not record a duplicate or change the paid session.
        h.matching.forceCheck()
        assertEquals(1, h.repo.listTransactions().size)
        assertEquals(SessionStatus.PAID, h.sessions.getSession(s.id).status)
    }

    @Test fun fioModeDelegatesToFactory() {
        val repo = JsonSessionRepository(null)
        val events = EventBus()
        // Inject a fake fio gateway via the factory so no network is hit.
        var fetched = 0
        var receivedTokens: List<String> = emptyList()
        val gateway = ModeGateway(repo, fioFactory = { toks ->
            receivedTokens = toks
            object : cz.qrplatba.gateway.BankGateway {
                override fun fetchNewTransactions(): List<cz.qrplatba.gateway.BankTransaction> {
                    fetched++
                    return emptyList()
                }
                override fun isAvailable() = true
            }
        })
        val sessions = SessionService(repo, events, 5 * 60 * 1000)
        val matching = MatchingService(repo, gateway, events)
        // Tokens present -> Fio mode.
        sessions.setConfig("Shop", VALID_IBAN, listOf("real-token", "second-token"), "", null)
        val s = sessions.createSession("10.00")
        matching.forceCheck()
        // Fio factory was used (with the full token list); session is NOT auto-confirmed.
        assertTrue("fio gateway should have been polled", fetched > 0)
        assertEquals(listOf("real-token", "second-token"), receivedTokens)
        assertEquals(SessionStatus.PENDING, sessions.getSession(s.id).status)
    }
}
