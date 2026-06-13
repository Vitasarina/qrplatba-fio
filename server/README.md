# QR Platby — backend (simulator phase)

Runnable Node/TypeScript reference implementation of the QR Platba (SPAYD)
payments MVP. A merchant issues a Czech "QR Platba", a customer pays by instant
transfer, and the backend detects the incoming payment and flips the session to
**Paid** in real time — replacing a card terminal.

This is the **simulator** build: there is no real bank. A `SimulatorGateway`
stands in for Fio behind a `BankGateway` interface. Switching to the real
`FioGateway` later does not change matching logic, session states, or the API.

The production target is an on-premise Android app (Kotlin/Ktor + SQLite). Here,
state lives in memory with simple JSON-file persistence (pure JS, no native deps)
so it survives a restart. Production swaps the `SessionRepository` for SQLite.

## Requirements

- Node 22, npm 10. No Java/Android, no native-compiled dependencies.

## Run

```bash
cd server
npm install
npm run dev      # tsx watch, server on http://0.0.0.0:8080
# or
npm run build && npm start
npm test         # vitest
```

## Environment variables

| Var               | Default            | Meaning                                                  |
|-------------------|--------------------|----------------------------------------------------------|
| `PORT`            | `8080`             | HTTP port                                                |
| `HOST`            | `0.0.0.0`          | Bind address                                             |
| `PIN`             | `1234`             | Operator PIN for protected endpoints                     |
| `POLL_INTERVAL_MS`| `3000`             | Bank poll interval                                       |
| `SESSION_TTL_MS`  | `300000` (5 min)   | Payment session timeout                                  |
| `DATA_FILE`       | `data/state.json`  | JSON persistence file (`""`/unset-empty = in-memory)     |
| `SIM_ENABLED`     | `true`             | Expose `/api/sim/*` control endpoints                    |

## Auth

Operator endpoints (`POST /api/sessions`, `GET /api/sessions`, history, CSV,
config, cancel) require the PIN via the `x-pin` header or a `pin` cookie.
Left open: `GET /api/qr/:id.png`, `GET /api/sessions/:id/events` (SSE),
`GET /api/sessions/:id`, `/display`. Default PIN is `1234`.

## API

| Method | Path                          | Auth | Purpose                                              |
|--------|-------------------------------|------|------------------------------------------------------|
| POST   | `/api/sessions`               | PIN  | Create payment `{amount, note?}` → session DTO       |
| GET    | `/api/sessions/:id`           | —    | Full session state                                   |
| GET    | `/api/sessions/:id/events`    | —    | SSE stream of session changes (initial + on change)  |
| POST   | `/api/sessions/:id/cancel`    | PIN  | Cancel → `CANCELLED`                                  |
| GET    | `/api/sessions`               | PIN  | History; filters `status`, `from`, `to`              |
| GET    | `/api/sessions/export.csv`    | PIN  | CSV export                                            |
| GET    | `/api/qr/:id.png`             | —    | QR PNG of the session's SPAYD string                 |
| GET    | `/api/config`                 | PIN  | Config (token masked)                                |
| POST   | `/api/config`                 | PIN  | Set `name, iban, token, licenseKey` (IBAN validated) |
| POST   | `/api/sim/pay`                | —*   | `{vs?, amount, scenario?}` enqueue a payment         |
| POST   | `/api/sim/scenario/:type`     | —*   | `exact\|under\|over\|late\|duplicate\|unavailable`   |
| POST   | `/api/sim/unavailable`        | —*   | `{available?}` toggle bank availability              |
| GET    | `/display`                    | —    | Minimal display placeholder                          |
| GET    | `/api/health`                 | —    | `{ ok: true }`                                        |

\* Sim endpoints are dev-only; gate them off in production with `SIM_ENABLED=false`.

## Session state machine

```
PENDING ──exact/over──► PAID / OVERPAID(+overpaid flag)
   │  ──under──► UNDERPAID (stays open until expiry/cancel)
   │  ──timeout──► EXPIRED
   │  ──operator──► CANCELLED
   └──bank down──► UNKNOWN ──(bank back)──► PENDING ──► …
```

Hard rule (AC-6.8): on gateway unavailability/uncertainty the engine **never**
transitions to PAID. Open PENDING sessions go to UNKNOWN ("cannot verify") and
return to PENDING when the bank is reachable again.

## Matching

The poller calls `gateway.fetchNewTransactions()` on an interval. For each txn:
match the oldest open session with the same VS + CZK; `amount == required` →
PAID, `> required` → OVERPAID(+flag), `< required` → UNDERPAID (session stays
open). No open session → recorded as **unmatched** (`no-session` or `duplicate`
if a terminal session already exists for that VS). Processing is **idempotent by
`externalId`** and the processed set is persisted, so a txn is never reprocessed
across restarts.

## Project structure

```
src/
  domain/      money (decimal.js), iban (mod-97), spayd, session, config
  gateway/     BankGateway, SimulatorGateway, FioGateway (stub)
  persistence/ SessionRepository interface, JsonSessionRepository (in-mem + JSON)
  service/     SessionService, MatchingService (poller+match), EventBus (SSE), vs
  api/         qr (PNG), csv
  app.ts       Fastify wiring + all routes
  index.ts     entrypoint
test/          vitest: domain, matching/edge cases, persistence/restart, HTTP+SSE
```
