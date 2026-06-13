# QR Platba — frontend (web)

Frontend pro MVP platebního systému „QR Platba u kasy" (SPAYD). Vite + React + TypeScript.

## Spuštění

```bash
npm install
npm run dev      # dev server na http://localhost:5173
```

Dev server **proxuje `/api` na backend `http://localhost:8080`** (viz `vite.config.ts`).
**Backend musí běžet** (v `../server`), jinak se UI nepřipojí a zobrazí chybové stavy.

```bash
npm run build    # type-check + produkční build do dist/
npm run preview  # náhled produkčního buildu
```

## Obrazovky

| Cesta | Účel |
|---|---|
| `/operator` | Zadání částky obsluhou + živý stav platby (SSE), zrušení / nová platba. |
| `/display` | Displej pro zákazníka (tablet) — velký QR, částka, stav, výsledek. Bez PINu. |
| `/history` | Historie relací + export CSV. |
| `/setup` | První nastavení: název, IBAN, token banky, licence, PIN. |
| `/simulator` | Vývojový panel — simulované bankovní scénáře proti aktivní platbě. |

## PIN obsluhy

Backend vyžaduje PIN (hlavička `x-pin`) na `/api/sessions*` a `/api/config`.
PIN se nastaví tlačítkem vpravo nahoře nebo v Nastavení a ukládá se do `localStorage`
tohoto prohlížeče. Není to bezpečnostní hranice — skutečné omezení přístupu je na
backendu / v LAN.

## Real-time stav (SSE)

Stav relace se odebírá přes `EventSource` na `/api/sessions/:id/events`.
`EventSource` se automaticky znovupřipojuje při výpadku WiFi; po obnovení spojení
navíc proběhne REST dotaz (`GET /api/sessions/:id`), aby se nezmeškal žádný přechod stavu.

## Displej — výběr aktivní relace

`/display` zobrazí aktivní platbu buď podle `?id=<sessionId>`, nebo (bez parametru)
automaticky najde nejnovější relaci ve stavu `PENDING`/`UNKNOWN` pollováním
`GET /api/sessions`. Mezi platbami ukazuje idle stav s odkazem na zadávací stránku.
