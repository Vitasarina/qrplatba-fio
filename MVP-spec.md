# QR Platby u kasy — MVP specifikace

> Stav: návrh v0.2 (podklad pro vývoj) · Datum: 2026-06-13
> Rozhodnutí zadavatele: banka **Fio**, monetizace **jednorázová licence**, **jedna kasa** na obchodníka.
> Architektura: **ON-PREMISE** — vše běží na tabletu v prodejně, žádná infrastruktura na straně tvůrce. Produkt = single-tenant Android aplikace prodávaná v mnoha kopiích (1 instalace = 1 obchodník).

## 1. Problém a cíl

Obchodníci platí za platební terminál fixní + procentní poplatky. U malých plateb poplatek snadno převýší marži. Cílem je nabídnout obsluze možnost vystavit **QR platbu** (okamžitá platba, formát SPAYD / „QR Platba") a na displeji u kasy **vidět v reálném čase, že platba dorazila** — bez terminálu a jeho poplatků.

**Hodnota i hlavní riziko leží v jediné funkci: spolehlivá detekce příchozí platby.** Zbytek (generování QR, zadání částky, zobrazení) je rutina.

## 2. Rozsah MVP

**V rozsahu (MVP):**
- **Android aplikace na tablet** s vestavěným HTTP serverem — celý systém běží lokálně na tabletu.
- První nastavení v aplikaci: vložení **Fio tokenu** a **IBANu**, aktivace licence.
- Zadání částky obsluhou přes **interní web servírovaný tabletem** (PC/mobil na stejné WiFi).
- Vygenerování unikátního VS + SPAYD řetězce + QR kódu.
- Displej na tabletu (otočený k zákazníkovi): QR, částka, stav platby.
- Detekce příchozí platby — **tablet sám polluje Fio API**, párování podle **VS + částka**.
- Stavy platby v reálném čase přes SSE na displej i na zařízení obsluhy.
- Časový limit platby (timeout) a ruční zrušení.
- Jednoduchá historie/přehled transakcí + **export** dat.

**Mimo rozsah MVP (roadmapa):**
- Další banky (KB, ČS, ČSOB…) přes PSD2/agregátora.
- Více kas / více souběžných obsluh u jednoho obchodníka.
- Cloudová záloha / centrální správa instalací / remote push aktualizací.
- Pokladní funkce (sklad, položkové účtenky, slevy).
- Fakturace/účetní integrace, exporty.
- Vrácení peněz (refundace) z aplikace.
- Mobilní nativní appka (MVP jede ve webovém prohlížeči).

## 3. Aktéři a zařízení

- **Obchodník (admin)** — při instalaci vloží Fio token a IBAN, aktivuje licenci, vidí historii.
- **Obsluha** — zadá částku v prohlížeči na PC/mobilu na interní stránce servírované tabletem.
- **Zákazník** — naskenuje QR ve své bankovní aplikaci a zaplatí okamžitou platbou.
- **Tablet (Android app)** — srdce systému: běží na něm server, zobrazuje displej (QR + stav) otočený k zákazníkovi, polluje Fio. Zadávat lze i přímo na tabletu (jedno-zařízení režim).

## 4. Hlavní tok platby (happy path)

1. Obsluha na zadávacím zařízení zadá **částku** (volitelně poznámku/název).
2. Backend vytvoří **platební relaci**: vygeneruje **unikátní VS**, sestaví SPAYD řetězec, stav `PENDING`, nastaví `expires_at` (např. +5 min).
3. Displej zobrazí **QR kód**, částku a stav „Čeká na platbu".
4. Zákazník naskenuje QR a odešle okamžitou platbu.
5. Backend pravidelně polluje Fio API a hledá novou transakci, která **odpovídá VS a částce** aktivní relace.
6. Při shodě → stav `PAID`, čas, párovací ID transakce. Stav se okamžitě pushne na displej i obsluze („Zaplaceno").
7. Po zobrazení potvrzení se relace uzavře; kasa je připravená na další platbu.

## 5. Edge cases (povinné ošetřit v MVP)

| Situace | Chování |
|---|---|
| **Podplatek** (dorazí méně) | Stav `UNDERPAID`, zobrazit rozdíl, neuzavírat jako zaplaceno; obsluha rozhodne (zrušit / čekat na doplatek mimo MVP). |
| **Přeplatek** (dorazí více) | Stav `OVERPAID`, označit jako zaplaceno + upozornit obsluhu na přeplatek. |
| **Timeout** | Po `expires_at` bez platby → stav `EXPIRED`, QR zneplatnit. Pozdní platba po expiraci → viz „nespárováno". |
| **Duplicitní/kolizní VS** | VS musí být unikátní napříč otevřenými relacemi obchodníka; generovat tak, aby nekolidoval s nedávnými. |
| **Nespárovaná platba** | Příchozí platba bez odpovídající aktivní relace → zaznamenat do „nespárované" pro pozdější ruční dohledání. |
| **Více plateb se stejným VS** | Vzít první odpovídající, další označit jako nespárované/duplicitní. |
| **Výpadek sítě / Fio API** | Stav `UNKNOWN` u relace, retry s backoffem; obsluze zobrazit „nelze ověřit", neoznačovat předčasně. |
| **Neplatný/expirovaný Fio token** | Detekovat, upozornit obchodníka, detekci pozastavit. |

## 6. Integrace s Fio API

- **Autentizace:** read-only **token** generovaný obchodníkem v Internetbankingu Fio. Ukládat **šifrovaně** (viz Bezpečnost).
- **Endpointy (REST, JSON):**
  - `GET https://fioapi.fio.cz/v1/rest/last/{token}/transactions.json` — transakce od poslední „zarážky" (server-side bookmark). Vhodné pro inkrementální pollování.
  - `GET .../set-last-id/{token}/{id}/` — nastavení zarážky.
  - `GET .../periods/{token}/{from}/{to}/transactions.json` — fallback dle data.
- **Rate limit:** Fio povoluje **1 dotaz na token za 30 s**. Z toho plyne, že **detekční latence je až ~30 s** — nutno komunikovat v UI („platba se obvykle potvrdí do půl minuty"). Toto je tvrdé omezení Fio API, ne volba designu.
- **Pollovací strategie:** tablet polluje **jen když je otevřená aktivní `PENDING` relace**; mimo platbu se Fia neptá vůbec, ať šetří 30s limit.
- **Párování:** porovnat pole VS a částku (a měnu CZK) z transakce proti otevřeným relacím.

## 7. QR / SPAYD formát

QR kóduje řetězec dle standardu **SPAYD (QR Platba, Česká bankovní asociace)**, např.:

```
SPD*1.0*ACC:CZ6508000000192000145399*AM:450.00*CC:CZK*X-VS:1234567890*MSG:Nazev obchodu
```

- `ACC` — IBAN obchodníka (volitelně +BIC).
- `AM` — částka s tečkou, 2 desetinná místa.
- `CC` — měna (`CZK`).
- `X-VS` — variabilní symbol (náš párovací identifikátor).
- `MSG` — popis (název obchodníka / kasy).

QR se generuje na backendu nebo klientu z tohoto řetězce běžnou QR knihovnou.

## 8. Datový model (návrh, lokální SQLite)

Single-tenant — jedna instalace = jeden obchodník, takže místo tabulky merchantů stačí konfigurace.

- **Config** (klíč-hodnota / jeden řádek): `name`, `iban`, `fio_token` (šifrovaně), `license_key`, stav tokenu.
- **PaymentSession**: `id`, `amount`, `currency`, `vs`, `spayd`, `status` (`PENDING`/`PAID`/`UNDERPAID`/`OVERPAID`/`EXPIRED`/`CANCELLED`/`UNKNOWN`), `created_at`, `expires_at`, `paid_at`, `matched_tx_id`, `note`.
- **BankTransaction** (zrcadlo spárovaných/nespárovaných příchozích): `id`, `fio_tx_id`, `amount`, `vs`, `received_at`, `matched_session_id` (nullable).

## 9. Architektura (on-premise, vše na tabletu)

Veškerá logika běží v **Android aplikaci na tabletu** v prodejně. Tvůrce neprovozuje žádný server.

- **Android app (Kotlin)** s **vestavěným HTTP serverem (Ktor)** běžícím jako **foreground service**:
  - servíruje **interní web** (zadávání obsluhy) ostatním zařízením po WiFi,
  - poskytuje API + **SSE** pro real-time stav,
  - **sama polluje Fio** (odchozí HTTPS) a páruje platby,
  - vykresluje **displej** (QR + stav) — typicky WebView na `localhost`.
- **UI psané jednou ve webu (React/HTML)**, Ktor ho servíruje jak do WebView displeje, tak na PC/mobil obsluhy přes LAN.
- **Úložiště: SQLite** lokálně v aplikaci (relace, transakce, konfigurace).
- **Zařízení obsluhy (PC/mobil)** = pouze prohlížeč mířící na adresu tabletu v LAN. Žádný klient se neptá banky přímo — vše jde přes app na tabletu.

**Síťové připojení k tabletu (nutno vyřešit):** DHCP rezervace IP v routeru, případně mDNS (`http://kasa.local`), a jako spolehlivý fallback **QR/odkaz zobrazený na displeji tabletu**, který obsluha naskenuje mobilem a stránka se otevře.

**TLS:** vnitřní provoz PC↔tablet po **http** na privátní IP (přijatelné pro LAN); citlivé spojení **tablet→Fio je https** odchozí.

## 10. Bezpečnost

- **Fio token** je citlivý (čtení pohybů na účtu) → šifrovat at-rest v úložišti aplikace, nikdy neposílat do prohlížeče obsluhy. **Token data neopouští prodejnu** (výhoda on-premise pro GDPR).
- Spojení **tablet→Fio přes HTTPS**; vnitřní LAN provoz po http na privátní IP.
- **Přístup k interní stránce omezit na LAN** + jednoduchý párovací/PIN mechanismus, ať cizí zařízení na stejné WiFi nemůže zakládat platby.
- Audit příchozích plateb a párování v lokální DB.

## 11. Monetizace (jednorázová licence)

- Jednorázový poplatek za aplikaci/licenci (ne předplatné).
- **On-premise model to dobře podporuje:** tvůrce nemá žádné trvalé provozní náklady (žádný hosting, žádný server), takže jednorázová platba dává ekonomicky smysl — dřívější riziko „jednorázová platba vs. trvalé náklady" tím odpadá.
- **Aktivace licence offline:** vygenerovaný **podepsaný licenční klíč**, který aplikace ověří vestavěným veřejným klíčem. Žádný server tvůrce není potřeba. (Volitelně jednorázová online aktivace proti pirátství.)
- Zbývá vyřešit kanál **distribuce APK a placených aktualizací** (Play Store vs. sideload).

## 12. Otevřené otázky / rizika

- **Fio 30s limit** → detekce až do ~30 s; ověřit, zda je to pro obsluhu/zákazníka akceptovatelné (mělo by být).
- **Okamžité platby:** zákazník musí použít okamžitou platbu, jinak peníze (a tím potvrzení) dorazí později — UI musí říct „použijte okamžitou platbu".
- **Nalezení tabletu na LAN** — DHCP rezervace / mDNS / QR-odkaz na displeji; potřeba spolehlivé řešení pro obsluhu.
- **Aktualizace bez serveru** — distribuce APK, žádný remote push oprav; počítat s tím u supportu.
- **Ztráta/porucha tabletu** — data jen lokálně → zajistit export/zálohu.
- **Tablet jako kiosk** — nabíječka, screen-on, foreground, ať app běží trvale.
- **Generování VS** — délka a unikátnost (max 10 číslic), strategie proti kolizím.

## 13. Roadmapa po MVP

1. Další banky (kde to API umožní; u PSD2 jasně rozlišit „instant" vs. „pomalý" režim kvůli limitu 4×/den u non-present přístupu).
2. Více kas / souběžných obsluh u jedné prodejny.
3. Položkové účtenky, účetní integrace.
4. Volitelná cloudová záloha / centrální správa instalací / remote aktualizace.
5. Refundace, částečné platby/doplatky.
