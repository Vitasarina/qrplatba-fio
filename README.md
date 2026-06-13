# QR Platby u kasy — MVP

Aplikace pro obchodníky: vystavit QR „okamžitou platbu" (SPAYD / QR Platba) a u kasy v reálném čase
vidět, že platba dorazila — náhrada platebního terminálu kvůli vysokým poplatkům u malých plateb.

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
