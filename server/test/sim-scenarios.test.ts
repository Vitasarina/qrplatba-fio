import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, configure } from "./helpers.js";
import type { BuiltApp } from "../src/app.js";

// Covers behaviors that previously had dedicated /api/sim/* HTTP routes (now
// removed). The underlying service/gateway capabilities still exist and are
// exercised directly here: wrong-VS deposits don't reconcile, an abandoned
// session expires, the bank can be marked unavailable, and a late payment
// (after expiry) must not resurrect a session.

describe("scenario: wrongvs", () => {
  let app: BuiltApp;
  beforeEach(async () => {
    app = await makeApp();
    await configure(app);
  });
  afterEach(async () => {
    await app.fastify.close();
  });

  it("a payment with a non-matching VS leaves the session open (PENDING)", async () => {
    const s = await app.sessions.createSession({ amount: "50.00" });
    const [tx] = app.simulator!.scenario("wrongvs", { vs: s.vs, amount: s.amount });
    expect(tx!.vs).not.toBe(s.vs);
    await app.matching.tick();
    const after = await app.sessions.getSession(s.id);
    expect(after.status).toBe("PENDING");
    expect(after.receivedAmount).toBeNull();
  });
});

describe("scenario: abandon (customer did not pay)", () => {
  let app: BuiltApp;
  beforeEach(async () => {
    app = await makeApp();
    await configure(app);
  });
  afterEach(async () => {
    await app.fastify.close();
  });

  it("expireSession forces an open session to EXPIRED", async () => {
    const s = await app.sessions.createSession({ amount: "50.00" });
    const out = await app.sessions.expireSession(s.id);
    expect(out.status).toBe("EXPIRED");
    expect((await app.sessions.getSession(s.id)).status).toBe("EXPIRED");
  });

  it("an EXPIRED session cannot be expired again", async () => {
    const s = await app.sessions.createSession({ amount: "50.00" });
    await app.sessions.expireSession(s.id);
    await expect(app.sessions.expireSession(s.id)).rejects.toThrow();
  });
});

describe("scenario: bank unavailable -> UNKNOWN, then recovery", () => {
  let app: BuiltApp;
  beforeEach(async () => {
    app = await makeApp();
    await configure(app);
  });
  afterEach(async () => {
    await app.fastify.close();
  });

  it("an unavailable bank never marks PAID; open sessions go UNKNOWN and recover", async () => {
    const s = await app.sessions.createSession({ amount: "40.00" });
    app.simulator!.setAvailable(false);
    await app.matching.tick();
    expect((await app.sessions.getSession(s.id)).status).toBe("UNKNOWN");

    // Bank recovers and the exact payment is present -> back to PENDING then PAID.
    app.simulator!.setAvailable(true);
    app.simulator!.scenario("exact", { vs: s.vs, amount: "40.00" });
    await app.matching.tick();
    expect((await app.sessions.getSession(s.id)).status).toBe("PAID");
  });
});

describe("scenario: late (payment arrives after expiry)", () => {
  let app: BuiltApp;
  beforeEach(async () => {
    app = await makeApp();
    await configure(app);
  });
  afterEach(async () => {
    await app.fastify.close();
  });

  it("expires the session first, then the late payment does NOT mark it paid", async () => {
    const s = await app.sessions.createSession({ amount: "25.00" });
    // Customer abandons: force the session EXPIRED before any deposit lands.
    await app.sessions.expireSession(s.id);
    expect((await app.sessions.getSession(s.id)).status).toBe("EXPIRED");
    // The late deposit is then processed and must NOT resurrect the session.
    app.simulator!.enqueue({ amount: "25.00", vs: s.vs });
    await app.matching.tick();
    expect((await app.sessions.getSession(s.id)).status).toBe("EXPIRED");
  });
});
