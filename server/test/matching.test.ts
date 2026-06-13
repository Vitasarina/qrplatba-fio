import { describe, it, expect, beforeEach } from "vitest";
import { makeApp, configure } from "./helpers.js";
import type { BuiltApp } from "../src/app.js";
import { money } from "../src/domain/money.js";

async function newSession(app: BuiltApp, amount = "450.00") {
  return app.sessions.createSession({ amount });
}

describe("happy path (AC-5)", () => {
  let app: BuiltApp;
  beforeEach(async () => {
    app = await makeApp();
    await configure(app);
  });

  it("PENDING + exact matching txn -> PAID with time and matchedTxId", async () => {
    const s = await newSession(app, "450.00");
    expect(s.status).toBe("PENDING");

    const [tx] = app.simulator!.scenario("exact", { vs: s.vs, amount: s.amount });
    await app.matching.tick();

    const after = await app.sessions.getSession(s.id);
    expect(after.status).toBe("PAID");
    expect(after.paidAt).toBeInstanceOf(Date);
    expect(after.matchedTxId).toBe(tx!.externalId);
    expect(after.overpaid).toBe(false);
  });

  it("second txn does not change an already PAID session (AC-5.3)", async () => {
    const s = await newSession(app, "100.00");
    app.simulator!.scenario("exact", { vs: s.vs, amount: s.amount });
    await app.matching.tick();
    const paid = await app.sessions.getSession(s.id);
    expect(paid.status).toBe("PAID");
    const firstTxId = paid.matchedTxId;

    // A second deposit with the same VS arrives.
    app.simulator!.enqueue({ amount: s.amount, vs: s.vs });
    await app.matching.tick();

    const still = await app.sessions.getSession(s.id);
    expect(still.status).toBe("PAID");
    expect(still.matchedTxId).toBe(firstTxId);

    // The second txn is recorded as unmatched/duplicate.
    const txs = await app.repo.listTransactions();
    const unmatched = txs.filter((t) => t.matchedSessionId === null);
    expect(unmatched.length).toBe(1);
    expect(unmatched[0]!.unmatchedReason).toBe("duplicate");
  });
});

