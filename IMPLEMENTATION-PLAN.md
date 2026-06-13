# Implementační plán — MVP (se simulací banky)

> Stav: návrh (autonomně předpřipraveno) · Datum: 2026-06-13
> Navazuje na `MVP-spec.md` a `ACCEPTANCE.md`. Cíl: podklad, ze kterého může vývojář začít stavět.

## Aplikované defaulty pro otevřené otázky

Tyto čtyři body čekají na potvrzení uživatele; do plánu jsem dosadil doporučené hodnoty, lze je přepsat:

1. **Podplatek** → `UNDERPAID`, neoznačí se jako úspěch, obsluha může zrušit (doplatek mimo MVP).
2. **Přeplatek** → `PAID` + upozornění na přeplatek.
3. **Ověření obsluhy** → jednoduchý **PIN / párovací kód** pro přístup na zadávací stránku.
4. **Timeout relace** → default **5 min**, konfigurovatelný.

## 1. Technologický základ

- **Android app (Kotlin)** + vestavěný **Ktor** server jako **foreground service**.
- **UI ve webu (React/HTML)** servírované Ktorem — totéž UI pro displej (WebView) i pro obsluhu (LAN).
- **SQLite** lokálně (Room/SQLDelight).
- QR generování server-side (knihovna pro SPAYD/QR), výstup PNG.

## 2. Abstrakce banky — `BankGateway`

Srdce zaměnitelnosti Simulátor ↔ Fio. App logika (poller + párování) zná jen toto rozhraní.

```kotlin
data class BankTransaction(
    val externalId: String,   // ID transakce u banky (idempotence)
    val amount: BigDecimal,
    val currency: String,     // "CZK"
    val vs: String?,          // variabilní symbol
    val receivedAt: Instant,
)

interface BankGateway {
    /** Vrátí nové příchozí transakce od posledního checkpointu. */
    suspend fun fetchNewTransactions(): List<BankTransaction>
    /** Dostupnost spojení (pro stav UNKNOWN/„nelze ověřit"). */
    suspend fun isAvailable(): Boolean
}
```

- **SimulatorGateway** — fronta transakcí plněná z ovládacího panelu / test API; umí scénáře z AC-9 (přesná, pod/přeplatek, žádná, pozdní, duplicita, výpadek) a volitelně simuluje 30s latenci.
- **FioGateway** — volá `/last/{token}/transactions.json`, drží server-side zarážku, respektuje **1 dotaz / 30 s**; mapuje Fio JSON na `BankTransaction`.

Poller a párovací logika jsou **sdílené** a na implementaci gateway nezávislé (AC-0.2).

## 3. Stavový automat relace

```
            ┌──────────► PAID         (přesná / přeplatek)
            │
PENDING ────┼──────────► UNDERPAID    (méně než částka)
            │
            ├──────────► EXPIRED       (timeout)
            │
            ├──────────► CANCELLED      (obsluha zruší)
            │
            └──────────► UNKNOWN ──► (po obnově) zpět k PENDING/PAID
```

Pravidlo nade vším (AC-6.8): při výpadku/nejistotě **nikdy** nepřejít do `PAID`.

## 4. Párovací algoritmus

Pro každou `fetchNewTransactions()` dávku:
1. Pro každou transakci najdi otevřené (`PENDING`) relace se shodným **VS** a měnou CZK.
2. Shoda + `amount == required` → `PAID`; `amount > required` → `OVERPAID→PAID` + flag; `amount < required` → `UNDERPAID` (relace zůstává otevřená do expirace/zrušení).
3. Žádná otevřená relace pro VS → ulož jako **nespárovanou** transakci.
4. Druhá+ transakce na již spárovanou relaci/VS → **duplicita/nespárováno**.
5. Idempotence podle `externalId` — tatáž transakce se nezpracuje dvakrát (důležité po restartu).

## 5. API (Ktor)

| Metoda | Cesta | Účel |
|---|---|---|
| `POST` | `/api/sessions` | Vytvoř platbu `{amount, note}` → `{id, vs, spayd, qrUrl, expiresAt}` |
| `GET` | `/api/sessions/{id}` | Aktuální stav relace |
| `GET` | `/api/sessions/{id}/events` | **SSE** stream změn stavu |
| `POST` | `/api/sessions/{id}/cancel` | Zruš relaci |
| `GET` | `/api/sessions` | Historie (filtry stav/datum) |
| `GET` | `/api/sessions/export.csv` | Export dat |
| `GET` | `/api/qr/{id}.png` | QR obrázek (SPAYD) |
| `GET/POST` | `/api/config` | Nastavení (name, IBAN, token*, licence) — token maskovaný při čtení |
| `GET` | `/` , `/display` | Servírované UI (obsluha / displej) |
| `POST` | `/api/sim/*` | **Jen Simulátor:** vyvolání scénářů z AC-9 |

Ověření obsluhy: PIN v cookie/headeru, vyžadováno na `/` a `/api/sessions*` (ne na `/display`, ten běží lokálně na tabletu).

## 6. Obrazovky (UI)

1. **První nastavení** — název, IBAN (validace), token, licenční klíč. (AC-1)
2. **Zadání obsluhy** — pole částka + poznámka, tlačítko „Vystavit platbu", živý stav aktivní relace, zrušení. (AC-3, AC-7)
3. **Displej** — klidový stav s přístupovým QR/odkazem na tablet; aktivní: QR + částka + stav + „použijte okamžitou platbu"; výsledek: zaplaceno/expirováno. (AC-2.2, AC-4)
4. **Historie** — seznam relací + export. (AC-8)

## 7. Pořadí stavby (milníky) a mapování na AC

| Milník | Obsah | Pokrývá AC |
|---|---|---|
| **M1** | Kostra app + Ktor server + foreground service + první nastavení + servírování UI po LAN + přístup z PC/mobilu | AC-1, AC-2 |
| **M2** | Vytvoření relace + VS + SPAYD + QR + displej | AC-3, AC-4 |
| **M3** | `BankGateway` + SimulatorGateway + poller + párování (happy path) + SSE | AC-0, AC-5, AC-7 |
| **M4** | Edge cases — pod/přeplatek, timeout, pozdní, zrušení, duplicita, nespárované, výpadek | AC-6 |
| **M5** | Historie + export + licencování + bezpečnostní dotažení + obnova po restartu | AC-8, AC-10, AC-11 |
| **M6** | FioGateway + přepnutí simulátor→Fio + ověření 30s chování | AC-0.2, AC-11.1 |

**Definition of Done MVP:** M1–M5 procházejí proti Simulátoru; M6 přepne na Fio bez změny párovací logiky a UI.

## 8. Otevřené technické detaily k dořešení během stavby

- Generování VS: max 10 číslic, strategie unikátnosti proti otevřeným relacím a nedávným transakcím.
- mDNS vs. DHCP rezervace vs. QR-odkaz na displeji pro nalezení tabletu (AC-2.2) — doporučeno nabídnout QR-odkaz jako primární.
- Šifrování tokenu (Android Keystore).
- Kiosk/foreground: wake-lock, autostart po rebootu (AC-11.2/11.3).
