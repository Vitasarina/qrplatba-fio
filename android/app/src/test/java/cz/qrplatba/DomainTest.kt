package cz.qrplatba

import cz.qrplatba.domain.AmountError
import cz.qrplatba.domain.Config
import cz.qrplatba.domain.ConfigError
import cz.qrplatba.domain.Iban
import cz.qrplatba.domain.Spayd
import cz.qrplatba.domain.formatAmount2dp
import cz.qrplatba.domain.money
import cz.qrplatba.domain.parseAmount
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

private const val VALID_IBAN = "CZ6508000000192000145399"

class DomainTest {
    // ---- IBAN (AC-1.2) ----
    @Test fun acceptsValidCzechIban() = assertTrue(Iban.isValid(VALID_IBAN))

    @Test fun acceptsIbanWithSpaces() {
        assertTrue(Iban.isValid("CZ65 0800 0000 1920 0014 5399"))
        assertEquals(VALID_IBAN, Iban.normalize("CZ65 0800 0000 1920 0014 5399"))
    }

    @Test fun rejectsWrongChecksum() = assertFalse(Iban.isValid("CZ6608000000192000145399"))
    @Test fun rejectsWrongLength() = assertFalse(Iban.isValid("CZ650800000019200014539"))
    @Test fun rejectsGarbage() {
        assertFalse(Iban.isValid("not-an-iban"))
        assertFalse(Iban.isValid(""))
    }

    // ---- Czech account number -> IBAN ----
    @Test fun accountNumberWithPrefixToIban() {
        // 19-2000145399/0800 is the canonical decomposition of the known valid IBAN.
        assertEquals(VALID_IBAN, Iban.fromCzechAccount("19", "2000145399", "0800"))
        assertEquals(VALID_IBAN, Iban.czechAccountToIban("19-2000145399/0800"))
    }

    @Test fun accountNumberWithoutPrefixToIban() {
        // No prefix -> prefix treated as 0; result is a structurally valid IBAN.
        val iban = Iban.fromCzechAccount(null, "2400123456", "2010")
        assertTrue("derived IBAN must pass checksum: $iban", Iban.isValid(iban))
        assertEquals(iban, Iban.czechAccountToIban("2400123456/2010"))
    }

    @Test fun configAcceptsCzechAccountNumber() {
        val c = Config.validate("Shop", "19-2000145399/0800", emptyList(), null, null, null)
        assertEquals(VALID_IBAN, c.iban)
    }

    @Test(expected = ConfigError::class) fun rejectsInvalidAccountNumber() {
        Config.validate("Shop", "not-an-account", emptyList(), null, null, null)
    }

    // ---- mode derived from tokens ----
    @Test fun modeSimulationWhenNoTokens() {
        val c = Config.validate("Shop", VALID_IBAN, emptyList(), null, null, null)
        assertEquals("simulace", Config.toDTO(c).mode)
    }

    @Test fun modeFioWhenTokensPresent() {
        val c = Config.validate("Shop", VALID_IBAN, listOf("tok"), null, null, null)
        assertEquals("fio", Config.toDTO(c).mode)
    }

    @Test fun configuredWithoutTokensOrLicense() {
        // Name + valid account is enough; tokens and license are optional now.
        val c = Config.validate("Shop", VALID_IBAN, emptyList(), "", null, null)
        assertTrue(Config.isConfigured(c))
    }

    // ---- multiple tokens ----
    @Test fun tokensTrimmedAndBlankDropped() {
        val c = Config.validate("Shop", VALID_IBAN, listOf("  a  ", "", "   ", "b"), null, null, null)
        assertEquals(listOf("a", "b"), c.tokens)
        assertEquals(2, Config.toDTO(c).tokenCount)
        assertEquals("fio", Config.toDTO(c).mode)
    }

    @Test fun tokensCappedAt32() {
        val many = (1..40).map { "tok$it" }
        val c = Config.validate("Shop", VALID_IBAN, many, null, null, null)
        assertEquals(32, c.tokens.size)
        assertEquals(32, Config.toDTO(c).tokenCount)
    }

    @Test fun tokensMaskedInDto() {
        val c = Config.validate("Shop", VALID_IBAN, listOf("secret-token-abcdef", "abcd"), null, null, null)
        val dto = Config.toDTO(c)
        assertEquals(listOf("***************cdef", "****"), dto.tokensMasked)
    }

    @Test fun legacySingleTokenMigratesToList() {
        // Old persisted shape: a single `token` string, no `tokens` array.
        val legacy = cz.qrplatba.domain.MerchantConfig(
            name = "Shop", iban = VALID_IBAN, tokens = emptyList(), legacyToken = "old-tok",
        )
        assertEquals(listOf("old-tok"), legacy.normalizedTokens())
        assertEquals("fio", Config.modeOf(legacy))
        assertEquals(1, Config.toDTO(legacy).tokenCount)
    }

    @Test fun passwordSetReflectsPin() {
        val noPw = Config.validate("Shop", VALID_IBAN, emptyList(), null, null, null)
        assertFalse(Config.toDTO(noPw).passwordSet)
        val withPw = Config.validate("Shop", VALID_IBAN, emptyList(), null, null, "4321")
        assertTrue(Config.toDTO(withPw).passwordSet)
        assertTrue(Config.toDTO(withPw).hasPin)
    }

