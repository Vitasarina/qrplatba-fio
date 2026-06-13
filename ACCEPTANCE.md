# Akceptační kritéria — MVP (se simulací banky)

> Stav: návrh k odsouhlasení · Datum: 2026-06-13 · Navazuje na `MVP-spec.md`
> MVP se vyvíjí proti **simulátoru banky**; reálné Fio se připojí až po odladění funkčnosti.

## 0. Princip simulace banky

- **AC-0.1** Komunikace s bankou je schovaná za jedním rozhraním (`BankGateway` / detektor plateb). Existují dvě implementace: **Simulátor** a **Fio** — jsou zaměnitelné konfigurací.
- **AC-0.2** Přepnutí ze Simulátoru na Fio **nemění** logiku párování, stavy relace ani UI. Mění se jen zdroj transakcí.
- **AC-0.3** Veškerá akceptační kritéria níže jsou ověřitelná přes Simulátor bez reálné platby.

## 1. První nastavení

- **AC-1.1** Při prvním spuštění aplikace lze zadat **název obchodu, IBAN** a **token banky** (u simulátoru libovolný/placeholder).
- **AC-1.2** IBAN se validuje (formát + kontrolní číslice); neplatný IBAN nelze uložit.
- **AC-1.3** Token se ukládá **šifrovaně** a nikdy se nezobrazuje v plné podobě v UI obsluhy.
- **AC-1.4** Bez vyplněné konfigurace nelze založit platbu (UI to jasně sdělí).
- **AC-1.5** Aplikaci lze aktivovat **licenčním klíčem**; bez platné licence je funkce vystavení platby zablokovaná.

## 2. Připojení obsluhy po síti

- **AC-2.1** Tablet po startu naslouchá na známém portu a servíruje interní stránku po LAN.
- **AC-2.2** Na displeji tabletu je zobrazena **adresa (a QR odkaz)**, kterou obsluha na PC/mobilu otevře a dostane se na zadávací stránku.
- **AC-2.3** Zadávací stránka je dostupná z jiného zařízení na stejné WiFi přes prohlížeč.
- **AC-2.4** Přístup na zadávací stránku vyžaduje **jednoduché ověření** (PIN/párovací kód) — cizí zařízení na téže WiFi nemůže zakládat platby.

## 3. Vytvoření platby

- **AC-3.1** Obsluha zadá **částku** (kladná, 2 desetinná místa, měna CZK) a volitelně poznámku.
- **AC-3.2** Nulovou/zápornou/nečíselnou částku nelze odeslat (validace s chybovou hláškou).
- **AC-3.3** Po odeslání vznikne relace ve stavu `PENDING` s **unikátním VS** a vygenerovaným **SPAYD** řetězcem.
- **AC-3.4** Vygenerovaný **QR kód** odpovídá standardu SPAYD a obsahuje IBAN, částku, CZK a daný VS (ověřitelné dekódováním QR).
- **AC-3.5** VS je unikátní vůči všem ostatním otevřeným relacím.

## 4. Displej u zákazníka

- **AC-4.1** Po vytvoření platby displej do **≤ 2 s** zobrazí QR kód, částku a stav „Čeká na platbu".
- **AC-4.2** Displej zobrazuje výzvu **„použijte okamžitou platbu"**.
- **AC-4.3** Při změně stavu (zaplaceno/expirováno/zrušeno) se displej aktualizuje do **≤ 2 s** bez ručního refreshe.
- **AC-4.4** Po úspěšné platbě displej zobrazí potvrzení a po nastavené době se vrátí do klidového stavu.

## 5. Detekce a párování platby — happy path

- **AC-5.1 (Given)** existuje relace `PENDING` s VS=X a částkou=A · **(When)** simulátor vygeneruje příchozí platbu s VS=X, částka=A, CZK · **(Then)** relace přejde do `PAID`, uloží se čas a ID transakce.
- **AC-5.2** Stav `PAID` se propíše na displej i obsluze do **≤ 2 s** od okamžiku, kdy banka transakci ohlásí.
- **AC-5.3** Po `PAID` je relace uzavřená a další příchozí transakce ji už nezmění.

## 6. Edge cases

