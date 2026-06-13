import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeApp, configure } from "./helpers.js";

const created: string[] = [];
function tmpFile(): string {
  const f = join(tmpdir(), `qr-state-${randomUUID()}.json`);
  created.push(f);
  return f;
}

afterEach(async () => {
  for (const f of created.splice(0)) {
    await fs.rm(f, { force: true });
  }
});

describe("JSON-file persistence + restart (AC-11.3, idempotence across restart)", () => {
  it("reloads sessions and processed-tx set after a simulated restart", async () => {
    const file = tmpFile();

    // ---- first process ----
    const app1 = await makeApp({ dataFile: file });
    await configure(app1);
    const s = await app1.sessions.createSession({ amount: "250.00" });
    app1.simulator!.enqueue({ amount: s.amount, vs: s.vs, externalId: "tx-restart-1" });
    await app1.matching.tick();
    expect((await app1.sessions.getSession(s.id)).status).toBe("PAID");
    await app1.repo.flushNow();

    // ---- "restart": brand new app reading the same file ----
    const app2 = await makeApp({ dataFile: file });
    const reloaded = await app2.sessions.getSession(s.id);
    expect(reloaded.status).toBe("PAID");
    expect(reloaded.amount.toFixed(2)).toBe("250.00"); // money survived as decimal
    expect(reloaded.matchedTxId).toBe("tx-restart-1");

    // The processed tx is remembered: re-enqueuing the same externalId is a no-op.
    app2.simulator!.enqueue({ amount: s.amount, vs: s.vs, externalId: "tx-restart-1" });
    await app2.matching.tick();
    const txs = await app2.repo.listTransactions();
    expect(txs.filter((t) => t.externalId === "tx-restart-1").length).toBe(1);
  });

  it("a PENDING session reloaded past expiry is resolved to EXPIRED", async () => {
    const file = tmpFile();
    const app1 = await makeApp({ dataFile: file, ttlMs: 5 });
    await configure(app1);
    const s = await app1.sessions.createSession({ amount: "10.00" });
    await app1.repo.flushNow();
    await new Promise((r) => setTimeout(r, 20));

    const app2 = await makeApp({ dataFile: file, ttlMs: 5 });
    expect((await app2.sessions.getSession(s.id)).status).toBe("PENDING");
    await app2.matching.expireStale();
    expect((await app2.sessions.getSession(s.id)).status).toBe("EXPIRED");
  });
});
