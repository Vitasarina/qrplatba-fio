import { describe, it, expect, afterEach } from "vitest";
import { buildApp, type BuiltApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const PIN = "1234";
function pinHeaders(): Record<string, string> {
  return { "x-pin": PIN };
}

/**
 * Build an app wired with the REAL default ModeGateway (no injected simulator),
 * so token-driven simulation auto-confirm runs end-to-end over HTTP.
 */
async function makeRealApp(): Promise<BuiltApp> {
  const config = loadConfig({
    PIN,
    DATA_FILE: "",
    WEB_DIR: "", // skip static serving in this test
    POLL_INTERVAL_MS: "100000",
    SESSION_TTL_MS: String(5 * 60 * 1000),
  });
  config.dataFile = null;
  config.webDir = null;
  return buildApp({ config, autoStartPoller: false });
}

describe("PC desktop features over HTTP", () => {
  let app: BuiltApp;
  afterEach(async () => {
    if (app) await app.fastify.close();
  });

  it("configures with a Czech account number -> stored as IBAN, no token -> simulace", async () => {
    app = await makeRealApp();
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "Boldgym", iban: "19-2000145399/0800" }, // no token
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.iban).toBe("CZ6508000000192000145399");
    expect(body.mode).toBe("simulace");
    expect(body.configured).toBe(true);
    expect(body.licensed).toBe(true);
    expect(body.hasPin).toBe(false);
  });

  it("empty token -> sim auto-confirm: create + /check -> PAID", async () => {
    app = await makeRealApp();
    await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "Boldgym", iban: "19-2000145399/0800" },
    });
    const created = (
      await app.fastify.inject({
        method: "POST",
        url: "/api/sessions",
        headers: pinHeaders(),
        payload: { amount: "199.00", note: "musli" },
      })
    ).json();
    // SPAYD message: note-first, lowercased, hyphen-joined with the company name.
    expect(created.spayd).toContain("MSG:musli-boldgym");

    const checked = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${created.id}/check`,
      headers: pinHeaders(),
    });
    expect(checked.statusCode).toBe(200);
    expect(checked.json().status).toBe("PAID");
  });

  it("/api/transactions/today excludes simulated (sim-*) payments", async () => {
    app = await makeRealApp();
    await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "Shop", iban: "2400123456/2010" },
    });
    const created = (
      await app.fastify.inject({
        method: "POST",
        url: "/api/sessions",
        headers: pinHeaders(),
        payload: { amount: "10.00" },
      })
    ).json();
    await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${created.id}/check`,
      headers: pinHeaders(),
    });
    // The session is PAID via a sim- transaction, which must be hidden from "today".
    const today = await app.fastify.inject({
      method: "GET",
      url: "/api/transactions/today",
      headers: pinHeaders(),
    });
    expect(today.statusCode).toBe(200);
    const txs = today.json() as Array<{ externalId: string }>;
    expect(txs.every((t) => !t.externalId.startsWith("sim-"))).toBe(true);
    expect(txs).toHaveLength(0);
  });

  it("keep-token rule: a masked token re-POST keeps the real token", async () => {
    app = await makeRealApp();
    await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "Shop", iban: "2400123456/2010", token: "real-secret-token" },
    });
    const dto1 = (
      await app.fastify.inject({ method: "GET", url: "/api/config", headers: pinHeaders() })
    ).json();
    expect(dto1.mode).toBe("fio");
    // Re-POST with the MASKED token (contains '*') -> token preserved, still fio.
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "Shop", iban: "2400123456/2010", token: dto1.tokenMasked },
    });
    expect(res.json().mode).toBe("fio");
    expect(res.json().tokenMasked).toBe(dto1.tokenMasked);
    // Explicit empty string clears it -> simulace.
    const cleared = await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "Shop", iban: "2400123456/2010", token: "" },
    });
    expect(cleared.json().mode).toBe("simulace");
  });

  it("PIN can be set, then config/reset wipes everything back to first run", async () => {
    app = await makeRealApp();
    await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "Shop", iban: "2400123456/2010", pin: "9876" },
    });
    // Old default PIN no longer authorizes; the new one does.
    const oldPin = await app.fastify.inject({ method: "GET", url: "/api/auth", headers: { "x-pin": "1234" } });
    expect(oldPin.statusCode).toBe(401);
    const newPin = await app.fastify.inject({ method: "GET", url: "/api/auth", headers: { "x-pin": "9876" } });
    expect(newPin.statusCode).toBe(200);

    // Factory reset (with the current PIN) -> config gone, default PIN restored.
    const reset = await app.fastify.inject({
      method: "POST",
      url: "/api/config/reset",
      headers: { "x-pin": "9876" },
    });
    expect(reset.statusCode).toBe(200);
    const cfg = (
      await app.fastify.inject({ method: "GET", url: "/api/config", headers: { "x-pin": "1234" } })
    ).json();
    expect(cfg.configured).toBe(false);
    expect(cfg.name).toBe("");
  });

  it("PIN reset is loopback-gated and restores the default PIN", async () => {
    app = await makeRealApp();
    await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "Shop", iban: "2400123456/2010", pin: "5555" },
    });
    // Simulate a non-loopback origin -> 403.
    const remote = await app.fastify.inject({
      method: "POST",
      url: "/api/pin/reset",
      remoteAddress: "192.168.1.50",
    });
    expect(remote.statusCode).toBe(403);

    // Loopback origin -> allowed, PIN reset to default.
    const local = await app.fastify.inject({
      method: "POST",
      url: "/api/pin/reset",
      remoteAddress: "127.0.0.1",
    });
    expect(local.statusCode).toBe(200);
    const auth = await app.fastify.inject({ method: "GET", url: "/api/auth", headers: { "x-pin": "1234" } });
    expect(auth.statusCode).toBe(200);
  });

  it("GET /api/net-info is public and returns ip/port/baseUrl", async () => {
    app = await makeRealApp();
    const res = await app.fastify.inject({ method: "GET", url: "/api/net-info" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.ip).toBe("string");
    expect(body.baseUrl).toBe(`http://${body.ip}:${body.port}`);
  });

  it("GET /api/qrcode renders a PNG for arbitrary data (public); 400 without data", async () => {
    app = await makeRealApp();
    const ok = await app.fastify.inject({ method: "GET", url: "/api/qrcode?data=hello" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("image/png");
    expect(ok.rawPayload.length).toBeGreaterThan(100);
    const bad = await app.fastify.inject({ method: "GET", url: "/api/qrcode" });
    expect(bad.statusCode).toBe(400);
  });

  it("old /api/sim/* routes are gone (404)", async () => {
    app = await makeRealApp();
    const res = await app.fastify.inject({ method: "GET", url: "/api/sim/state" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});
