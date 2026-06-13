import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

// A throwaway "built web" directory so the test does not depend on `npm run build`.
function makeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qr-web-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>SPA</title><div id=root></div>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log('app')");
  writeFileSync(join(dir, "favicon.svg"), "<svg></svg>");
  return dir;
}

describe("static web UI + SPA fallback", () => {
  let app: BuiltApp;
  let webDir: string;

  beforeEach(async () => {
    webDir = makeWebDir();
    const config = loadConfig({ PIN: "1234", DATA_FILE: "", WEB_DIR: webDir });
    config.dataFile = null;
    config.webDir = webDir;
    app = await buildApp({ config, autoStartPoller: false });
  });
  afterEach(async () => {
    await app.fastify.close();
    rmSync(webDir, { recursive: true, force: true });
  });

  it("serves index.html at /", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("SPA");
  });

  it("serves a real nested asset with the right content-type", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/javascript");
    expect(res.body).toContain("console.log");
  });

  it("falls back to index.html for a client-side route (/display)", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/display" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("SPA");
  });

  it("returns 404 (not the SPA shell) for a missing real asset", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/assets/missing.js" });
    expect(res.statusCode).toBe(404);
  });

  it("never lets the SPA fallback swallow unknown /api routes", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });
});
