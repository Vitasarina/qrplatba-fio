import { isOpen } from "../domain/session.js";
import type { BankGateway, BankTransaction } from "../gateway/BankGateway.js";
import type { SessionRepository, StoredTransaction } from "../persistence/types.js";
import { EventBus } from "./EventBus.js";

/**
 * Matching engine + poller. Pulls transactions from the BankGateway and reconciles
 * them against open sessions. The hard rule (AC-6.8): on gateway unavailability or
 * uncertainty NEVER transition to PAID — keep PENDING (or mark UNKNOWN) and resume
 * once the bank is reachable again.
 */
export class MatchingService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Tracks whether the last poll succeeded — drives UNKNOWN recovery. */
  private lastPollOk = true;

  constructor(
    private readonly repo: SessionRepository,
    private readonly gateway: BankGateway,
    private readonly events: EventBus,
    private readonly pollIntervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    // setInterval guarded by `running` so overlapping ticks can't double-process.
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    // Don't keep the event loop alive solely for polling.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll cycle: expire stale sessions, then fetch + match. Safe to call manually (tests). */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.expireStale(now);
      await this.poll(now);
    } finally {
      this.running = false;
    }
  }

  /** PENDING/UNDERPAID/UNKNOWN past expiresAt with no successful match -> EXPIRED. */
  async expireStale(now: Date = new Date()): Promise<void> {
    const all = await this.repo.listSessions();
    for (const s of all) {
      if (isOpen(s.status) && s.expiresAt.getTime() <= now.getTime()) {
        s.status = "EXPIRED";
        await this.repo.updateSession(s);
        this.events.publishSessionChange(s);
      }
    }
  }

  /** Fetch a batch and reconcile. Gateway failures set UNKNOWN on open sessions. */
  async poll(now: Date = new Date()): Promise<void> {
    let batch: BankTransaction[];
    try {
      batch = await this.gateway.fetchNewTransactions();
    } catch {
      // Bank unreachable: mark open PENDING sessions UNKNOWN ("cannot verify").
      this.lastPollOk = false;
      await this.markOpenUnknown();
      return;
    }

    // Recovered: any UNKNOWN sessions go back to PENDING before matching.
    if (!this.lastPollOk) {
      await this.recoverUnknown();
    }
    this.lastPollOk = true;

    for (const tx of batch) {
      await this.processTransaction(tx, now);
    }
  }

  /**
   * Idempotent by externalId: a transaction processed once is never reprocessed,
   * even across restarts (the processed set is persisted).
   */
  private async processTransaction(tx: BankTransaction, now: Date): Promise<void> {
    if (await this.repo.hasProcessedTx(tx.externalId)) return;

    const amountStr = tx.amount.toFixed(2);
    const baseRecord: StoredTransaction = {
      externalId: tx.externalId,
      amount: amountStr,
      currency: tx.currency,
      vs: tx.vs,
      receivedAt: tx.receivedAt.toISOString(),
      matchedSessionId: null,
      unmatchedReason: null,
    };

    // Currency must be CZK; otherwise unmatched.
    if (tx.currency !== "CZK") {
      await this.repo.recordTransaction({ ...baseRecord, unmatchedReason: "currency" });
      return;
    }

    if (!tx.vs) {
      await this.repo.recordTransaction({ ...baseRecord, unmatchedReason: "no-session" });
      return;
    }

    const open = await this.repo.findOpenByVs(tx.vs);
    if (open.length === 0) {
      // No open session for this VS — record unmatched (covers late payments after
      // EXPIRED, and payments whose session was already PAID -> duplicate).
      const reason = (await this.anyTerminalForVs(tx.vs)) ? "duplicate" : "no-session";
      await this.repo.recordTransaction({ ...baseRecord, unmatchedReason: reason });
      return;
    }

    // Match the oldest open session for this VS.
    const session = open[0]!;
    const cmp = tx.amount.comparedTo(session.amount);

    if (cmp < 0) {
      // Underpayment: do NOT mark success; session stays open until expiry/cancel.
      session.status = "UNDERPAID";
      session.receivedAmount = tx.amount;
      await this.repo.updateSession(session);
      this.events.publishSessionChange(session);
      // The transaction is recorded as matched to this session for audit, but the
      // session is not closed. A later exact/over txn would still be unmatched
      // because this same externalId won't reprocess — that's fine; an underpayment
      // is a distinct deposit.
      await this.repo.recordTransaction({ ...baseRecord, matchedSessionId: session.id });
      return;
    }

    // Exact or overpayment -> PAID (overpaid flagged).
    session.status = cmp > 0 ? "OVERPAID" : "PAID";
    session.overpaid = cmp > 0;
    session.receivedAmount = tx.amount;
    session.paidAt = now;
    session.matchedTxId = tx.externalId;
    await this.repo.updateSession(session);
    this.events.publishSessionChange(session);
    await this.repo.recordTransaction({ ...baseRecord, matchedSessionId: session.id });
  }

  private async anyTerminalForVs(vs: string): Promise<boolean> {
    const all = await this.repo.listSessions();
    return all.some((s) => s.vs === vs && !isOpen(s.status));
  }

  private async markOpenUnknown(): Promise<void> {
    const all = await this.repo.listSessions();
    for (const s of all) {
      if (s.status === "PENDING") {
        s.status = "UNKNOWN";
        await this.repo.updateSession(s);
        this.events.publishSessionChange(s);
      }
    }
  }

  private async recoverUnknown(): Promise<void> {
    const all = await this.repo.listSessions();
    for (const s of all) {
      if (s.status === "UNKNOWN") {
        s.status = "PENDING";
        await this.repo.updateSession(s);
        this.events.publishSessionChange(s);
      }
    }
  }
}