    // ---- SPAYD (AC-3.4) ----
    @Test fun spaydExactFormat() {
        val spayd = Spayd.build(VALID_IBAN, money("450"), "1234567890", "Nazev obchodu")
        assertEquals(
            "SPD*1.0*ACC:CZ6508000000192000145399*AM:450.00*CC:CZK*X-VS:1234567890*MSG:Nazev obchodu",
            spayd,
        )
    }

    @Test fun spaydFormatsTwoDecimals() {
        assertTrue(Spayd.build(VALID_IBAN, money("9.5"), "1", "x").contains("AM:9.50"))
    }

    @Test fun spaydStripsSeparators() {
        val spayd = Spayd.build(VALID_IBAN, money("1"), "1", "a*b*c")
        assertTrue(spayd.contains("MSG:a b c"))
        assertEquals(7, spayd.split("*").size)
    }

    // ---- SPAYD message = note + company name (hyphen-joined, note first, lowercased) ----
    @Test fun spaydMessageCombinesNoteAndName() {
        assertEquals(
            "musli-boldgym",
            cz.qrplatba.service.SessionService.buildSpaydMessage("Boldgym", "musli"),
        )
    }

    @Test fun spaydMessageNameOnlyWhenNoNote() {
        assertEquals("boldgym", cz.qrplatba.service.SessionService.buildSpaydMessage("Boldgym", null))
        assertEquals("boldgym", cz.qrplatba.service.SessionService.buildSpaydMessage("Boldgym", "   "))
    }

    // ---- money ----
    @Test fun noFloatDrift() = assertEquals("0.30", money("0.1").add(money("0.2")).let { formatAmount2dp(it) })

    @Test fun comparesExactly() {
        assertEquals(0, money("450.00").compareTo(money("450")))
        assertTrue(money("450.01") > money("450.00"))
        assertTrue(money("449.99") < money("450.00"))
    }

    @Test fun formats2dp() {
        assertEquals("1.00", formatAmount2dp(money("1")))
        assertEquals("1234.50", formatAmount2dp(money("1234.5")))
    }

    // ---- amount parsing (AC-3.1, AC-3.2) ----
    @Test fun acceptsPositive2dp() {
        assertEquals("450.00", formatAmount2dp(parseAmount("450.00")))
        assertEquals("12.50", formatAmount2dp(parseAmount("12.5")))
    }

    @Test(expected = AmountError::class) fun rejectsZero() { parseAmount("0") }
    @Test(expected = AmountError::class) fun rejectsNegative() { parseAmount("-5") }
    @Test(expected = AmountError::class) fun rejectsThreeDecimals() { parseAmount("1.234") }
    @Test(expected = AmountError::class) fun rejectsNonNumeric() { parseAmount("abc") }
    @Test(expected = AmountError::class) fun rejectsNull() { parseAmount(null) }

    // ---- token masking (AC-1.3) ----
    @Test fun masksAllButLast4() = assertEquals("***************cdef", Config.maskToken("secret-token-abcdef"))
    @Test fun masksShortFully() = assertEquals("****", Config.maskToken("abcd"))

    // ---- config validation ----
    @Test(expected = ConfigError::class) fun rejectsInvalidIban() { Config.validate("x", "bad", listOf("t"), "l", null, null) }
    @Test(expected = ConfigError::class) fun rejectsEmptyName() { Config.validate("  ", VALID_IBAN, listOf("t"), "l", null, null) }

    @Test fun normalizesValidConfig() {
        val c = Config.validate(" Shop ", "CZ65 0800 0000 1920 0014 5399", listOf("t"), "l", null, null)
        assertEquals("Shop", c.name)
        assertEquals(VALID_IBAN, c.iban)
    }

    // ---- operating (workflow) mode ----
    @Test fun opModeNormalizes() {
        assertEquals("kasa", cz.qrplatba.domain.OpMode.normalize("kasa"))
        assertEquals("paper", cz.qrplatba.domain.OpMode.normalize("PAPER"))
        assertEquals("", cz.qrplatba.domain.OpMode.normalize("nonsense"))
        assertEquals("", cz.qrplatba.domain.OpMode.normalize(null))
    }

    @Test fun validateCarriesOpMode() {
        val c = Config.validate("Shop", VALID_IBAN, emptyList(), null, null, null, null, "paper")
        assertEquals("paper", c.opMode)
        assertEquals("paper", Config.toDTO(c).opMode)
        assertEquals("paper", Config.toDisplayDTO(c).opMode)
    }

    @Test fun validateDefaultsOpModeToNone() {
        val c = Config.validate("Shop", VALID_IBAN, emptyList(), null, null, null)
        assertEquals("", c.opMode)
    }

    // ---- password hashing ----
    @Test fun passwordHashRoundTrips() {
        val stored = cz.qrplatba.domain.PasswordHash.hash("s3cret")
        assertTrue(cz.qrplatba.domain.PasswordHash.isHashed(stored))
        assertFalse("hash must not contain the plaintext", stored.contains("s3cret"))
        assertTrue(cz.qrplatba.domain.PasswordHash.verify("s3cret", stored))
        assertFalse(cz.qrplatba.domain.PasswordHash.verify("wrong", stored))
    }

    @Test fun passwordHashVerifiesLegacyPlaintext() {
        // Old installs stored the password in plaintext; verify must still accept it.
        assertTrue(cz.qrplatba.domain.PasswordHash.verify("1234", "1234"))
        assertFalse(cz.qrplatba.domain.PasswordHash.verify("0000", "1234"))
        assertFalse(cz.qrplatba.domain.PasswordHash.isHashed("1234"))
    }
}
