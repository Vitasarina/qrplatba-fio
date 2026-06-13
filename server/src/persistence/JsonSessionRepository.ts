import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import {
  isOpen,
  sessionFromJSON,
  sessionToJSON,
  type PaymentSession,
  type PaymentSessionJSON,
} from "../domain/session.js";
import type { MerchantConfig } from "../domain/config.js";
import type {
  SessionFilter,
  SessionRepository,
  StoredTransaction,
} from "./types.js";

interface PersistShape {
  sessions: PaymentSessionJSON[];
  transactions: StoredTransaction[];
  config: MerchantConfig | null;
}

/**
 * In-memory repository with simple pure-JS JSON-file persistence so state
 * survives a process restart (AC-11.3). No native deps.
 *
 * Production note: swap this implementation for a SQLite-backed one. The
 * SessionRepository interface is the seam — nothing else changes.
 *
 * Writes are serialized through a single chained promise to avoid interleaved
 * file writes corrupting the JSON. Writes go to a temp file then rename
 * (atomic on POSIX).
 */
export class JsonSessionRepository implements SessionRepository {
  private sessions = new Map<string, PaymentSession>();
  private txs = new Map<string, StoredTransaction>();
  private config: MerchantConfig | null = null;

  private writeChain: Promise<void> = Promise.resolve();
  private dirty = false;

  /** @param filePath path to the JSON file; if null, persistence is disabled (pure in-memory). */
  constructor(private readonly filePath: string | null) {}

  /** Load existing state from disk if present. Safe to call once at startup. */
  async load(): Promise<void> {
    if (!this.filePath) return;
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // first run
      throw err;
    }
    const data = JSON.parse(raw) as PersistShape;
    this.sessions.clear();
    for (const j of data.sessions ?? []) {
      const s = sessionFromJSON(j);
      this.sessions.set(s.id, s);
    }
    this.txs.clear();
    for (const t of data.transactions ?? []) {
      this.txs.set(t.externalId, t);
    }
    this.config = data.config ?? null;
  }

  // ---- sessions ----

  async createSession(session: PaymentSession): Promise<void> {
    this.sessions.set(session.id, session);
    this.persist();
  }

  async getSession(id: string): Promise<PaymentSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async updateSession(session: PaymentSession): Promise<void> {
    this.sessions.set(session.id, session);
    this.persist();
  }

  async listSessions(filter?: SessionFilter): Promise<PaymentSession[]> {
    let list = [...this.sessions.values()];
    if (filter?.status) {
      list = list.filter((s) => s.status === filter.status);
    }
    if (filter?.from) {
      const from = filter.from.getTime();
      list = list.filter((s) => s.createdAt.getTime() >= from);
    }
    if (filter?.to) {
      const to = filter.to.getTime();
      list = list.filter((s) => s.createdAt.getTime() <= to);
    }
    // newest first
    return list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async findOpenByVs(vs: string): Promise<PaymentSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.vs === vs && isOpen(s.status))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async openVsSet(): Promise<Set<string>> {
    const set = new Set<string>();
    for (const s of this.sessions.values()) {
      if (isOpen(s.status)) set.add(s.vs);
    }
    return set;
  }

  // ---- idempotence / transactions ----

  async hasProcessedTx(externalId: string): Promise<boolean> {
    return this.txs.has(externalId);
  }

  async recordTransaction(tx: StoredTransaction): Promise<void> {
    this.txs.set(tx.externalId, tx);
    this.persist();
  }

  async listTransactions(): Promise<StoredTransaction[]> {
    return [...this.txs.values()].sort(
      (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    );
  }

  // ---- config ----

  async getConfig(): Promise<MerchantConfig | null> {
    return this.config;
  }

  async setConfig(config: MerchantConfig): Promise<void> {
    this.config = config;
    this.persist();
  }

  /** Factory reset: wipe config, sessions and transactions (back to first run). */
  async reset(): Promise<void> {
    this.sessions.clear();
    this.txs.clear();
    this.config = null;
    this.persist();
  }

  // ---- persistence plumbing ----

  private snapshot(): PersistShape {
    return {
      sessions: [...this.sessions.values()].map(sessionToJSON),
      transactions: [...this.txs.values()],
      config: this.config,
    };
  }

  /** Schedule a write. Coalesces bursts; serialized via writeChain. */
  private persist(): void {
    if (!this.filePath) return;
    this.dirty = true;
    this.writeChain = this.writeChain.then(() => this.flush()).catch((err) => {
      // Persistence failure must not crash the request path; log and continue.
      // eslint-disable-next-line no-console
      console.error("JsonSessionRepository: persist failed:", err);
    });
  }

  private async flush(): Promise<void> {
    if (!this.filePath || !this.dirty) return;
    this.dirty = false;
    const data = JSON.stringify(this.snapshot(), null, 2);
    const dir = dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, this.filePath);
  }

  /** Await all pending writes — used in tests and graceful shutdown. */
  async flushNow(): Promise<void> {
    await this.writeChain;
    await this.flush();
    await this.writeChain;
  }
}
