# QR Platby u kasy — MVP

Aplikace pro obchodníky: vystavit QR „okamžitou platbu" (SPAYD / QR Platba) a u kasy v reálném čase
vidět, že platba dorazila — náhrada platebního terminálu kvůli vysokým poplatkům u malých plateb.

---

## Jak se to ovládá

Server (backend + web) běží buď **v telefonu** (Android appka) nebo **na PC** (`.exe`). Obsluhovat
se dá **dvěma způsoby** — přímo na telefonu, nebo z jiného zařízení přes webovou stránku.

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

### B) Obsluha přes webovou stránku (jiné zařízení na stejné Wi-Fi)

Server poslouchá na `0.0.0.0:8080`, takže z PC nebo jiného mobilu na stejné síti otevřeš:

| Stránka | URL | K čemu |
|---|---|---|
| **Obsluha** | `http://<IP>:8080/operator` | Zadávání částky (chráněno heslem) |
| **Nastavení** | `http://<IP>:8080/setup` | Účet/IBAN, tokeny, heslo, logo, otočení, reset |
| **Dnešní platby** | `http://<IP>:8080/today` | Příchozí platby za dnešek (ověření bez banky) |
| **Displej** | `http://<IP>:8080/display` | Obrazovka pro zákazníka (např. mobil u PC verze) |
| **Správa** | `http://<IP>:8080/admin` | Odkazy + obnova hesla |

`<IP>` = adresa zařízení se serverem (Android: ukáže ji **Správa**; PC: `ipconfig` → Wi-Fi IPv4).
Všechny stránky kromě **displeje** jsou chráněné **heslem**.

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

## Stack — poznámka k běhu

Produkční cíl je **on-premise Android aplikace** (Kotlin + vestavěný Ktor server) běžící na tabletu v prodejně.

Tato runnable verze ve fázi **simulace banky** je postavena v **Node.js + TypeScript** (server) a **React** (UI),
protože je plně spustitelná a testovatelná bez Android zařízení. React UI se přenáší 1:1 do finální verze;
serverová logika je zároveň spustitelnou specifikací pro pozdější port do Ktoru.

## Struktura

- `server/` — Node/TypeScript: Fastify API + SSE, `BankGateway` (Simulátor + stub Fio), párování plateb (referenční implementace)
- `web/` — React/Vite: obrazovky nastavení, zadání obsluhy, displej, historie + ovládací panel simulátoru
- `android/` — **produkční nativní aplikace** (Kotlin + vestavěný Ktor server, foreground service, WebView). Doménová logika portována ze `server/`, React build ze `web/` zabalen v assets.

## PC varianta (.exe)

`server/` zároveň slouží jako **desktopová verze**: jeden spustitelný soubor, který na PC běží jako backend a servíruje web (operátor/nastavení lokálně, displej z mobilu přes LAN). Build:

```bash
cd server
npm install
npm run build:exe   # vytvoří dist-pc/qr-payments-win.exe (+ linux)
```

Po spuštění `.exe` vypíše URL: operátor na `http://localhost:8080`, displej pro mobil na `http://<IP-PC>:8080/display`. Data se ukládají vedle .exe (`qr-data/`). Režim určuje token Fio (prázdný = simulace).

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

## Spuštění (dev)

```bash
# 1) backend
cd server && npm install && npm run dev      # http://localhost:8080

# 2) frontend
cd web && npm install && npm run dev          # http://localhost:5173 (proxy na :8080)
```
