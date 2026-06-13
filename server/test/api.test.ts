import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, configure, pinHeaders, VALID_IBAN, TEST_PIN } from "./helpers.js";
import type { BuiltApp } from "../src/app.js";

describe("HTTP API contract", () => {
  let app: BuiltApp;
  beforeEach(async () => {
    app = await makeApp();
  });
  afterEach(async () => {
    await app.fastify.close();
  });

  it("PIN guard: operator endpoints reject without PIN, accept with it", async () => {
    const noPin = await app.fastify.inject({ method: "GET", url: "/api/config" });
    expect(noPin.statusCode).toBe(401);

    const withPin = await app.fastify.inject({
      method: "GET",
      url: "/api/config",
      headers: pinHeaders(),
    });
    expect(withPin.statusCode).toBe(200);
  });

  it("POST /api/config validates IBAN and masks the token on read", async () => {
    const bad = await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "X", iban: "bad", token: "t", licenseKey: "l" },
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "Shop", iban: VALID_IBAN, token: "secret-token-abcdef", licenseKey: "LIC" },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.tokenMasked.endsWith("cdef")).toBe(true);
    expect(body.tokenMasked).not.toContain("secret");
    expect(body.configured).toBe(true);
    expect(body.licensed).toBe(true);
  });

  it("blocks session creation when not configured (AC-1.4)", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: pinHeaders(),
      payload: { amount: "100.00" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_configured");
  });

  it("blocks session creation when configured but not licensed (AC-1.5)", async () => {
    await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "Shop", iban: VALID_IBAN, token: "tok", licenseKey: "" },
    });
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: pinHeaders(),
      payload: { amount: "100.00" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_licensed");
  });

  it("POST /api/sessions returns the documented contract", async () => {
    await configure(app);
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: pinHeaders(),
      payload: { amount: "450.00", note: "kava" },
    });
    expect(res.statusCode).toBe(201);
    const b = res.json();
    expect(b).toHaveProperty("id");
    expect(b.vs).toMatch(/^[1-9][0-9]{9}$/);
    expect(b.spayd).toContain("SPD*1.0*ACC:");
    expect(b.spayd).toContain("X-VS:" + b.vs);
    expect(b.qrUrl).toBe(`/api/qr/${b.id}.png`);
    expect(b.amount).toBe("450.00");
    expect(b.status).toBe("PENDING");
    expect(b).toHaveProperty("expiresAt");
  });

  it("rejects invalid amounts (AC-3.2)", async () => {
    await configure(app);
    for (const amount of [0, -5, "1.234", "abc"]) {
      const res = await app.fastify.inject({
        method: "POST",
        url: "/api/sessions",
        headers: pinHeaders(),
        payload: { amount },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("GET /api/sessions/:id returns full state; 404 for unknown", async () => {
    await configure(app);
    const created = (
      await app.fastify.inject({
        method: "POST",
        url: "/api/sessions",
        headers: pinHeaders(),
        payload: { amount: "10.00" },
      })
    ).json();

    const ok = await app.fastify.inject({ method: "GET", url: `/api/sessions/${created.id}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe(created.id);

    const missing = await app.fastify.inject({ method: "GET", url: "/api/sessions/nope" });
    expect(missing.statusCode).toBe(404);
  });

  it("GET /api/qr/:id.png returns a PNG", async () => {
    await configure(app);
    const created = (
      await app.fastify.inject({
        method: "POST",
        url: "/api/sessions",
        headers: pinHeaders(),
        payload: { amount: "10.00" },
      })
    ).json();
    const res = await app.fastify.inject({ method: "GET", url: `/api/qr/${created.id}.png` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    // PNG magic number
    expect(res.rawPayload.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("POST /api/sessions/:id/cancel -> CANCELLED", async () => {
    await configure(app);
    const created = (
      await app.fastify.inject({
        method: "POST",
        url: "/api/sessions",
        headers: pinHeaders(),
        payload: { amount: "10.00" },
      })
    ).json();
    const res = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${created.id}/cancel`,
      headers: pinHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("CANCELLED");
  });

  it("GET /api/sessions lists history and filters by status", async () => {
    await configure(app);
    await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: pinHeaders(),
      payload: { amount: "10.00" },
    });
    const all = await app.fastify.inject({
      method: "GET",
      url: "/api/sessions",
      headers: pinHeaders(),
    });
    expect(all.json().length).toBe(1);
    const paid = await app.fastify.inject({
      method: "GET",
      url: "/api/sessions?status=PAID",
      headers: pinHeaders(),
    });
    expect(paid.json().length).toBe(0);
  });

  it("GET /api/sessions/export.csv returns CSV", async () => {
    await configure(app);
    await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: pinHeaders(),
      payload: { amount: "10.00", note: "with,comma" },
    });
    const res = await app.fastify.inject({
      method: "GET",
      url: "/api/sessions/export.csv",
      headers: pinHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const lines = res.body.trim().split("\r\n");
    expect(lines[0]).toContain("id,vs,amount");
    expect(lines.length).toBe(2);
    expect(res.body).toContain('"with,comma"'); // quoted because of comma
  });

  it("sim control endpoints drive a payment to PAID", async () => {
    await configure(app);
    const created = (
      await app.fastify.inject({
        method: "POST",
        url: "/api/sessions",
        headers: pinHeaders(),
        payload: { amount: "99.00" },
      })
    ).json();

    const sim = await app.fastify.inject({
      method: "POST",
      url: "/api/sim/scenario/exact",
    });
    expect(sim.statusCode).toBe(200);
    expect(sim.json().target).toBe(created.id);

    await app.matching.tick();
    const after = await app.fastify.inject({ method: "GET", url: `/api/sessions/${created.id}` });
    expect(after.json().status).toBe("PAID");
  });

  it("cookie PIN also authorizes", async () => {
    const res = await app.fastify.inject({
      method: "GET",
      url: "/api/config",
      headers: { cookie: `pin=${TEST_PIN}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("SSE live status (AC-7.1)", () => {
  it("emits an initial event and pushes on state change", async () => {
    const app = await makeApp();
    await app.fastify.listen({ port: 0, host: "127.0.0.1" });
    try {
      await configure(app);
      const s = await app.sessions.createSession({ amount: "55.00" });
      const address = app.fastify.server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${s.id}/events`);
      expect(res.ok).toBe(true);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // initial event
      const first = await readEvent(reader, decoder);
      expect(first).toContain("event: session");
      expect(first).toContain('"status":"PENDING"');

      // trigger a change
      app.simulator!.scenario("exact", { vs: s.vs, amount: s.amount });
      await app.matching.tick();

      const second = await readEvent(reader, decoder);
      expect(second).toContain('"status":"PAID"');
      await reader.cancel();
    } finally {
      await app.fastify.close();
    }
  });
});

async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
): Promise<string> {
  let buf = "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.includes("\n\n")) {
      const idx = buf.indexOf("\n\n");
      const chunk = buf.slice(0, idx);
      if (chunk.trim().startsWith(":")) {
        // heartbeat — skip
        buf = buf.slice(idx + 2);
        continue;
      }
      return chunk;
    }
  }
  throw new Error("no SSE event received before timeout");
}
