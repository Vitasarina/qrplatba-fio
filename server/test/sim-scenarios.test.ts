import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, configure, pinHeaders } from "./helpers.js";
import type { BuiltApp } from "../src/app.js";

// Covers the scenarios added on top of the original set: a payment with a wrong
// VS (does not reconcile) and "customer did not pay" (abandon -> EXPIRED).

describe("simulator scenario: wrongvs", () => {
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

describe("simulator scenario: abandon (customer did not pay)", () => {
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

  it("POST /api/sim/scenario/abandon expires the active session", async () => {
    const s = await app.sessions.createSession({ amount: "70.00" });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/sim/scenario/abandon",
      headers: pinHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().target).toBe(s.id);
    expect((await app.sessions.getSession(s.id)).status).toBe("EXPIRED");
  });

  it("POST /api/sim/scenario/abandon returns 409 when nothing is active", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/sim/scenario/abandon",
      headers: pinHeaders(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_active_session");
  });

  it("an EXPIRED session cannot be expired again", async () => {
    const s = await app.sessions.createSession({ amount: "50.00" });
    await app.sessions.expireSession(s.id);
    await expect(app.sessions.expireSession(s.id)).rejects.toThrow();
  });

  it("GET /api/sim/state reflects bank availability and it can be restored", async () => {
    expect((await app.fastify.inject({ method: "GET", url: "/api/sim/state" })).json().available).toBe(true);
    // The "unavailable" scenario takes the bank down with no auto-recovery...
    await app.fastify.inject({ method: "POST", url: "/api/sim/scenario/unavailable", headers: pinHeaders() });
    expect((await app.fastify.inject({ method: "GET", url: "/api/sim/state" })).json().available).toBe(false);
    // ...and the restore toggle brings it back.
    await app.fastify.inject({
      method: "POST",
      url: "/api/sim/unavailable",
      headers: pinHeaders(),
      payload: { available: true },
    });
    expect((await app.fastify.inject({ method: "GET", url: "/api/sim/state" })).json().available).toBe(true);
  });
});

describe("simulator scenario: late (payment arrives after expiry)", () => {
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
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/sim/scenario/late",
      headers: pinHeaders(),
    });
    expect(res.statusCode).toBe(200);
    // Session is already EXPIRED right after the call (before the poll runs).
    expect((await app.sessions.getSession(s.id)).status).toBe("EXPIRED");
    // The late deposit is then processed and must NOT resurrect the session.
    await app.matching.tick();
    expect((await app.sessions.getSession(s.id)).status).toBe("EXPIRED");
  });
});