- **AC-6.1 Podplatek** — příchozí částka < požadovaná: stav `UNDERPAID`, zobrazí se chybějící částka, platba se **neoznačí jako úspěšná**; obsluha může relaci zrušit.
- **AC-6.2 Přeplatek** — příchozí částka > požadovaná: stav `OVERPAID`, **označí se jako zaplaceno** + upozornění obsluze na přeplatek.
- **AC-6.3 Timeout** — do `expires_at` nedorazí platba: stav `EXPIRED`, QR se zneplatní, displej to oznámí.
- **AC-6.4 Pozdní platba** — platba dorazí po `EXPIRED`: relace zůstane `EXPIRED`, transakce se zařadí mezi **nespárované**.
- **AC-6.5 Ruční zrušení** — obsluha zruší `PENDING` relaci: stav `CANCELLED`, displej se vrátí do klidu.
- **AC-6.6 Duplicitní VS na vstupu** — dvě příchozí transakce se shodným VS: spáruje se **první**, druhá → nespárované/duplicitní.
- **AC-6.7 Nespárovaná platba** — příchozí platba bez odpovídající otevřené relace: zaznamená se jako **nespárovaná** pro pozdější dohledání, žádná relace se nezmění.
- **AC-6.8 Výpadek banky** — gateway nedostupná: relace zůstane `PENDING`/`UNKNOWN`, **nikdy se chybně neoznačí jako zaplaceno**; po obnovení detekce pokračuje. Obsluze se zobrazí „nelze ověřit".

## 7. Real-time stav

- **AC-7.1** Zadávací zařízení i displej dostávají změny stavu **push** (SSE), bez pollování z prohlížeče.
- **AC-7.2** Po ztrátě a obnovení WiFi se spojení **automaticky obnoví** a dorovná aktuální stav.

## 8. Historie a export

- **AC-8.1** Obchodník vidí **seznam relací** se stavem, částkou, VS, časem a (ne)spárováním.
- **AC-8.2** Data lze **exportovat** (např. CSV) pro případ ztráty/výměny tabletu.

## 9. Simulátor banky (vývojový/testovací nástroj)

- **AC-9.1** Simulátor umožní ručně vyvolat příchozí platbu se zadaným **VS, částkou a měnou**.
- **AC-9.2** Simulátor umí scénáře: přesná platba, podplatek, přeplatek, žádná platba (timeout), pozdní platba, duplicita, chyba/výpadek.
- **AC-9.3** Simulátor respektuje rozhraní `BankGateway` tak, aby šel nahradit Fiem beze změny zbytku appky.
- **AC-9.4** Simulátor umí napodobit i **latenci a 30s limit** Fia, aby se chování dalo otestovat ještě před reálným nasazením.

## 10. Bezpečnost

- **AC-10.1** Token banky neopustí tablet a není čitelný z prohlížeče obsluhy.
- **AC-10.2** Interní rozhraní je dostupné jen v LAN; není vystavené do internetu.
- **AC-10.3** Spojení k reálné bance (po přepnutí z Simulátoru) jde přes HTTPS.

## 11. Nefunkční požadavky

- **AC-11.1** Při reálném Fiu je detekční latence **≤ ~30 s** (daná limitem Fia); UI to uživateli komunikuje.
- **AC-11.2** Aplikace běží na tabletu trvale v popředí (foreground), přežije zhasnutí obrazovky/uspání dle kiosk nastavení.
- **AC-11.3** Po restartu tabletu/aplikace se nedokončené `PENDING` relace načtou z lokální DB a korektně dořeší (dořešení/expirace).
- **AC-11.4** Aplikace zvládne běžný provoz jedné kasy (sekvenční platby) bez ztráty nebo záměny relací.

## 12. Definition of Done (MVP) a mimo rozsah

**MVP je hotové, když:** všechna AC v §1–§11 procházejí proti Simulátoru, a přepnutí na Fio (AC-0.2) nevyžaduje změnu logiky párování ani UI.

**Mimo rozsah tohoto MVP:** reálná produkční integrace více bank, doplatky u podplatku, refundace, více kas/obsluh, cloudová záloha, položkové účtenky.
