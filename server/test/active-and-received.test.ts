import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, configure } from "./helpers.js";
import type { BuiltApp } from "../src/app.js";

// Covers the two integration fixes added after the parallel build:
//  - public GET /api/sessions/active (display reads it without a PIN)
//  - receivedAmount on the session DTO (shortfall/overpay shown in the UI)

describe("GET /api/sessions/active (public, for the display)", () => {
  let app: BuiltApp;
  beforeEach(async () => {
    app = await makeApp();
    await configure(app);
  });
  afterEach(async () => {
    await app.fastify.close();
  });

  it("returns null when there is no active session — without a PIN", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/api/sessions/active" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it("returns the open session without requiring a PIN", async () => {
    const s = await app.sessions.createSession({ amount: "50.00" });
    const res = await app.fastify.inject({ method: "GET", url: "/api/sessions/active" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(s.id);
    expect(body.status).toBe("PENDING");
  });

  it("excludes terminal sessions and returns the still-open one", async () => {
    // First session gets paid (terminal) ...
    const paid = await app.sessions.createSession({ amount: "30.00" });
    app.simulator!.scenario("exact", { vs: paid.vs, amount: paid.amount });
    await app.matching.tick();
    expect((await app.sessions.getSession(paid.id)).status).toBe("PAID");

    // ... a fresh PENDING session must be the active one.
    const open = await app.sessions.createSession({ amount: "40.00" });
    const res = await app.fastify.inject({ method: "GET", url: "/api/sessions/active" });
    expect(res.json().id).toBe(open.id);

    // Once it is cancelled (terminal), active goes back to null.
    await app.sessions.cancelSession(open.id);
    const after = await app.fastify.inject({ method: "GET", url: "/api/sessions/active" });
    expect(after.json()).toBeNull();
  });
});

describe("receivedAmount on the session DTO", () => {
  let app: BuiltApp;
  beforeEach(async () => {
    app = await makeApp();
    await configure(app);
  });
  afterEach(async () => {
    await app.fastify.close();
  });

  async function dto(id: string) {
    const res = await app.fastify.inject({ method: "GET", url: `/api/sessions/${id}` });
    return res.json();
  }

  it("is null while PENDING", async () => {
    const s = await app.sessions.createSession({ amount: "50.00" });
    expect((await dto(s.id)).receivedAmount).toBeNull();
  });

  it("equals the deposited amount on UNDERPAID", async () => {
    const s = await app.sessions.createSession({ amount: "50.00" });
    const [tx] = app.simulator!.scenario("under", { vs: s.vs, amount: s.amount });
    await app.matching.tick();
    const body = await dto(s.id);
    expect(body.status).toBe("UNDERPAID");
    expect(body.receivedAmount).toBe(tx!.amount.toFixed(2));
  });

  it("equals the deposited amount on exact PAID and on OVERPAID", async () => {
    const exact = await app.sessions.createSession({ amount: "30.00" });
    const [txExact] = app.simulator!.scenario("exact", { vs: exact.vs, amount: exact.amount });
    await app.matching.tick();
    const exactBody = await dto(exact.id);
    expect(exactBody.status).toBe("PAID");
    expect(exactBody.receivedAmount).toBe(txExact!.amount.toFixed(2));

    const over = await app.sessions.createSession({ amount: "30.00" });
    const [txOver] = app.simulator!.scenario("over", { vs: over.vs, amount: over.amount });
    await app.matching.tick();
    const overBody = await dto(over.id);
    expect(overBody.status).toBe("OVERPAID");
    expect(overBody.receivedAmount).toBe(txOver!.amount.toFixed(2));
  });
});
