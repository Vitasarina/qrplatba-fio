# QR Platba na iPhonu (přes Scriptable)

Zjednodušená verze appky pro **jeden iPhone**: zadáš částku → ukáže se QR → aplikace
sama hlídá, jestli platba dorazila na Fio účet, a **pípne** s výsledkem. Nepotřebuje App
Store ani vývojářský účet.

> **Co umí a co ne.** Tohle je jednozařízenní „ukaž QR a zkontroluj platbu" nástroj —
> ideální pro pult, kde platíš z jednoho telefonu. **Neumí** trvalý kiosk na pozadí ani
> obsluhu více zařízení (to iOS nedovolí) — na to slouží Android verze.

## Instalace (cca 5 minut)

1. V App Store nainstaluj zdarma appku **Scriptable**.
2. Otevři Scriptable → klikni na **+** (nový skript).
3. Otevři soubor **`QRPlatba.js`** z této složky, **zkopíruj celý jeho obsah** a vlož ho
   do nového skriptu. (Nejjednodušší: pošli si `QRPlatba.js` do iCloud Drive / e-mailem,
   otevři, vyber vše, zkopíruj a vlož.)
4. Nahoře ve skriptu vyplň **NASTAVENÍ**:
   - `tokens` — své **Fio read-only tokeny** (1 až 32), každý v uvozovkách. Token vytvoříš
     ve Fio internetbankingu: *Nastavení → API → nový token* s právem **„Pouze pro čtení"**.
   - `account` — číslo účtu (např. `19-2000145399/0800`) **nebo** rovnou IBAN.
   - `shopName` — název, který se ukáže v příkazu a na obrazovce.
5. Skript pojmenuj (nahoře) a **ulož** (Done).
6. Volitelně: na ploše dlouze podrž ikonu Scriptable → widget, nebo ve Scriptable u skriptu
   *Share → Add to Home Screen* → budeš mít **vlastní ikonu**, co appku spustí jedním ťuknutím.

## Jak se to používá

1. Spustíš skript → zadáš **částku** → *Zobrazit QR*.
2. Ukáže se **QR kód** — zákazník ho naskenuje v bankovní appce a zaplatí.
3. Appka se ptá Fia (rotuje tvoje tokeny, aby dodržela limit **1 dotaz na token za 30 s** —
   víc tokenů = rychlejší kontrola) a čeká na platbu se **správným variabilním symbolem**.
4. Když platba dorazí → **zelené „Zaplaceno" + zvuk**. Když do `timeoutSec` (výchozí 2 min)
   nedorazí → **červené „Platba nedorazila" + zvuk**.

## Bezpečnost

- QR se generuje **přímo v telefonu**, offline — SPAYD (a tím IBAN) se nikam neposílá.
- S bankou mluví jen appka nativně přes HTTPS na `fioapi.fio.cz`. Token je read-only a
  zůstává ve skriptu v telefonu.
- Pro kontrolu se používá koncový bod `/periods` (čte dnešní pohyby), takže se **neposouvá
  „záložka"** — nic se tím pro Android verzi nerozbije, když bys používal obě.

## Poznámky / ladění

- **Zvuk:** výsledek doprovází systémová notifikace se zvukem (povol Scriptable notifikace).
  Tón přímo na obrazovce se přehraje, jen když se během čekání dotkneš displeje (iOS jinak
  blokuje automatické přehrávání) — notifikace zafunguje vždy.
- **Živý odpočet na obrazovce** používá funkci Scriptable, která na některých verzích iOS
  nemusí obrazovku průběžně aktualizovat; QR a výsledek fungují tak jako tak. Kdyby něco
  nešlo, dej vědět — doladíme podle konkrétního iOS.
- Fungování jádra (převod účtu → IBAN, generování QR) je ověřené; samotné Scriptable API
  (WebView, notifikace) šlo otestovat až na tvém iPhonu.
