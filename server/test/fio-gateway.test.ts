import { describe, it, expect } from "vitest";
import { parseFioTransactions, FioGateway, BankUnavailableError } from "../src/gateway/FioGateway.js";
import { ModeGateway } from "../src/gateway/ModeGateway.js";
import { JsonSessionRepository } from "../src/persistence/JsonSessionRepository.js";
import { EventBus } from "../src/service/EventBus.js";
import { MatchingService } from "../src/service/MatchingService.js";
import { SessionService } from "../src/service/SessionService.js";
import { VALID_IBAN } from "./helpers.js";

// Sample mirrors the Android GatewayTest fixture: one incoming (+450.00) and one
// outgoing (-99.00) movement; only the incoming one is kept.
const sampleFio = JSON.stringify({
  accountStatement: {
    info: { accountId: "2000145399", bankId: "0800", currency: "CZK" },
    transactionList: {
      transaction: [
        {
          column0: { value: "2026-06-13+0200", name: "Datum", id: 0 },
          column1: { value: 450.0, name: "Objem", id: 1 },
          column5: { value: "1234567890", name: "VS", id: 5 },
          column14: { value: "CZK", name: "Měna", id: 14 },
          column22: { value: 26000000001, name: "ID pohybu", id: 22 },
        },
        {
          column0: { value: "2026-06-13+0200", name: "Datum", id: 0 },
          column1: { value: -99.0, name: "Objem", id: 1 },
          column5: { value: "9999", name: "VS", id: 5 },
          column14: { value: "CZK", name: "Měna", id: 14 },
          column22: { value: 26000000002, name: "ID pohybu", id: 22 },
        },
      ],
    },
  },
});

describe("FioGateway.parseFioTransactions (pure parser)", () => {
  it("keeps incoming-only movements and maps the columns", () => {
    const txs = parseFioTransactions(sampleFio);
    expect(txs).toHaveLength(1);
    const t = txs[0]!;
    expect(t.externalId).toBe("26000000001");
    expect(t.amount.toFixed(2)).toBe("450.00");
    expect(t.vs).toBe("1234567890");
    expect(t.currency).toBe("CZK");
  });

  it("returns [] for empty / null transaction lists", () => {
    expect(parseFioTransactions(`{"accountStatement":{"transactionList":{"transaction":[]}}}`)).toHaveLength(0);
    expect(parseFioTransactions(`{"accountStatement":{"transactionList":null}}`)).toHaveLength(0);
    expect(parseFioTransactions(`{}`)).toHaveLength(0);
  });

  it("throws on garbage (non-JSON) so the matcher marks UNKNOWN, never PAID", () => {
    expect(() => parseFioTransactions("not json")).toThrow();
  });

  it("tolerates string amounts and comma decimals", () => {
    const body = JSON.stringify({
      accountStatement: {
        transactionList: {
          transaction: [
            {
              column1: { value: "12,50" },
              column22: { value: "abc-1" },
              column14: { value: "CZK" },
            },
          ],
        },
      },
    });
    const txs = parseFioTransactions(body);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.amount.toFixed(2)).toBe("12.50");
  });

  it("the live FioGateway wraps fetch errors as BankUnavailableError", async () => {
    // Point at an unroutable base URL so fetch fails fast.
    const g = new FioGateway({ token: "x", baseUrl: "http://127.0.0.1:1/v1/rest" });
    await expect(g.fetchNewTransactions()).rejects.toBeInstanceOf(BankUnavailableError);
  });
});

describe("ModeGateway: token-driven simulation vs Fio", () => {
  async function harness() {
    const repo = new JsonSessionRepository(null);
    await repo.load();
    const events = new EventBus();
    const gateway = new ModeGateway(repo);
    const sessions = new SessionService(repo, events, 5 * 60 * 1000);
    const matching = new MatchingService(repo, gateway, events, 100000);
    return { repo, gateway, sessions, matching };
  }

  it("no token: auto-confirms every open session to PAID via sim-<id> txns", async () => {
    const { repo, gateway, sessions, matching } = await harness();
    await repo.setConfig({ name: "Shop", iban: VALID_IBAN, token: "", licenseKey: "", logoUrl: "", pin: "" });
    const s = await sessions.createSession({ amount: "150.00" });

    // The gateway emits exactly one exact-amount tx for the open session.
    const emitted = await gateway.fetchNewTransactions();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.externalId).toBe(`sim-${s.id}`);

    await matching.tick();
    expect((await sessions.getSession(s.id)).status).toBe("PAID");

    // Idempotent: a second poll emits the same externalId but does not double-pay.
    await matching.tick();
    expect((await sessions.getSession(s.id)).status).toBe("PAID");
  });

  it("token present: delegates to the injected Fio factory", async () => {
    const repo = new JsonSessionRepository(null);
    await repo.load();
    await repo.setConfig({ name: "Shop", iban: VALID_IBAN, token: "tok123", licenseKey: "", logoUrl: "", pin: "" });
    let called = 0;
    const gateway = new ModeGateway(repo, () => ({
      async fetchNewTransactions() {
        called += 1;
        return parseFioTransactions(sampleFio);
      },
      async isAvailable() {
        return true;
      },
    }));
    const txs = await gateway.fetchNewTransactions();
    expect(called).toBe(1);
    expect(txs).toHaveLength(1);
    expect(txs[0]!.externalId).toBe("26000000001");
  });
});
