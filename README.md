# QR Platby u kasy — MVP

Aplikace pro obchodníky: vystavit QR „okamžitou platbu" (SPAYD / QR Platba) a u kasy v reálném čase
vidět, že platba dorazila — náhrada platebního terminálu kvůli vysokým poplatkům u malých plateb.

---

## Jak se to ovládá

Server (backend + web) běží **v telefonu/tabletu** (Android appka). Obsluhovat se dá **dvěma
způsoby** — přímo na zařízení, nebo (jen během servisního režimu) z jiného zařízení přes webovou
stránku.

### A) Obsluha přímo na telefonu (Android, dvoustranný režim)

Telefon leží naplocho na pultě mezi obsluhou a zákazníkem (čelem proti sobě).

1. **Klid** = spořič (logo + nápis „QR platba").
2. **Dvojklik kamkoliv** na displej → vyjede **vlastní numerická klávesnice** (`1–9`, `0`, `,`, `C`,
   `⌫`, `Enter`). Systémová klávesnice telefonu se **nezobrazí**.
3. Naťukáš částku → **Enter** → zobrazí se **QR kód na tmavém pozadí** (+ částka a stav).
4. Zákazník naskenuje a zaplatí → **„Zaplaceno"** → po ~10 s zpět na spořič.
5. **Dvojklik na QR** = zrušit a zpět na spořič; nový dvojklik = nová platba.

**Otočení 180°:** klávesnice je orientovaná k **obsluze** (0°), QR + stav + spořič jsou otočené
k **zákazníkovi** naproti (180°). Telefonem se fyzicky neotáčí. Směr lze prohodit přepínačem
**Nastavení → „Otočit displej o 180°"** (podle toho, na které straně pultu stojíš).

**Skryté ovládání:** **5× rychle ťuknout do pravého horního rohu** displeje → **Správa** (admin):
odkazy na nastavení/obsluhu a **obnova zapomenutého hesla** (jen přímo na zařízení).

### B) Obsluha přes webovou stránku (jiné zařízení na stejné Wi-Fi) — jen v servisním režimu

Z bezpečnostních důvodů server **nikoho na LAN neobsluhuje**, dokud se přímo na displeji nezapne
**servisní režim** (5× ťuknout do pravého horního rohu → **Správa** → *Servisní režim → Zapnout*,
na omezenou dobu; sám se zavře). Mimo něj běží obsluha jen přímo na zařízení (loopback), takže po
síti žádná citlivá data (heslo, tokeny, platby) netečou. Když je servisní režim zapnutý, ukáže
Správa adresu a QR na tyto stránky:

| Stránka | URL | K čemu |
|---|---|---|
| **Obsluha** | `http://<IP>:8080/operator` | Zadávání částky (chráněno heslem) |
| **Nastavení** | `http://<IP>:8080/setup` | Účet/IBAN, tokeny, heslo, logo, režim, reset |
| **Dnešní platby** | `http://<IP>:8080/today` | Příchozí platby za dnešek (ověření bez banky) |
| **Správa** | `http://<IP>:8080/admin` | Servisní režim + odkazy + obnova hesla |

`<IP>` = adresa zařízení se serverem (ukáže ji **Správa**). Všechny stránky kromě **displeje**
jsou chráněné **heslem**.

### Provozní režim (Kasa / Papírové QR)

Při prvním spuštění (a kdykoli v Nastavení) se volí **provozní režim**:

- **Kasa** — obsluha zadá částku, na displeji se zobrazí QR, platba se ověří automaticky. Před
  zobrazením QR appka ověří spojení s bankou reálným dotazem tokenem; když banka není dostupná,
  QR nevystaví.
- **Papírové QR** — QR je vytištěné na papíře. Obsluha klikne „Čekat na platbu" a appka hlídá
  následující příchozí platbu (volitelně přesně na zadanou částku) do ~2 min, s tlačítkem
  „Dnešní platby" (jméno plátce, částka, čas). Výsledek doprovází zvuk (pozitivní/negativní).

### Heslo

Po instalaci se **musí vytvořit heslo** pro vstup do Nastavení — a to jen **přímo na zařízení**
(ne vzdáleně přes Wi-Fi, aby ho nikdo nepřevzal). Pak je heslo **vždy vyžadováno**. Zapomenuté heslo
se obnoví přes **Správu** (5× roh) → „Obnovit heslo".

### Tokeny Fio (režim + rychlost ověřování)

Příchozí platby se čtou přes **Fio API tokeny** (read-only). Počet tokenů určuje režim i rychlost:

- **0 tokenů → zkušební režim:** platby se potvrdí samy, do banky se nevolá (na vyzkoušení).
- **1–32 tokenů → ostrý režim:** appka reálně čte příchozí platby z účtu a páruje je podle
  **VS + částky**.
- **Token získáš** ve Fio internetbankingu: *Nastavení → API → vytvořit token* s oprávněním
  **„Pouze pro čtení"**. Token zůstává uložený **v zařízení**, nikam neodchází.
- **Rychlost:** Fio dovolí **1 dotaz na token za 30 s**. Proto:
  - **1 token** → ptáme se každých **30 s**.
  - **více tokenů** → první dotaz **10 s** po zobrazení QR, pak každých **30 s ÷ počet tokenů**
    (tokeny se střídají round-robin). Např. 3 tokeny → každých 10 s, 6 tokenů → každých 5 s.
  - Tlačítko **„Ověřit platbu"** se zeptá **okamžitě**.
- Jeden účet Fio umožňuje až **32 tokenů**.

> Pozn.: Fio u transakce posílá jen **datum** (ne čas), takže „Dnešní platby" ukazují **čas, kdy
> platbu zachytila appka** (okamžik detekce).

---

## Dokumenty

- `MVP-spec.md` — specifikace MVP (on-premise model, Fio, jednorázová licence)
- `ACCEPTANCE.md` — akceptační kritéria
- `IMPLEMENTATION-PLAN.md` — implementační plán (rozhraní, API, obrazovky, milníky)

## Stack

Produktem je **on-premise Android aplikace** (Kotlin + vestavěný Ktor server, foreground service,
WebView) běžící na tabletu/telefonu v prodejně. React UI (`web/`) je zabalené do APK a servírované
Ktorem.

> **Poznámka k PC/Node verzi:** dřívější desktopová `.exe` varianta (Node/TypeScript backend v
> `server/`) je **zrušená a nedistribuuje se**. Její backend zaostal za sdíleným frontendem (chybí
> mu heslo, provozní režimy, servisní režim atd.) a byl by nefunkční i nebezpečný. `server/`
> zůstává v repu jen jako historická referenční implementace doménové logiky — **nestaví se ani
> nenasazuje**.

## Struktura

- `android/` — **produkční nativní aplikace** (Kotlin + vestavěný Ktor server, foreground service, WebView). React build ze `web/` zabalen v assets.
- `web/` — React/Vite: obrazovky nastavení, zadání obsluhy, displej, papírový režim, dnešní platby, správa.
- `server/` — Node/TypeScript referenční implementace doménové logiky (**zrušená PC verze**, nestaví se).

## Build Android APK

Toolchain (JDK 17, Android SDK, Gradle) je v tomto prostředí nainstalovaný. Build:

```bash
cd android
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ANDROID_HOME=/home/agent/android-sdk \
  ./gradlew assembleDebug --no-daemon
# výstup: app/build/outputs/apk/debug/app-debug.apk
# unit testy doménové logiky:
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 ANDROID_HOME=/home/agent/android-sdk \
  ./gradlew testDebugUnitTest --no-daemon
```

Po změně web UI ve `web/` je potřeba znovu zkopírovat build do `android/app/src/main/assets/web/`
(`npm run build` v `web/` → kopie `dist/*`).

## Vývoj web UI

Web UI se vyvíjí ve `web/` a nasazuje do Android appky přes build + kopii do assets:

```bash
cd web && npm install && npm run build
cp -r dist/* ../android/app/src/main/assets/web/
# pak přestavět APK (viz výše)
```