describe("edge cases (AC-6)", () => {
  let app: BuiltApp;
  beforeEach(async () => {
    app = await makeApp();
    await configure(app);
  });

  it("underpayment -> UNDERPAID, not success (AC-6.1)", async () => {
    const s = await newSession(app, "450.00");
    app.simulator!.scenario("under", { vs: s.vs, amount: s.amount });
    await app.matching.tick();
    const after = await app.sessions.getSession(s.id);
    expect(after.status).toBe("UNDERPAID");
    expect(after.paidAt).toBeNull();
    expect(after.matchedTxId).toBeNull();
  });

  it("overpayment -> PAID/OVERPAID with overpaid flag (AC-6.2)", async () => {
    const s = await newSession(app, "450.00");
    app.simulator!.scenario("over", { vs: s.vs, amount: s.amount });
    await app.matching.tick();
    const after = await app.sessions.getSession(s.id);
    expect(after.status).toBe("OVERPAID");
    expect(after.overpaid).toBe(true);
    expect(after.paidAt).toBeInstanceOf(Date);
    expect(after.matchedTxId).not.toBeNull();
  });

  it("timeout -> EXPIRED (AC-6.3)", async () => {
    const app2 = await makeApp({ ttlMs: 10 });
    await configure(app2);
    const s = await app2.sessions.createSession({ amount: "50.00" });
    await new Promise((r) => setTimeout(r, 30));
    await app2.matching.tick();
    const after = await app2.sessions.getSession(s.id);
    expect(after.status).toBe("EXPIRED");
  });

  it("late payment -> session stays EXPIRED, txn unmatched (AC-6.4)", async () => {
    const app2 = await makeApp({ ttlMs: 10 });
    await configure(app2);
    const s = await app2.sessions.createSession({ amount: "50.00" });
    await new Promise((r) => setTimeout(r, 30));
    await app2.matching.tick(); // expires it
    expect((await app2.sessions.getSession(s.id)).status).toBe("EXPIRED");

    // Payment arrives after expiry.
    app2.simulator!.scenario("late", { vs: s.vs, amount: s.amount });
    await app2.matching.tick();

    const after = await app2.sessions.getSession(s.id);
    expect(after.status).toBe("EXPIRED");
    const txs = await app2.repo.listTransactions();
    expect(txs.length).toBe(1);
    expect(txs[0]!.matchedSessionId).toBeNull();
    expect(txs[0]!.unmatchedReason).toBe("duplicate"); // terminal session exists for VS
  });

  it("manual cancel -> CANCELLED (AC-6.5)", async () => {
    const s = await newSession(app, "50.00");
    const cancelled = await app.sessions.cancelSession(s.id);
    expect(cancelled.status).toBe("CANCELLED");
    // a payment after cancel does not revive it
    app.simulator!.enqueue({ amount: s.amount, vs: s.vs });
    await app.matching.tick();
    expect((await app.sessions.getSession(s.id)).status).toBe("CANCELLED");
  });

  it("duplicate VS -> first matches, second unmatched (AC-6.6)", async () => {
    const s = await newSession(app, "200.00");
    app.simulator!.scenario("duplicate", { vs: s.vs, amount: s.amount });
    await app.matching.tick();

    const after = await app.sessions.getSession(s.id);
    expect(after.status).toBe("PAID");

    const txs = await app.repo.listTransactions();
    expect(txs.length).toBe(2);
    const matched = txs.filter((t) => t.matchedSessionId === s.id);
    const unmatched = txs.filter((t) => t.matchedSessionId === null);
    expect(matched.length).toBe(1);
    expect(unmatched.length).toBe(1);
    expect(unmatched[0]!.unmatchedReason).toBe("duplicate");
  });

  it("unmatched payment (no session) recorded, no session changes (AC-6.7)", async () => {
    const s = await newSession(app, "75.00");
    app.simulator!.enqueue({ amount: "75.00", vs: "9999999999" }); // unknown VS
    await app.matching.tick();
    expect((await app.sessions.getSession(s.id)).status).toBe("PENDING");
    const txs = await app.repo.listTransactions();
    expect(txs.length).toBe(1);
    expect(txs[0]!.matchedSessionId).toBeNull();
    expect(txs[0]!.unmatchedReason).toBe("no-session");
  });

  it("gateway unavailable -> never PAID, marks UNKNOWN, resumes when back (AC-6.8)", async () => {
    const s = await newSession(app, "300.00");
    // Bank goes down with a pending (queued) payment.
    app.simulator!.enqueue({ amount: s.amount, vs: s.vs });
    app.simulator!.setAvailable(false);

    await app.matching.tick();
    let after = await app.sessions.getSession(s.id);
    expect(after.status).toBe("UNKNOWN");
    expect(after.matchedTxId).toBeNull(); // crucially NOT paid

    // Bank recovers.
    app.simulator!.setAvailable(true);
    await app.matching.tick();
    after = await app.sessions.getSession(s.id);
    expect(after.status).toBe("PAID");
  });
});

describe("VS uniqueness (AC-3.5)", () => {
  it("generates distinct VS values for concurrent open sessions", async () => {
    const app = await makeApp();
    await configure(app);
    const vss = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const s = await app.sessions.createSession({ amount: "10.00" });
      expect(s.vs).toMatch(/^[1-9][0-9]{9}$/); // 10 digits, no leading zero
      expect(vss.has(s.vs)).toBe(false);
      vss.add(s.vs);
    }
  });
});

describe("idempotence by externalId", () => {
  it("re-running the same batch does not double-process", async () => {
    const app = await makeApp();
    await configure(app);
    const s = await app.sessions.createSession({ amount: "120.00" });
    app.simulator!.enqueue({ amount: s.amount, vs: s.vs, externalId: "fixed-1" });
    await app.matching.tick();
    expect((await app.sessions.getSession(s.id)).status).toBe("PAID");

    // Same externalId re-enqueued (e.g. bank returns it again).
    app.simulator!.enqueue({ amount: s.amount, vs: s.vs, externalId: "fixed-1" });
    await app.matching.tick();

    const txs = await app.repo.listTransactions();
    expect(txs.length).toBe(1); // not reprocessed
  });

  it("comparison uses decimal equality", async () => {
    const app = await makeApp();
    await configure(app);
    const s = await app.sessions.createSession({ amount: "0.30" });
    // 0.1 + 0.2 in float is 0.30000000000000004; decimal must still match 0.30
    app.simulator!.enqueue({ amount: money("0.1").plus("0.2"), vs: s.vs });
    await app.matching.tick();
    expect((await app.sessions.getSession(s.id)).status).toBe("PAID");
  });
});
