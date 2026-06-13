import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeApp, configure, pinHeaders, VALID_IBAN } from "./helpers.js";
import type { BuiltApp } from "../src/app.js";

// Covers the logo / display-config feature used by the idle screensaver.

describe("display config + logo", () => {
  let app: BuiltApp;
  beforeEach(async () => {
    app = await makeApp();
    await configure(app);
  });
  afterEach(async () => {
    await app.fastify.close();
  });

  it("a saved logoUrl is reflected in the config DTO", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: {
        name: "Shop",
        iban: VALID_IBAN,
        token: "secret-token-abcdef",
        licenseKey: "LIC",
        logoUrl: "https://example.com/logo.png",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().logoUrl).toBe("https://example.com/logo.png");
  });

  it("GET /api/display-config returns name + logoUrl WITHOUT a PIN and no secrets", async () => {
    await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: {
        name: "Kavárna",
        iban: VALID_IBAN,
        token: "secret-token-abcdef",
        licenseKey: "LIC",
        logoUrl: "https://example.com/logo.png",
      },
    });
    const res = await app.fastify.inject({ method: "GET", url: "/api/display-config" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ name: "Kavárna", logoUrl: "https://example.com/logo.png", mode: "fio" });
    // No token / license / iban leaked to the public endpoint.
    expect(Object.keys(body).sort()).toEqual(["logoUrl", "mode", "name"]);
  });

  it("rejects a logoUrl that is not an http(s) URL", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: {
        name: "Shop",
        iban: VALID_IBAN,
        token: "secret-token-abcdef",
        licenseKey: "LIC",
        logoUrl: "not-a-url",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("bad_request");
  });

  it("treats a missing logoUrl as empty (optional field)", async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/config",
      headers: pinHeaders(),
      payload: { name: "Shop", iban: VALID_IBAN, token: "secret-token-abcdef", licenseKey: "LIC" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().logoUrl).toBe("");
  });
});
